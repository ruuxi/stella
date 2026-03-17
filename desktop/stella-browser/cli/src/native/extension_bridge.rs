//! ExtensionBridge — WebSocket server that bridges the daemon to a Chrome extension.
//!
//! The daemon forwards commands to the extension via WebSocket, and the extension
//! executes them using Chrome extension APIs (chrome.debugger, chrome.tabs, etc.).

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Default port for the extension bridge WebSocket server.
const DEFAULT_EXT_PORT: u16 = 9224;

/// Timeout for individual commands sent to the extension (ms).
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 60_000;

/// How long to wait for the extension to connect before failing.
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30_000;

/// Health check TTL — skip health check if one succeeded within this window.
const HEALTH_CHECK_TTL_MS: u64 = 5_000;

/// Auto-shutdown after extension disconnects for this long.
const DISCONNECT_SHUTDOWN_MS: u64 = 30_000;

/// Reconnect wait after a dead connection is detected.
const RECONNECT_WAIT_MS: u64 = 10_000;

struct PendingCommand {
    tx: oneshot::Sender<Value>,
}

struct BridgeInner {
    connected: bool,
    cmd_tx: Option<mpsc::Sender<String>>,
    pending: HashMap<String, PendingCommand>,
    last_health_check: Instant,
}

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
                cmd_tx: None,
                pending: HashMap::new(),
                last_health_check: Instant::now() - Duration::from_secs(60),
            })),
            connected_notify: Arc::new(Notify::new()),
            shutdown_tx: None,
        }
    }

    /// Start the WebSocket server. Returns a channel that fires when the extension
    /// has been disconnected too long (for daemon auto-shutdown).
    pub async fn start(
        &mut self,
        session: &str,
    ) -> Result<mpsc::Receiver<()>, String> {
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

        // Kill any stale process on the port
        kill_process_on_port(self.port);

        let listener = TcpListener::bind(format!("127.0.0.1:{}", self.port))
            .await
            .map_err(|e| format!("Failed to bind extension bridge on port {}: {}", self.port, e))?;

        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        let (disconnect_shutdown_tx, disconnect_shutdown_rx) = mpsc::channel::<()>(1);
        self.shutdown_tx = Some(shutdown_tx);

        let inner = self.inner.clone();
        let connected_notify = self.connected_notify.clone();
        let token = self.token.clone();
        let session_str = session.to_string();

        // Spawn the WebSocket server accept loop
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accept = listener.accept() => {
                        match accept {
                            Ok((stream, addr)) => {
                                let origin_ok = Arc::new(std::sync::atomic::AtomicBool::new(true));
                                let origin_ok_clone = origin_ok.clone();

                                let ws = accept_hdr_async(stream, |req: &Request, resp: Response| {
                                    // Verify origin — allow chrome-extension:// or no origin
                                    if let Some(origin) = req.headers().get("origin") {
                                        if let Ok(origin_str) = origin.to_str() {
                                            if !origin_str.starts_with("chrome-extension://") {
                                                origin_ok_clone.store(false, std::sync::atomic::Ordering::SeqCst);
                                            }
                                        }
                                    }
                                    Ok(resp)
                                }).await;

                                if !origin_ok.load(std::sync::atomic::Ordering::SeqCst) {
                                    let _ = writeln!(std::io::stderr(), "Extension bridge: rejected connection from non-extension origin ({})", addr);
                                    continue;
                                }

                                match ws {
                                    Ok(ws_stream) => {
                                        let inner = inner.clone();
                                        let notify = connected_notify.clone();
                                        let token = token.clone();
                                        let session = session_str.clone();
                                        let disconnect_tx = disconnect_shutdown_tx.clone();

                                        tokio::spawn(async move {
                                            handle_extension_connection(
                                                ws_stream, inner, notify, token, session, disconnect_tx,
                                            ).await;
                                        });
                                    }
                                    Err(e) => {
                                        let _ = writeln!(std::io::stderr(), "Extension bridge WebSocket error: {}", e);
                                    }
                                }
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
            _ = self.connected_notify.notified() => true,
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
                    return Err(
                        "Extension not connected. Install the Stella Browser Bridge extension and connect it.".to_string()
                    );
                }
            }
        }

        // Health check (skip if recent)
        let needs_health_check = {
            let guard = self.inner.lock().await;
            guard.last_health_check.elapsed() > Duration::from_millis(HEALTH_CHECK_TTL_MS)
        };

        if needs_health_check {
            let alive = self.verify_connection().await;
            if !alive {
                // Connection is dead — wait for reconnection
                {
                    let mut guard = self.inner.lock().await;
                    guard.connected = false;
                    guard.cmd_tx = None;
                    guard.last_health_check =
                        Instant::now() - Duration::from_secs(60);
                    guard.pending.clear();
                }

                let start = Instant::now();
                let mut reconnected = false;
                while start.elapsed() < Duration::from_millis(RECONNECT_WAIT_MS) {
                    let is_connected = {
                        let guard = self.inner.lock().await;
                        guard.connected && guard.cmd_tx.is_some()
                    };
                    if is_connected && self.verify_connection().await {
                        reconnected = true;
                        break;
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

        {
            let mut guard = self.inner.lock().await;
            guard
                .pending
                .insert(id.clone(), PendingCommand { tx });

            if let Some(ref cmd_tx) = guard.cmd_tx {
                cmd_tx
                    .send(msg_str)
                    .await
                    .map_err(|_| "Extension connection closed".to_string())?;
            } else {
                guard.pending.remove(&id);
                return Err("Extension not connected".to_string());
            }
        }

        // Wait for response with timeout
        match tokio::time::timeout(Duration::from_millis(DEFAULT_COMMAND_TIMEOUT_MS), rx).await {
            Ok(Ok(response)) => {
                // Update health check timestamp on successful response
                {
                    let mut guard = self.inner.lock().await;
                    guard.last_health_check = Instant::now();
                }
                Ok(response)
            }
            Ok(Err(_)) => {
                let mut guard = self.inner.lock().await;
                guard.pending.remove(&id);
                Err("Extension disconnected while waiting for response".to_string())
            }
            Err(_) => {
                let mut guard = self.inner.lock().await;
                guard.pending.remove(&id);
                Err(format!(
                    "Command timed out after {}ms",
                    DEFAULT_COMMAND_TIMEOUT_MS
                ))
            }
        }
    }

    /// Health check — send a command-level ping and wait for response.
    async fn verify_connection(&self) -> bool {
        let hc_id = format!("_hc_{}", Instant::now().elapsed().as_micros());
        let msg = json!({
            "type": "command",
            "action": "healthcheck",
            "id": hc_id,
        });
        let msg_str = match serde_json::to_string(&msg) {
            Ok(s) => s,
            Err(_) => return false,
        };

        let (tx, rx) = oneshot::channel();

        {
            let mut guard = self.inner.lock().await;
            if guard.cmd_tx.is_none() {
                return false;
            }
            guard.pending.insert(hc_id.clone(), PendingCommand { tx });
            if let Some(ref cmd_tx) = guard.cmd_tx {
                if cmd_tx.send(msg_str).await.is_err() {
                    guard.pending.remove(&hc_id);
                    return false;
                }
            }
        }

        match tokio::time::timeout(Duration::from_secs(3), rx).await {
            Ok(Ok(_)) => {
                let mut guard = self.inner.lock().await;
                guard.last_health_check = Instant::now();
                true
            }
            _ => {
                let mut guard = self.inner.lock().await;
                guard.pending.remove(&hc_id);
                false
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
        guard.cmd_tx = None;
        guard.pending.clear();
    }

    pub fn get_port(&self) -> u16 {
        self.port
    }

    pub fn get_token(&self) -> &str {
        &self.token
    }
}

/// Handle a single WebSocket connection from the Chrome extension.
async fn handle_extension_connection(
    ws_stream: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    inner: Arc<Mutex<BridgeInner>>,
    connected_notify: Arc<Notify>,
    expected_token: String,
    session: String,
    disconnect_shutdown_tx: mpsc::Sender<()>,
) {
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // Check if already connected
    {
        let guard = inner.lock().await;
        if guard.connected && guard.cmd_tx.is_some() {
            // Already have a live connection — reject this one
            let _ = ws_tx
                .send(Message::Close(None))
                .await;
            return;
        }
    }

    let mut authenticated = false;
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<String>(256);

    // Spawn writer task
    let write_handle = tokio::spawn(async move {
        while let Some(msg) = cmd_rx.recv().await {
            if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.close().await;
    });

    // Auth timeout
    let auth_deadline = tokio::time::Instant::now() + Duration::from_secs(10);

    loop {
        let msg = tokio::select! {
            msg = ws_rx.next() => msg,
            _ = tokio::time::sleep_until(auth_deadline), if !authenticated => {
                // Auth timeout
                break;
            }
        };

        let msg = match msg {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(_))) | None => break,
            Some(Ok(Message::Ping(_))) => continue,
            Some(Err(_)) => break,
            _ => continue,
        };

        let parsed: Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match msg_type {
            "hello" => {
                let token = parsed
                    .get("token")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if token == expected_token || expected_token.is_empty() {
                    authenticated = true;

                    // Register this connection
                    {
                        let mut guard = inner.lock().await;
                        guard.connected = true;
                        guard.cmd_tx = Some(cmd_tx.clone());
                    }
                    connected_notify.notify_waiters();

                    // Send welcome
                    let welcome = json!({
                        "type": "welcome",
                        "session": session,
                    });
                    let _ = cmd_tx
                        .send(serde_json::to_string(&welcome).unwrap())
                        .await;
                } else {
                    let err = json!({ "type": "auth_error", "error": "Invalid token" });
                    let _ = cmd_tx
                        .send(serde_json::to_string(&err).unwrap())
                        .await;
                    break;
                }
            }
            "ping" => {
                if !authenticated {
                    break;
                }
                let pong = json!({ "type": "pong" });
                let _ = cmd_tx
                    .send(serde_json::to_string(&pong).unwrap())
                    .await;
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
                if let Some(pending) = guard.pending.remove(&id) {
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
                            "error": parsed.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown extension error"),
                        })
                    };

                    let _ = pending.tx.send(response);
                }
            }
            _ => {}
        }
    }

    // Connection closed — clean up
    if authenticated {
        let mut guard = inner.lock().await;
        guard.connected = false;
        guard.cmd_tx = None;
        guard.last_health_check = Instant::now() - Duration::from_secs(60);

        // Reject all pending commands
        for (_, pending) in guard.pending.drain() {
            let _ = pending.tx.send(json!({
                "success": false,
                "error": "Extension disconnected",
            }));
        }

        // Start auto-shutdown timer
        let inner_clone = inner.clone();
        let disconnect_tx = disconnect_shutdown_tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(DISCONNECT_SHUTDOWN_MS)).await;
            let guard = inner_clone.lock().await;
            if !guard.connected {
                let _ = disconnect_tx.send(()).await;
            }
        });
    }

    write_handle.abort();
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

/// Kill any process currently listening on the given port.
fn kill_process_on_port(port: u16) {
    #[cfg(windows)]
    {
        use std::process::Command;
        let out = match Command::new("cmd")
            .args([
                "/C",
                &format!(
                    "netstat -ano | findstr \"LISTENING\" | findstr \"127.0.0.1:{}\"",
                    port
                ),
            ])
            .output()
        {
            Ok(o) => o,
            Err(_) => return,
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut pids = std::collections::HashSet::new();
        for line in stdout.lines() {
            let parts: Vec<&str> = line.trim().split_whitespace().collect();
            if let Some(pid) = parts.last() {
                if pid.chars().all(|c| c.is_ascii_digit()) && *pid != "0" {
                    pids.insert(pid.to_string());
                }
            }
        }
        for pid in pids {
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid])
                .output();
        }
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
