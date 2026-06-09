//! Chrome native messaging host: bridges stdio (Chrome framing) to the local
//! extension TCP bridge. Injects the bridge token on `hello` when the extension
//! has not stored it yet (zero user setup).
//!
//! The host is resident: while Chrome holds the native messaging port open, the
//! process stays alive even when the daemon is not running, quietly polling the
//! bridge port until Stella starts. Exiting on a refused connection instead
//! would put the extension into a reconnect loop that respawns this process
//! (and its cmd.exe launcher on Windows) every ~30 seconds for as long as the
//! browser is open — visible churn in Task Manager whenever Stella is closed.

use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::Duration;

use crate::connection::get_socket_dir;

const DEFAULT_SESSION: &str = "stella-app-bridge";
const DEFAULT_PORT: u16 = 39040;
/// How often to probe for the daemon while it is not running.
const DAEMON_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Loopback connects either succeed or get RST'd near-instantly; the timeout
/// only guards against a pathological firewall swallowing the SYN.
const DAEMON_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// While bridging, how often to check whether the daemon connection dropped.
const BRIDGE_IDLE_TICK: Duration = Duration::from_millis(500);

fn read_bridge_token(session: &str) -> Option<String> {
    let token_path = get_socket_dir().join(format!("{}.ext-token", session));
    fs::read_to_string(&token_path).ok().map(|s| s.trim().to_string())
}

fn read_bridge_port(session: &str) -> u16 {
    let port_path = get_socket_dir().join(format!("{}.ext-port", session));
    fs::read_to_string(&port_path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn inject_token_if_needed(payload: &mut Value, token: &str) {
    if let Some(obj) = payload.as_object_mut() {
        if obj.get("type").and_then(|v| v.as_str()) != Some("hello") {
            return;
        }
        let current = obj
            .get("token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if current.is_empty() && !token.is_empty() {
            obj.insert("token".to_string(), json!(token));
        }
    }
}

/// Chrome allows up to 64 MiB for extension → host messages.
fn read_chrome_frame(stdin: &mut io::StdinLock) -> io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stdin.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 64 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message too large",
        ));
    }
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf)?;
    Ok(buf)
}

/// Chrome allows at most 1 MiB for host → extension messages.
fn write_chrome_frame(stdout: &mut io::StdoutLock, payload: &[u8]) -> io::Result<()> {
    if payload.len() > 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "host→extension message exceeds Chrome 1 MiB limit",
        ));
    }
    let len = payload.len() as u32;
    stdout.write_all(&len.to_le_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

fn set_tcp_keepalive(stream: &TcpStream) {
    use socket2::SockRef;

    let sock = SockRef::from(stream);
    let _ = sock.set_keepalive(true);
    let _ = sock.set_tcp_keepalive(
        &socket2::TcpKeepalive::new()
            .with_time(Duration::from_secs(60))
            .with_interval(Duration::from_secs(10)),
    );
}

fn frame_is_hello(buf: &[u8]) -> bool {
    if !buf.windows(b"\"hello\"".len()).any(|w| w == b"\"hello\"") {
        return false;
    }
    serde_json::from_slice::<Value>(buf)
        .ok()
        .map(|v| v.get("type").and_then(|t| t.as_str()) == Some("hello"))
        .unwrap_or(false)
}

fn note_frame(buf: Vec<u8>, pending_hello: &mut Option<Vec<u8>>) {
    if frame_is_hello(&buf) {
        *pending_hello = Some(buf);
    }
}

/// Forward one Chrome frame to the daemon as a JSONL line, injecting the bridge
/// token into `hello` frames. Returns false when the TCP write failed (daemon
/// connection is dead); frames that fail to parse are silently skipped.
fn send_frame_to_tcp(tcp: &mut TcpStream, buf: &[u8], bridge_token: &str) -> bool {
    // Fast path: forward raw bytes when no token injection is needed.
    let needs_injection = !bridge_token.is_empty()
        && buf.windows(b"\"hello\"".len()).any(|w| w == b"\"hello\"");

    let written = if needs_injection {
        let mut value: Value = match serde_json::from_slice(buf) {
            Ok(v) => v,
            Err(_) => return true,
        };
        inject_token_if_needed(&mut value, bridge_token);
        let mut line = match serde_json::to_string(&value) {
            Ok(l) => l,
            Err(_) => return true,
        };
        line.push('\n');
        tcp.write_all(line.as_bytes())
    } else {
        tcp.write_all(buf).and_then(|_| tcp.write_all(b"\n"))
    };

    written.and_then(|_| tcp.flush()).is_ok()
}

/// Poll for the daemon's bridge port while consuming Chrome frames (buffering
/// the latest `hello` for replay). Returns the connected stream, or None when
/// Chrome closed the native messaging port.
fn wait_for_daemon(
    session: &str,
    frame_rx: &Receiver<Vec<u8>>,
    pending_hello: &mut Option<Vec<u8>>,
) -> Option<TcpStream> {
    loop {
        loop {
            match frame_rx.try_recv() {
                Ok(buf) => note_frame(buf, pending_hello),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return None,
            }
        }

        // The daemon expects `hello` as the first message on a connection
        // (10s auth deadline) — don't dial until the extension has sent one.
        if pending_hello.is_some() {
            let addr = SocketAddr::from(([127, 0, 0, 1], read_bridge_port(session)));
            if let Ok(tcp) = TcpStream::connect_timeout(&addr, DAEMON_CONNECT_TIMEOUT) {
                return Some(tcp);
            }
        }

        match frame_rx.recv_timeout(DAEMON_POLL_INTERVAL) {
            Ok(buf) => note_frame(buf, pending_hello),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// Bridge Chrome frames ↔ daemon TCP until one side drops. Returns true when
/// the daemon connection dropped (caller returns to waiting), false when Chrome
/// closed the native messaging port (process should exit).
fn bridge(
    tcp: TcpStream,
    session: &str,
    frame_rx: &Receiver<Vec<u8>>,
    pending_hello: &mut Option<Vec<u8>>,
) -> bool {
    // Token/port files are rewritten by each daemon run — read per connection.
    let bridge_token = read_bridge_token(session).unwrap_or_default();

    let tcp_read = match tcp.try_clone() {
        Ok(t) => t,
        Err(_) => return true,
    };
    let mut tcp_write = tcp;

    let tcp_to_chrome = std::thread::spawn(move || {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        let mut reader = io::BufReader::new(tcp_read);
        let mut line = String::new();
        loop {
            line.clear();
            let n = match reader.read_line(&mut line) {
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
            if let Err(e) = write_chrome_frame(&mut stdout, trimmed.as_bytes()) {
                let _ = writeln!(
                    std::io::stderr(),
                    "native-host: dropping oversized message ({} bytes): {}",
                    trimmed.len(),
                    e
                );
                continue;
            }
        }
    });

    // Replay the extension's `hello` to (re)authenticate this connection — on
    // daemon restarts the extension keeps its port open and won't resend it.
    let mut tcp_alive = match pending_hello.as_deref() {
        Some(hello) => send_frame_to_tcp(&mut tcp_write, hello, &bridge_token),
        None => true,
    };

    while tcp_alive {
        if tcp_to_chrome.is_finished() {
            break;
        }
        match frame_rx.recv_timeout(BRIDGE_IDLE_TICK) {
            Ok(buf) => {
                if !send_frame_to_tcp(&mut tcp_write, &buf, &bridge_token) {
                    tcp_alive = false;
                }
                note_frame(buf, pending_hello);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                let _ = tcp_write.shutdown(std::net::Shutdown::Both);
                let _ = tcp_to_chrome.join();
                return false;
            }
        }
    }

    let _ = tcp_write.shutdown(std::net::Shutdown::Both);
    let _ = tcp_to_chrome.join();
    true
}

/// Run as Chrome native messaging host (stdio ↔ TCP bridge).
pub fn run_native_host() -> Result<(), String> {
    let session =
        std::env::var("STELLA_BROWSER_SESSION").unwrap_or_else(|_| DEFAULT_SESSION.to_string());

    // Single stdin reader for the process lifetime: Chrome frames flow into a
    // channel; a disconnected channel means Chrome closed the port (stdin EOF).
    let (frame_tx, frame_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        loop {
            match read_chrome_frame(&mut stdin) {
                Ok(buf) => {
                    if frame_tx.send(buf).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut pending_hello: Option<Vec<u8>> = None;

    loop {
        let tcp = match wait_for_daemon(&session, &frame_rx, &mut pending_hello) {
            Some(tcp) => tcp,
            None => return Ok(()),
        };

        // No read/write timeout — the connection is long-lived and Chrome may
        // suspend the service worker for extended periods (delaying keepalive
        // pings). TCP keepalive detects a dead peer without a hard deadline.
        set_tcp_keepalive(&tcp);

        if !bridge(tcp, &session, &frame_rx, &mut pending_hello) {
            return Ok(());
        }
        // Daemon connection dropped (Stella stopped/restarted) — keep holding
        // the Chrome port and go back to waiting.
    }
}
