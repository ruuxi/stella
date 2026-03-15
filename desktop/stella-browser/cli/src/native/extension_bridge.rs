use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Mutex, Notify, RwLock};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::Message;

type WsWriter = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Message,
>;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct ExtensionBridge {
    port: u16,
    token: String,
    session: String,
    socket_dir: PathBuf,
    command_timeout: Duration,
    current_writer: Arc<RwLock<Option<(u64, Arc<Mutex<WsWriter>>)>>>,
    pending: PendingMap,
    connected_tx: watch::Sender<bool>,
    shutdown: Arc<Notify>,
    accept_handle: Option<JoinHandle<()>>,
    next_connection_id: Arc<std::sync::atomic::AtomicU64>,
    last_health_check_success: Arc<Mutex<Option<Instant>>>,
}

impl ExtensionBridge {
    pub fn new(
        session: String,
        socket_dir: PathBuf,
        port: u16,
        token: Option<String>,
        command_timeout: Duration,
    ) -> Self {
        let token = token
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        let (connected_tx, _) = watch::channel(false);

        Self {
            port,
            token,
            session,
            socket_dir,
            command_timeout,
            current_writer: Arc::new(RwLock::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            connected_tx,
            shutdown: Arc::new(Notify::new()),
            accept_handle: None,
            next_connection_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            last_health_check_success: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn start(&mut self) -> Result<(), String> {
        if self.accept_handle.is_some() {
            return Ok(());
        }

        fs::create_dir_all(&self.socket_dir)
            .map_err(|e| format!("Failed to create extension socket dir: {}", e))?;

        self.write_discovery_files()?;

        let listener = TcpListener::bind(format!("127.0.0.1:{}", self.port))
            .await
            .map_err(|e| format!("Failed to bind extension bridge: {}", e))?;

        let shutdown = Arc::clone(&self.shutdown);
        let current_writer = Arc::clone(&self.current_writer);
        let pending = Arc::clone(&self.pending);
        let connected_tx = self.connected_tx.clone();
        let expected_token = self.token.clone();
        let session = self.session.clone();
        let next_connection_id = Arc::clone(&self.next_connection_id);
        let last_health = Arc::clone(&self.last_health_check_success);

        self.accept_handle = Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.notified() => break,
                    accept_result = listener.accept() => {
                        let Ok((stream, _)) = accept_result else {
                            continue;
                        };

                        let current_writer = Arc::clone(&current_writer);
                        let pending = Arc::clone(&pending);
                        let connected_tx = connected_tx.clone();
                        let expected_token = expected_token.clone();
                        let session = session.clone();
                        let next_connection_id = Arc::clone(&next_connection_id);
                        let last_health = Arc::clone(&last_health);

                        tokio::spawn(async move {
                            handle_connection(
                                stream,
                                current_writer,
                                pending,
                                connected_tx,
                                expected_token,
                                session,
                                next_connection_id,
                                last_health,
                            )
                            .await;
                        });
                    }
                }
            }
        }));

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<(), String> {
        self.shutdown.notify_waiters();

        if let Some(handle) = self.accept_handle.take() {
            handle.abort();
        }

        {
            let mut writer_guard = self.current_writer.write().await;
            *writer_guard = None;
        }

        self.connected_tx.send_replace(false);
        *self.last_health_check_success.lock().await = None;
        reject_pending(&self.pending, "Extension bridge shutting down").await;
        self.remove_discovery_files();
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        *self.connected_tx.borrow()
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub async fn execute_command(&self, command: &Value) -> Result<Value, String> {
        if !self.is_connected() {
            return Err(
                "Extension not connected. Install the Stella Browser Bridge extension and connect it."
                    .to_string(),
            );
        }

        let should_verify = {
            let guard = self.last_health_check_success.lock().await;
            guard
                .as_ref()
                .is_none_or(|instant| instant.elapsed() >= Duration::from_secs(5))
        };

        let mut is_alive = true;
        if should_verify {
            is_alive = self.verify_connection().await;
            if is_alive {
                *self.last_health_check_success.lock().await = Some(Instant::now());
            }
        }

        if !is_alive {
            self.clear_current_connection().await;

            if !self.wait_for_reconnect(Duration::from_secs(10)).await {
                return Err(
                    "Extension connection is dead (service worker terminated). The extension will auto-reconnect shortly - try again."
                        .to_string(),
                );
            }
        }

        self.send_command(command, self.command_timeout).await
    }

    pub async fn wait_for_connection(&self, timeout: Duration) -> bool {
        self.wait_for_reconnect(timeout).await
    }

    async fn verify_connection(&self) -> bool {
        let healthcheck = json!({
            "id": format!("_hc_{}", chrono_like_timestamp()),
            "action": "healthcheck"
        });

        self.send_command(&healthcheck, Duration::from_secs(3))
            .await
            .is_ok()
    }

    async fn wait_for_reconnect(&self, timeout: Duration) -> bool {
        if self.is_connected() {
            return true;
        }

        let mut rx = self.connected_tx.subscribe();
        let wait = async {
            loop {
                if *rx.borrow() {
                    return true;
                }
                if rx.changed().await.is_err() {
                    return false;
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .unwrap_or(false)
    }

    async fn send_command(&self, command: &Value, timeout: Duration) -> Result<Value, String> {
        let command_id = command
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Command missing id")?
            .to_string();

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(command_id.clone(), tx);

        let send_result = self.send_raw_command(command).await;
        if let Err(error) = send_result {
            self.pending.lock().await.remove(&command_id);
            return Err(error);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Extension disconnected".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&command_id);
                let action = command
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                Err(format!(
                    "Command '{}' timed out after {}ms",
                    action,
                    timeout.as_millis()
                ))
            }
        }
    }

    async fn send_raw_command(&self, command: &Value) -> Result<(), String> {
        let writer = {
            let guard = self.current_writer.read().await;
            guard
                .as_ref()
                .map(|(_, writer)| Arc::clone(writer))
                .ok_or_else(|| "Extension not connected".to_string())?
        };

        let payload = command
            .as_object()
            .map(|map| {
                let mut message = map.clone();
                message.insert("type".to_string(), Value::String("command".to_string()));
                Value::Object(message)
            })
            .ok_or_else(|| "Command payload must be an object".to_string())?;

        let text = serde_json::to_string(&payload)
            .map_err(|e| format!("Failed to serialize extension command: {}", e))?;

        let mut writer = writer.lock().await;
        writer
            .send(Message::Text(text.into()))
            .await
            .map_err(|e| format!("Failed to send extension command: {}", e))
    }

    async fn clear_current_connection(&self) {
        {
            let mut guard = self.current_writer.write().await;
            *guard = None;
        }
        self.connected_tx.send_replace(false);
        *self.last_health_check_success.lock().await = None;
    }

    fn write_discovery_files(&self) -> Result<(), String> {
        fs::write(
            self.socket_dir.join(format!("{}.ext-token", self.session)),
            &self.token,
        )
        .map_err(|e| format!("Failed to write extension token file: {}", e))?;
        fs::write(
            self.socket_dir.join(format!("{}.ext-port", self.session)),
            self.port.to_string(),
        )
        .map_err(|e| format!("Failed to write extension port file: {}", e))?;
        Ok(())
    }

    fn remove_discovery_files(&self) {
        let _ = fs::remove_file(self.socket_dir.join(format!("{}.ext-token", self.session)));
        let _ = fs::remove_file(self.socket_dir.join(format!("{}.ext-port", self.session)));
    }
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    current_writer: Arc<RwLock<Option<(u64, Arc<Mutex<WsWriter>>)>>>,
    pending: PendingMap,
    connected_tx: watch::Sender<bool>,
    expected_token: String,
    session: String,
    next_connection_id: Arc<std::sync::atomic::AtomicU64>,
    last_health_check_success: Arc<Mutex<Option<Instant>>>,
) {
    let callback = |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                    response: tokio_tungstenite::tungstenite::handshake::server::Response| {
        let origin_ok = request
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .map(|origin| origin.starts_with("chrome-extension://"))
            .unwrap_or(true);

        if origin_ok {
            Ok(response)
        } else {
            let mut reject =
                tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some(
                    "Origin not allowed".to_string(),
                ));
            *reject.status_mut() = StatusCode::FORBIDDEN;
            Err(reject)
        }
    };

    let mut ws_stream = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let hello_msg = tokio::time::timeout(Duration::from_secs(10), ws_stream.next()).await;
    let Some(Ok(Message::Text(text))) = hello_msg.ok().flatten() else {
        let _ = ws_stream.close(None).await;
        return;
    };

    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            let _ = ws_stream.close(None).await;
            return;
        }
    };

    let token = parsed.get("token").and_then(|v| v.as_str()).unwrap_or("");
    let is_hello = parsed.get("type").and_then(|v| v.as_str()) == Some("hello");
    if !is_hello || (!expected_token.is_empty() && token != expected_token) {
        let _ = ws_stream
            .send(Message::Text(
                json!({
                    "type": "auth_error",
                    "error": "Invalid token",
                })
                .to_string()
                .into(),
            ))
            .await;
        let _ = ws_stream.close(None).await;
        return;
    }

    let connection_id = next_connection_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (write_half, mut read_half) = ws_stream.split();
    let writer = Arc::new(Mutex::new(write_half));

    {
        let mut guard = current_writer.write().await;
        *guard = Some((connection_id, Arc::clone(&writer)));
    }
    connected_tx.send_replace(true);
    *last_health_check_success.lock().await = Some(Instant::now());

    {
        let mut writer_guard = writer.lock().await;
        let _ = writer_guard
            .send(Message::Text(
                json!({
                    "type": "welcome",
                    "session": session,
                })
                .to_string()
                .into(),
            ))
            .await;
    }

    while let Some(message) = read_half.next().await {
        match message {
            Ok(Message::Text(text)) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    let msg_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match msg_type {
                        "ping" => {
                            let mut writer_guard = writer.lock().await;
                            let _ = writer_guard
                                .send(Message::Text(json!({ "type": "pong" }).to_string().into()))
                                .await;
                        }
                        "response" => {
                            if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                                if let Some(tx) = pending.lock().await.remove(id) {
                                    let response = json!({
                                        "id": id,
                                        "success": parsed.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
                                        "data": parsed.get("data").cloned(),
                                        "error": parsed.get("error").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                    });
                                    let _ = tx.send(Ok(response));
                                    *last_health_check_success.lock().await = Some(Instant::now());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    let should_clear = {
        let guard = current_writer.read().await;
        guard
            .as_ref()
            .map(|(current_id, _)| *current_id == connection_id)
            .unwrap_or(false)
    };

    if should_clear {
        {
            let mut guard = current_writer.write().await;
            *guard = None;
        }
        connected_tx.send_replace(false);
        *last_health_check_success.lock().await = None;
        reject_pending(&pending, "Extension disconnected").await;
    }
}

async fn reject_pending(pending: &PendingMap, message: &str) {
    let mut pending_guard = pending.lock().await;
    let values: Vec<_> = pending_guard.drain().map(|(_, tx)| tx).collect();
    drop(pending_guard);

    for tx in values {
        let _ = tx.send(Err(message.to_string()));
    }
}

fn chrono_like_timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
