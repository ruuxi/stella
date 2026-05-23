/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, Auth } from "googleapis";
import {
  deleteConnectorAccessTokens,
  loadConnectorTokenPayload,
  saveConnectorTokenPayload,
} from "../connectors/oauth.js";
import { getProjectRoot } from "./paths.js";
import { loadConfig } from "./config.js";
import { logToFile } from "./logger.js";

const TOKEN_KEY = "google-workspace";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const stellaRootFromProjectRoot = () => {
  const projectRoot = getProjectRoot();
  const suffix = "/google-workspace";
  if (!projectRoot.endsWith(suffix)) {
    throw new Error("Google Workspace project root is not under Stella state.");
  }
  return projectRoot.slice(0, -suffix.length);
};

/**
 * Small auth adapter for the existing Google Workspace service classes.
 *
 * The old implementation had its own plaintext token file, cloud-function
 * exchange, and browser launcher. Store-native integrations now own OAuth:
 * tokens live in connector protected storage and browser launch is brokered
 * by the shared connector dialog before this class is ever asked for a client.
 */
export class AuthManager {
  private client: Auth.OAuth2Client | null = null;
  private readonly clientId = loadConfig().clientId;
  private onStatusUpdate: ((message: string) => void) | null = null;

  constructor(private scopes: string[]) {}

  public setOnStatusUpdate(callback: (message: string) => void) {
    this.onStatusUpdate = callback;
  }

  public dispose(): void {
    this.onStatusUpdate = null;
    this.client = null;
  }

  public async getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
    const stellaRoot = stellaRootFromProjectRoot();
    const payload = await loadConnectorTokenPayload(stellaRoot, TOKEN_KEY);
    if (!payload?.accessToken) {
      throw new Error("Google Workspace is not connected.");
    }

    const savedScopes = new Set(payload.scopes ?? []);
    const missingScopes = this.scopes.filter((scope) => !savedScopes.has(scope));
    if (missingScopes.length > 0) {
      logToFile(
        `Connector token missing Google Workspace scopes: ${missingScopes.join(", ")}`,
      );
      throw new Error("Google Workspace needs to be reconnected.");
    }

    const client = new google.auth.OAuth2({ clientId: this.clientId });
    client.setCredentials({
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
      expiry_date: payload.expiresAt,
      scope: payload.scopes?.join(" "),
      token_type: "Bearer",
    });
    client.on("tokens", async (tokens) => {
      const current = await loadConnectorTokenPayload(stellaRoot, TOKEN_KEY);
      await saveConnectorTokenPayload(stellaRoot, TOKEN_KEY, {
        accessToken: tokens.access_token ?? current?.accessToken ?? payload.accessToken,
        refreshToken:
          tokens.refresh_token ?? current?.refreshToken ?? payload.refreshToken ?? undefined,
        expiresAt:
          tokens.expiry_date ??
          current?.expiresAt,
        clientId: this.clientId,
        tokenEndpoint: TOKEN_ENDPOINT,
        scopes: tokens.scope
          ? tokens.scope.split(/\s+/u).filter(Boolean)
          : current?.scopes ?? payload.scopes,
      });
    });
    this.client = client;
    return client;
  }

  public async clearAuth(): Promise<void> {
    this.client = null;
    await deleteConnectorAccessTokens(stellaRootFromProjectRoot(), [TOKEN_KEY]);
  }

  public async refreshToken(): Promise<void> {
    this.onStatusUpdate?.("Refreshing Google Workspace connection...");
    const client = await this.getAuthenticatedClient();
    const response = await client.refreshAccessToken();
    await saveConnectorTokenPayload(stellaRootFromProjectRoot(), TOKEN_KEY, {
      accessToken: response.credentials.access_token ?? "",
      refreshToken:
        response.credentials.refresh_token ??
        client.credentials.refresh_token ??
        undefined,
      expiresAt: response.credentials.expiry_date ?? undefined,
      clientId: this.clientId,
      tokenEndpoint: TOKEN_ENDPOINT,
      scopes:
        response.credentials.scope?.split(/\s+/u).filter(Boolean) ?? this.scopes,
    });
  }
}
