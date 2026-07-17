//! ExtensionBridge — localhost TCP server that bridges the daemon to the Chrome
//! extension via the native messaging host (stdio ↔ this socket).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Write as IoWrite;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use uuid::Uuid;

/// Default port for the extension bridge TCP server.
const DEFAULT_EXT_PORT: u16 = 39040;

/// Timeout for individual commands sent to the extension (ms).
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;
const CHAIN_COMMAND_TIMEOUT_MS: u64 = 5 * 60_000;

/// How long to wait for the extension to connect before failing. The extension
/// discovers a freshly-started daemon via its periodic HTTP probe of the bridge
/// port, so this must comfortably cover one probe interval plus host spawn.
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 60_000;

/// Health check TTL — skip health check if one succeeded within this window.
const HEALTH_CHECK_TTL_MS: u64 = 5_000;

/// Auto-shutdown after extension disconnects for this long.
const DISCONNECT_SHUTDOWN_MS: u64 = 30_000;

/// Reconnect wait after a dead connection is detected.
const RECONNECT_WAIT_MS: u64 = 10_000;
const EXTENSION_PROTOCOL_VERSION: &str = "2.0";
const MIN_EXTENSION_VERSION: (u64, u64, u64) = (1, 2, 6);

fn parse_extension_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.split('-').next()?.parse().ok()?;
    Some((major, minor, patch))
}

fn validate_extension_hello(parsed: &Value) -> Result<String, String> {
    let extension_version = parsed
        .get("extensionVersion")
        .or_else(|| parsed.get("version"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let protocol_version = parsed
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or("missing");

    if protocol_version != EXTENSION_PROTOCOL_VERSION {
        return Err(format!(
            "Stella Browser extension protocol mismatch: extension {} advertises protocol {}, but this Stella runtime requires protocol {} and extension 1.2.6 or newer. Update the Stella Browser extension.",
            extension_version, protocol_version, EXTENSION_PROTOCOL_VERSION
        ));
    }
    let parsed_version = parse_extension_version(extension_version).ok_or_else(|| {
        format!(
            "Stella Browser extension reported invalid version '{}'. Update the Stella Browser extension to 1.2.6 or newer.",
            extension_version
        )
    })?;
    if parsed_version < MIN_EXTENSION_VERSION {
        return Err(format!(
            "Stella Browser extension {} is too old; this Stella runtime requires 1.2.6 or newer. Update the Stella Browser extension.",
            extension_version
        ));
    }
    Ok(extension_version.to_string())
}

struct PendingCommand {
    tx: oneshot::Sender<Value>,
    generation: u64,
}

struct BridgeInner {
    connected: bool,
    last_connection_error: Option<String>,
    cmd_tx: Option<mpsc::Sender<String>>,
    connection_generation: Option<u64>,
    next_generation: u64,
    pending: HashMap<String, PendingCommand>,
    last_health_check: Instant,
}

#[derive(Clone)]
pub struct ExtensionBridge {
    port: u16,
    token: String,
    inner: Arc<Mutex<BridgeInner>>,
    connected_notify: Arc<Notify>,
    shutdown_tx: Option<mpsc::Sender<()>>,
}

impl ExtensionBridge {
    /// Create a new ExtensionBridge. Pass `token = Some("")` to disable auth,
    /// `token = None` to auto-generate a random token.
    pub fn new(port: Option<u16>, token: Option<String>) -> Self {
        let port = port.unwrap_or_else(|| {
            env::var("STELLA_BROWSER_EXT_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(DEFAULT_EXT_PORT)
        });

        let token = match token {
            Some(t) => t.trim().to_string(),
            None => env::var("STELLA_BROWSER_EXT_TOKEN")
                .ok()
                .map(|t| t.trim().to_string())
                .unwrap_or_else(|| Uuid::new_v4().to_string()),
        };

        Self {
            port,
            token,
            inner: Arc::new(Mutex::new(BridgeInner {
                connected: false,
                last_connection_error: None,
                cmd_tx: None,
                connection_generation: None,
                next_generation: 0,
                pending: HashMap::new(),
                last_health_check: Instant::now() - Duration::from_secs(60),
            })),
            connected_notify: Arc::new(Notify::new()),
            shutdown_tx: None,
        }
    }

    /// Start the TCP server (native host connects from localhost). Returns a channel
    /// that fires when the extension has been disconnected too long (for daemon auto-shutdown).
    pub async fn start(&mut self, session: &str) -> Result<mpsc::Receiver<()>, String> {
        let socket_dir = get_socket_dir();
        if !socket_dir.exists() {
            let _ = fs::create_dir_all(&socket_dir);
        }

        // Write discovery files
        let token_file = socket_dir.join(format!("{}.ext-token", session));
        let port_file = socket_dir.join(format!("{}.ext-port", session));

        // Write token file with restrictive permissions
        fs::write(&token_file, &self.token)
            .map_err(|e| format!("Failed to write token file: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&token_file, fs::Permissions::from_mode(0o600));
        }

        fs::write(&port_file, self.port.to_string())
            .map_err(|e| format!("Failed to write port file: {}", e))?;

        // Bind with SO_REUSEADDR so we can rebind immediately after a daemon kill
        // (avoids TIME_WAIT blocking the port for 30-120 seconds).
        let listener = match bind_reuse(self.port) {
            Ok(l) => l,
            Err(_) => {
                // Port is actively held by a stale process — kill it and retry
                kill_process_on_port(self.port);
                let mut bound = None;
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    match bind_reuse(self.port) {
                        Ok(l) => {
                            bound = Some(l);
                            break;
                        }
                        Err(_) => continue,
                    }
                }
                bound.ok_or_else(|| format!(
                    "Failed to bind extension bridge on port {} — stale process could not be killed",
                    self.port
                ))?
            }
        };

        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        let (disconnect_shutdown_tx, disconnect_shutdown_rx) = mpsc::channel::<()>(1);
        self.shutdown_tx = Some(shutdown_tx);

        let inner = self.inner.clone();
        let connected_notify = self.connected_notify.clone();
        let token = self.token.clone();
        let session_str = session.to_string();

        // Spawn the TCP accept loop (native messaging host connects to 127.0.0.1:port).
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accept = listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                if !is_local_socket(addr) {
                                    let _ = writeln!(std::io::stderr(), "Extension bridge: rejected non-local connection ({})", addr);
                                    continue;
                                }

                                let inner = inner.clone();
                                let notify = connected_notify.clone();
                                let token = token.clone();
                                let session = session_str.clone();
                                let disconnect_tx = disconnect_shutdown_tx.clone();

                                tokio::spawn(async move {
                                    handle_extension_connection(
                                        stream,
                                        inner,
                                        notify,
                                        token,
                                        session,
                                        disconnect_tx,
                                    ).await;
                                });
                            }
                            Err(e) => {
                                let _ = writeln!(std::io::stderr(), "Extension bridge accept error: {}", e);
                            }
                        }
                    }
                    _ = shutdown_rx.recv() => {
                        break;
                    }
                }
            }

            // Cleanup discovery files
            let _ = fs::remove_file(&token_file);
            let _ = fs::remove_file(&port_file);
        });

        Ok(disconnect_shutdown_rx)
    }

    /// Wait for the extension to connect. Returns true if connected within timeout.
    pub async fn wait_for_connection(&self) -> bool {
        {
            let guard = self.inner.lock().await;
            if guard.connected && guard.cmd_tx.is_some() {
                return true;
            }
        }

        let timeout = Duration::from_millis(DEFAULT_WAIT_TIMEOUT_MS);
        tokio::select! {
            _ = self.connected_notify.notified() => {
                let guard = self.inner.lock().await;
                guard.connected && guard.cmd_tx.is_some()
            },
            _ = tokio::time::sleep(timeout) => {
                let guard = self.inner.lock().await;
                guard.connected && guard.cmd_tx.is_some()
            }
        }
    }

    /// Check if the extension is currently connected.
    pub async fn is_connected(&self) -> bool {
        let guard = self.inner.lock().await;
        guard.connected
    }

    /// Send a command to the extension and wait for the response.
    pub async fn execute_command(&self, command: &Value) -> Result<Value, String> {
        // Wait for connection if not connected
        {
            let guard = self.inner.lock().await;
            if !guard.connected || guard.cmd_tx.is_none() {
                drop(guard);
                if !self.wait_for_connection().await {
                    let guard = self.inner.lock().await;
                    return Err(guard.last_connection_error.clone().unwrap_or_else(||
                        "Extension not connected. Install the Stella Browser Bridge extension and connect it.".to_string()
                    ));
                }
            }
        }

        // Health check (skip if recent)
        let needs_health_check = {
            let guard = self.inner.lock().await;
            guard.last_health_check.elapsed() > Duration::from_millis(HEALTH_CHECK_TTL_MS)
        };

        if needs_health_check {
            let (alive, checked_generation) = self.verify_connection().await;
            if !alive {
                // Connection is dead — wait for reconnection
                if let Some(generation) = checked_generation {
                    deactivate_connection(&self.inner, generation).await;
                }

                let start = Instant::now();
                let mut reconnected = false;
                while start.elapsed() < Duration::from_millis(RECONNECT_WAIT_MS) {
                    let is_connected = {
                        let guard = self.inner.lock().await;
                        guard.connected && guard.cmd_tx.is_some()
                    };
                    if is_connected {
                        let (alive, _) = self.verify_connection().await;
                        if alive {
                            reconnected = true;
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }

                if !reconnected {
                    return Err(
                        "Extension connection is dead (service worker terminated). The extension will auto-reconnect shortly — try again.".to_string()
                    );
                }
            }
        }

        // Send the command
        let id = command
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let msg = json!({
            "type": "command",
            "id": id,
            "action": command.get("action").and_then(|v| v.as_str()).unwrap_or(""),
        });

        // Merge all command fields into the message
        let mut msg_obj = msg.as_object().unwrap().clone();
        if let Some(cmd_obj) = command.as_object() {
            for (k, v) in cmd_obj {
                if k != "type" {
                    msg_obj.insert(k.clone(), v.clone());
                }
            }
        }
        let msg_str = serde_json::to_string(&Value::Object(msg_obj))
            .map_err(|e| format!("Failed to serialize command: {}", e))?;

        let (tx, rx) = oneshot::channel();
        let generation;

        {
            let mut guard = self.inner.lock().await;
            generation = match guard.connection_generation {
                Some(generation) if guard.connected && guard.cmd_tx.is_some() => generation,
                _ => return Err("Extension not connected".to_string()),
            };
            guard
                .pending
                .insert(id.clone(), PendingCommand { tx, generation });

            if let Some(ref cmd_tx) = guard.cmd_tx {
                if cmd_tx.send(msg_str).await.is_err() {
                    remove_pending_for_generation(&mut guard, &id, generation);
                    return Err("Extension connection closed".to_string());
                }
            } else {
                remove_pending_for_generation(&mut guard, &id, generation);
                return Err("Extension not connected".to_string());
            }
        }

        // Chains have their own bounded extension-side runtime and may include
        // several waits. Keep the bridge deadline above that bound so a late
        // response cannot leave unobserved steps running after timeout.
        let command_timeout_ms = if command.get("action").and_then(Value::as_str) == Some("chain") {
            CHAIN_COMMAND_TIMEOUT_MS
        } else {
            DEFAULT_COMMAND_TIMEOUT_MS
        };
        match tokio::time::timeout(Duration::from_millis(command_timeout_ms), rx).await {
            Ok(Ok(response)) => {
                // Update health check timestamp on successful response
                {
                    let mut guard = self.inner.lock().await;
                    if guard.connection_generation == Some(generation) {
                        guard.last_health_check = Instant::now();
                    }
                }
                Ok(response)
            }
            Ok(Err(_)) => {
                let mut guard = self.inner.lock().await;
                remove_pending_for_generation(&mut guard, &id, generation);
                Err("Extension disconnected while waiting for response".to_string())
            }
            Err(_) => {
                let mut guard = self.inner.lock().await;
                remove_pending_for_generation(&mut guard, &id, generation);
                Err(format!("Command timed out after {}ms", command_timeout_ms))
            }
        }
    }

    /// Health check — send a command-level ping and wait for response.
    async fn verify_connection(&self) -> (bool, Option<u64>) {
        let hc_id = format!("_hc_{}", Instant::now().elapsed().as_micros());
        let msg = json!({
            "type": "command",
            "action": "healthcheck",
            "id": hc_id,
        });
        let msg_str = match serde_json::to_string(&msg) {
            Ok(s) => s,
            Err(_) => return (false, None),
        };

        let (tx, rx) = oneshot::channel();
        let generation;

        {
            let mut guard = self.inner.lock().await;
            generation = match guard.connection_generation {
                Some(generation) if guard.connected && guard.cmd_tx.is_some() => generation,
                _ => return (false, None),
            };
            guard
                .pending
                .insert(hc_id.clone(), PendingCommand { tx, generation });
            if let Some(ref cmd_tx) = guard.cmd_tx {
                if cmd_tx.send(msg_str).await.is_err() {
                    remove_pending_for_generation(&mut guard, &hc_id, generation);
                    return (false, Some(generation));
                }
            }
        }

        match tokio::time::timeout(Duration::from_secs(3), rx).await {
            Ok(Ok(response)) if response.get("success").and_then(Value::as_bool) == Some(true) => {
                let mut guard = self.inner.lock().await;
                if guard.connection_generation == Some(generation) {
                    guard.last_health_check = Instant::now();
                }
                (true, Some(generation))
            }
            _ => {
                let mut guard = self.inner.lock().await;
                remove_pending_for_generation(&mut guard, &hc_id, generation);
                (false, Some(generation))
            }
        }
    }

    /// Stop the bridge and clean up.
    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(()).await;
        }

        let mut guard = self.inner.lock().await;
        guard.connected = false;
        guard.last_connection_error = None;
        guard.cmd_tx = None;
        guard.connection_generation = None;
        guard.pending.clear();
    }

    pub fn get_port(&self) -> u16 {
        self.port
    }

    pub fn get_token(&self) -> &str {
        &self.token
    }
}

/// Minimal HTTP reply for extension liveness probes (see `probe_daemon` in the
/// extension's connection.js). Lets the extension detect "Stella is running"
/// with a plain fetch() instead of spawning the native messaging host process.
const HEALTH_PROBE_RESPONSE: &str =
    "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";

fn remove_pending_for_generation(
    inner: &mut BridgeInner,
    id: &str,
    generation: u64,
) -> Option<PendingCommand> {
    if inner.pending.get(id).map(|pending| pending.generation) == Some(generation) {
        inner.pending.remove(id)
    } else {
        None
    }
}

fn take_pending_for_generation(inner: &mut BridgeInner, generation: u64) -> Vec<PendingCommand> {
    let ids: Vec<String> = inner
        .pending
        .iter()
        .filter(|(_, pending)| pending.generation == generation)
        .map(|(id, _)| id.clone())
        .collect();

    ids.into_iter()
        .filter_map(|id| inner.pending.remove(&id))
        .collect()
}

fn fail_pending_commands(pending: Vec<PendingCommand>) {
    for pending in pending {
        let _ = pending.tx.send(json!({
            "success": false,
            "error": "Extension disconnected",
        }));
    }
}

async fn activate_connection(inner: &Arc<Mutex<BridgeInner>>, cmd_tx: mpsc::Sender<String>) -> u64 {
    let (generation, displaced_pending) = {
        let mut guard = inner.lock().await;
        guard.next_generation = guard
            .next_generation
            .checked_add(1)
            .expect("extension connection generation overflow");
        let generation = guard.next_generation;
        let displaced_pending = guard.pending.drain().map(|(_, pending)| pending).collect();

        guard.connected = true;
        guard.last_connection_error = None;
        guard.cmd_tx = Some(cmd_tx);
        guard.connection_generation = Some(generation);
        (generation, displaced_pending)
    };

    fail_pending_commands(displaced_pending);
    generation
}

async fn deactivate_connection(inner: &Arc<Mutex<BridgeInner>>, generation: u64) -> bool {
    let pending = {
        let mut guard = inner.lock().await;
        if guard.connection_generation != Some(generation) {
            return false;
        }

        guard.connected = false;
        guard.cmd_tx = None;
        guard.connection_generation = None;
        guard.last_health_check = Instant::now() - Duration::from_secs(60);
        take_pending_for_generation(&mut guard, generation)
    };

    fail_pending_commands(pending);
    true
}

async fn should_shutdown_for_disconnect(inner: &Arc<Mutex<BridgeInner>>, generation: u64) -> bool {
    let guard = inner.lock().await;
    !guard.connected && guard.connection_generation.is_none() && guard.next_generation == generation
}

/// Handle a single TCP connection from the native messaging host (line-delimited JSON).
async fn handle_extension_connection(
    mut stream: TcpStream,
    inner: Arc<Mutex<BridgeInner>>,
    connected_notify: Arc<Notify>,
    expected_token: String,
    session: String,
    disconnect_shutdown_tx: mpsc::Sender<()>,
) {
    // Liveness-probe short-circuit: answer HTTP and bail before touching any
    // bridge state so probes never disturb an active native-host connection.
    let mut probe_buf = [0u8; 8];
    match tokio::time::timeout(Duration::from_secs(10), stream.peek(&mut probe_buf)).await {
        Ok(Ok(n)) if n > 0 => {
            let head = &probe_buf[..n];
            if head.starts_with(b"GET ") || head.starts_with(b"HEAD") {
                let _ = stream.write_all(HEALTH_PROBE_RESPONSE.as_bytes()).await;
                let _ = stream.shutdown().await;
                return;
            }
        }
        // EOF, socket error, or 10s without a single byte — give up before
        // the JSONL path so a silent dialer can't churn bridge state.
        _ => return,
    }

    let mut authenticated = false;
    let mut connection_generation = None;
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<String>(256);

    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    // Spawn writer task — one JSON object per line
    let write_handle = tokio::spawn(async move {
        while let Some(msg) = cmd_rx.recv().await {
            let mut line = msg;
            line.push('\n');
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if write_half.flush().await.is_err() {
                break;
            }
        }
        let _ = write_half.shutdown().await;
    });

    let auth_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut line = String::new();

    loop {
        line.clear();
        let read_fut = reader.read_line(&mut line);
        let msg = tokio::select! {
            r = read_fut => r,
            _ = tokio::time::sleep_until(auth_deadline), if !authenticated => {
                break;
            }
        };

        let n = match msg {
            Ok(n) => n,
            Err(_) => break,
        };

        if n == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            "hello" => {
                if authenticated {
                    continue;
                }

                let extension_version = match validate_extension_hello(&parsed) {
                    Ok(version) => version,
                    Err(error) => {
                        {
                            let mut guard = inner.lock().await;
                            guard.last_connection_error = Some(error.clone());
                        }
                        let err = json!({
                            "type": "auth_error",
                            "error": error,
                        });
                        let _ = cmd_tx.send(serde_json::to_string(&err).unwrap()).await;
                        connected_notify.notify_waiters();
                        break;
                    }
                };
                let token = parsed.get("token").and_then(|v| v.as_str()).unwrap_or("");
                let token_matches = token == expected_token;

                // Native host injects token from disk; empty expected_token disables auth (dev only).
                if token_matches || expected_token.is_empty() {
                    authenticated = true;
                    connection_generation = Some(activate_connection(&inner, cmd_tx.clone()).await);
                    connected_notify.notify_waiters();

                    let welcome = json!({
                        "type": "welcome",
                        "session": session,
                        "sessionToken": expected_token,
                        "extensionVersion": extension_version,
                        "protocolVersion": EXTENSION_PROTOCOL_VERSION,
                    });
                    let _ = cmd_tx.send(serde_json::to_string(&welcome).unwrap()).await;
                } else {
                    let err = json!({
                        "type": "auth_error",
                        "error": "Invalid token",
                    });
                    let _ = cmd_tx.send(serde_json::to_string(&err).unwrap()).await;
                    break;
                }
            }
            "ping" => {
                if !authenticated {
                    break;
                }
                let pong = json!({ "type": "pong" });
                let _ = cmd_tx.send(serde_json::to_string(&pong).unwrap()).await;
            }
            "response" => {
                if !authenticated {
                    break;
                }
                let id = parsed
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let success = parsed
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                let mut guard = inner.lock().await;
                let Some(generation) = connection_generation else {
                    continue;
                };
                if let Some(pending) = remove_pending_for_generation(&mut guard, &id, generation) {
                    guard.last_health_check = Instant::now();

                    let response = if success {
                        json!({
                            "id": id,
                            "success": true,
                            "data": parsed.get("data").cloned().unwrap_or(Value::Null),
                        })
                    } else {
                        json!({
                            "id": id,
                            "success": false,
                            "error": parsed.get("error").and_then(|v| v.as_str()).unwrap_or("Extension command failed without an error message"),
                        })
                    };

                    let _ = pending.tx.send(response);
                }
            }
            _ => {}
        }
    }

    if authenticated {
        if let Some(generation) = connection_generation {
            if deactivate_connection(&inner, generation).await {
                let inner_clone = inner.clone();
                let disconnect_tx = disconnect_shutdown_tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(DISCONNECT_SHUTDOWN_MS)).await;
                    if should_shutdown_for_disconnect(&inner_clone, generation).await {
                        let _ = disconnect_tx.send(()).await;
                    }
                });
            }
        }
    }

    write_handle.abort();
}

fn is_local_socket(addr: SocketAddr) -> bool {
    match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn get_socket_dir() -> PathBuf {
    if let Ok(dir) = env::var("STELLA_BROWSER_SOCKET_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }

    if let Ok(xdg) = env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("stella-browser");
        }
    }

    if let Some(home) = dirs::home_dir() {
        return home.join(".stella-browser");
    }

    std::env::temp_dir().join("stella-browser")
}

/// Create a TcpListener with SO_REUSEADDR set, so we can rebind immediately
/// even if the port is in TIME_WAIT from a recently killed daemon.
fn bind_reuse(port: u16) -> Result<TcpListener, String> {
    use socket2::{Domain, Protocol, Socket, Type};

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", port)
        .parse()
        .map_err(|e| format!("Invalid address: {}", e))?;

    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
        .map_err(|e| format!("Failed to create socket: {}", e))?;

    #[cfg(unix)]
    socket
        .set_reuse_address(true)
        .map_err(|e| format!("Failed to set SO_REUSEADDR: {}", e))?;

    socket
        .bind(&addr.into())
        .map_err(|e| format!("Failed to bind: {}", e))?;

    socket
        .listen(128)
        .map_err(|e| format!("Failed to listen: {}", e))?;

    socket
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set nonblocking: {}", e))?;

    let std_listener: std::net::TcpListener = socket.into();
    TcpListener::from_std(std_listener)
        .map_err(|e| format!("Failed to convert to tokio listener: {}", e))
}

/// Kill any process currently listening on the given port.
pub fn kill_process_on_port(port: u16) {
    #[cfg(windows)]
    {
        use std::process::Command;
        // Use PowerShell with base64-encoded command to avoid escaping issues
        let script = format!(
            "Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}",
            port
        );
        // Encode as UTF-16LE for -EncodedCommand
        let utf16: Vec<u8> = script
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &utf16);
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-EncodedCommand", &encoded])
            .output();
    }

    #[cfg(unix)]
    {
        use std::process::Command;
        let out = match Command::new("lsof")
            .args(["-ti", &format!("tcp:{}", port), "-s", "tcp:listen"])
            .output()
        {
            Ok(o) => o,
            Err(_) => return,
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        for pid in stdout.trim().lines().filter(|l| !l.is_empty()) {
            let _ = Command::new("kill").args(["-9", pid]).output();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_inner() -> Arc<Mutex<BridgeInner>> {
        Arc::new(Mutex::new(BridgeInner {
            connected: false,
            last_connection_error: None,
            cmd_tx: None,
            connection_generation: None,
            next_generation: 0,
            pending: HashMap::new(),
            last_health_check: Instant::now() - Duration::from_secs(60),
        }))
    }

    #[test]
    fn extension_handshake_rejects_legacy_or_incompatible_protocols() {
        let legacy = json!({ "type": "hello", "version": "1.0.0" });
        assert!(validate_extension_hello(&legacy)
            .unwrap_err()
            .contains("protocol mismatch"));

        let old = json!({
            "type": "hello",
            "extensionVersion": "1.2.5",
            "protocolVersion": EXTENSION_PROTOCOL_VERSION,
        });
        assert!(validate_extension_hello(&old)
            .unwrap_err()
            .contains("too old"));

        let current = json!({
            "type": "hello",
            "extensionVersion": "1.2.6",
            "protocolVersion": EXTENSION_PROTOCOL_VERSION,
        });
        assert_eq!(validate_extension_hello(&current).unwrap(), "1.2.6");
    }

    #[tokio::test]
    async fn old_disconnect_after_new_connect_preserves_new_channel_and_pending_command() {
        let inner = test_inner();
        let (old_tx, _old_rx) = mpsc::channel(1);
        let old_generation = activate_connection(&inner, old_tx).await;
        let (new_tx, mut new_rx) = mpsc::channel(1);
        let new_generation = activate_connection(&inner, new_tx).await;

        let (pending_tx, mut pending_rx) = oneshot::channel();
        {
            let mut guard = inner.lock().await;
            guard.pending.insert(
                "new-command".to_string(),
                PendingCommand {
                    tx: pending_tx,
                    generation: new_generation,
                },
            );
        }

        assert!(!deactivate_connection(&inner, old_generation).await);

        let current_tx = {
            let guard = inner.lock().await;
            assert!(guard.connected);
            assert_eq!(guard.connection_generation, Some(new_generation));
            assert!(guard.pending.contains_key("new-command"));
            guard.cmd_tx.clone().expect("new command channel")
        };
        current_tx.send("still-current".to_string()).await.unwrap();
        assert_eq!(new_rx.recv().await.as_deref(), Some("still-current"));
        assert!(matches!(
            pending_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn old_response_after_new_connect_cannot_complete_new_pending_command() {
        let inner = test_inner();
        let (old_tx, _old_rx) = mpsc::channel(1);
        let old_generation = activate_connection(&inner, old_tx).await;
        let (new_tx, _new_rx) = mpsc::channel(1);
        let new_generation = activate_connection(&inner, new_tx).await;
        let (pending_tx, mut pending_rx) = oneshot::channel();

        {
            let mut guard = inner.lock().await;
            guard.pending.insert(
                "shared-id".to_string(),
                PendingCommand {
                    tx: pending_tx,
                    generation: new_generation,
                },
            );
            assert!(
                remove_pending_for_generation(&mut guard, "shared-id", old_generation).is_none()
            );
            assert!(guard.pending.contains_key("shared-id"));
        }
        assert!(matches!(
            pending_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        let pending = {
            let mut guard = inner.lock().await;
            remove_pending_for_generation(&mut guard, "shared-id", new_generation)
                .expect("new generation owns the pending command")
        };
        let response = json!({ "success": true });
        pending.tx.send(response.clone()).unwrap();
        assert_eq!(pending_rx.await.unwrap(), response);
    }

    #[tokio::test]
    async fn old_disconnect_timer_cannot_shutdown_after_replacement_disconnects() {
        let inner = test_inner();
        let (old_tx, _old_rx) = mpsc::channel(1);
        let old_generation = activate_connection(&inner, old_tx).await;
        assert!(deactivate_connection(&inner, old_generation).await);

        let (new_tx, _new_rx) = mpsc::channel(1);
        let new_generation = activate_connection(&inner, new_tx).await;
        assert!(deactivate_connection(&inner, new_generation).await);

        assert!(!should_shutdown_for_disconnect(&inner, old_generation).await);
        assert!(should_shutdown_for_disconnect(&inner, new_generation).await);
    }
}
