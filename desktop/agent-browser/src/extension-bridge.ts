/**
 * ExtensionBridge — WebSocket server that bridges the daemon to a Chrome extension.
 *
 * The daemon forwards commands to the extension via WebSocket, and the extension
 * executes them using Chrome extension APIs (chrome.debugger, chrome.tabs, etc.).
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getSocketDir, getSession } from './daemon.js';
import type { Command } from './types.js';

interface PendingCommand {
  resolve: (response: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private port: number;
  private token: string;
  private pending: Map<string, PendingCommand> = new Map();
  private connected = false;
  private commandTimeout: number;
  private lastHealthCheckSuccess: number = 0;
  private static HEALTH_CHECK_TTL = 5000; // Skip health check if one succeeded within 5s

  constructor(port: number = 9224, token?: string, commandTimeout: number = 60000) {
    this.port = port;
    this.token = token ?? crypto.randomUUID();
    this.commandTimeout = commandTimeout;
  }

  /**
   * Start the WebSocket server and write discovery files.
   */
  async start(): Promise<void> {
    const socketDir = getSocketDir();
    const session = getSession();

    // Write token file for the extension to authenticate
    const tokenFile = path.join(socketDir, `${session}.ext-token`);
    fs.writeFileSync(tokenFile, this.token);

    // Write port file for discovery
    const portFile = path.join(socketDir, `${session}.ext-port`);
    fs.writeFileSync(portFile, this.port.toString());

    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.port,
        host: '127.0.0.1', // Localhost only for security
        verifyClient: (info: {
          origin: string;
          secure: boolean;
          req: import('http').IncomingMessage;
        }) => {
          // Allow Chrome extension origins (chrome-extension://*) and no-origin clients
          const origin = info.origin;
          if (!origin) return true; // No origin = non-browser client
          if (origin.startsWith('chrome-extension://')) return true;
          console.log(`[ExtensionBridge] Rejected connection from origin: ${origin}`);
          return false;
        },
      });

      this.wss.on('connection', (ws) => {
        this.handleConnection(ws);
      });

      this.wss.on('error', (error) => {
        console.error('[ExtensionBridge] Server error:', error);
        reject(error);
      });

      this.wss.on('listening', () => {
        console.log(`[ExtensionBridge] Listening on 127.0.0.1:${this.port}`);
        console.log(`[ExtensionBridge] Token: ${this.token}`);
        resolve();
      });
    });
  }

  /**
   * Stop the WebSocket server and clean up.
   */
  async stop(): Promise<void> {
    // Reject all pending commands
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Extension bridge shutting down'));
    }
    this.pending.clear();

    if (this.ws) {
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.connected = false;

    // Clean up discovery files
    const socketDir = getSocketDir();
    const session = getSession();
    const tokenFile = path.join(socketDir, `${session}.ext-token`);
    const portFile = path.join(socketDir, `${session}.ext-port`);
    try {
      fs.unlinkSync(tokenFile);
    } catch {}
    try {
      fs.unlinkSync(portFile);
    } catch {}
  }

  /**
   * Check if the extension is connected.
   */
  isLaunched(): boolean {
    return this.connected;
  }

  /**
   * Verify the extension service worker is alive by sending a command-level
   * health check (uses the same command routing as regular commands).
   */
  private async verifyConnection(): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    const hcId = `_hc_${Date.now()}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(hcId);
        console.log('[ExtensionBridge] Health check timeout — service worker may be dead');
        resolve(false);
      }, 3000);

      this.pending.set(hcId, {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(false);
        },
        timer,
      });

      // Send as a regular command — the extension's HANDLERS map will route it
      this.ws!.send(
        JSON.stringify({
          type: 'command',
          action: 'healthcheck',
          id: hcId,
        })
      );
    });
  }

  /**
   * Send a command to the extension and wait for the response.
   */
  async executeCommand(command: Command): Promise<any> {
    if (!this.connected || !this.ws) {
      throw new Error(
        'Extension not connected. Install the Agent Browser Bridge extension and connect it.'
      );
    }

    // Skip health check if we had a successful one recently (within TTL)
    const timeSinceLastCheck = Date.now() - this.lastHealthCheckSuccess;
    let isAlive = timeSinceLastCheck < ExtensionBridge.HEALTH_CHECK_TTL;

    if (!isAlive) {
      isAlive = await this.verifyConnection();
      if (isAlive) {
        this.lastHealthCheckSuccess = Date.now();
      }
    }

    if (!isAlive) {
      console.log('[ExtensionBridge] Connection dead, dropping it and waiting for reconnect...');
      if (this.ws) {
        this.ws.terminate();
        this.ws = null;
      }
      this.connected = false;
      this.lastHealthCheckSuccess = 0;

      // Wait up to 10 seconds for the extension to reconnect
      // (the keepalive alarm or content script will wake the service worker)
      const start = Date.now();
      while (Date.now() - start < 10000) {
        if (this.connected && this.ws) {
          // Re-verify the new connection
          isAlive = await this.verifyConnection();
          if (isAlive) {
            this.lastHealthCheckSuccess = Date.now();
            console.log('[ExtensionBridge] Extension reconnected successfully');
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!this.connected || !this.ws) {
        throw new Error(
          'Extension connection is dead (service worker terminated). The extension will auto-reconnect shortly — try again.'
        );
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        console.log(`[ExtensionBridge] Command '${command.action}' timed out`);
        reject(new Error(`Command '${command.action}' timed out after ${this.commandTimeout}ms`));
      }, this.commandTimeout);

      this.pending.set(command.id, { resolve, reject, timer });

      this.ws!.send(
        JSON.stringify({
          type: 'command',
          ...command,
        })
      );
    });
  }

  private handleConnection(ws: WebSocket): void {
    if (this.ws) {
      // Check if existing connection is still alive
      if (this.ws.readyState === WebSocket.OPEN) {
        // Try pinging the existing connection to verify it's truly alive
        try {
          this.ws.ping();
          // Connection is alive, reject the new one with code 1000 so it doesn't auto-reconnect
          ws.close(1000, 'Already connected');
          return;
        } catch {
          // Ping failed — connection is dead, replace it
        }
      }
      // Existing connection is dead — clean up and accept the new one
      console.log('[ExtensionBridge] Replacing dead connection');
      this.ws = null;
      this.connected = false;
    }

    let authenticated = false;

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error('[ExtensionBridge] Invalid JSON received');
        return;
      }

      // Handle authentication
      if (msg.type === 'hello') {
        if (msg.token === this.token) {
          authenticated = true;
          this.ws = ws;
          this.connected = true;

          ws.send(
            JSON.stringify({
              type: 'welcome',
              session: getSession(),
            })
          );

          console.log('[ExtensionBridge] Extension connected and authenticated');
        } else {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
          ws.close(4001, 'Invalid token');
        }
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'auth_error', error: 'Not authenticated' }));
        ws.close(4001, 'Not authenticated');
        return;
      }

      // Handle ping/pong keepalive
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Handle command responses
      if (msg.type === 'response' && msg.id) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          // Successful response means connection is alive
          this.lastHealthCheckSuccess = Date.now();
          // Return the response as-is (it already has success/error fields)
          pending.resolve(msg);
        }
        return;
      }
    });

    ws.on('close', () => {
      if (this.ws === ws) {
        console.log('[ExtensionBridge] Extension disconnected');
        this.ws = null;
        this.connected = false;
        this.lastHealthCheckSuccess = 0;

        // Reject all pending commands
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Extension disconnected'));
        }
        this.pending.clear();
      }
    });

    ws.on('error', (err) => {
      console.error('[ExtensionBridge] WebSocket error:', err);
    });

    // Give the extension 10 seconds to authenticate
    setTimeout(() => {
      if (!authenticated) {
        console.log('[ExtensionBridge] Authentication timeout');
        ws.close(4002, 'Authentication timeout');
      }
    }, 10000);
  }

  /**
   * Get the auth token (for display in CLI output).
   */
  getToken(): string {
    return this.token;
  }

  /**
   * Get the port number.
   */
  getPort(): number {
    return this.port;
  }
}
