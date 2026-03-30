//! Chrome native messaging host: bridges stdio (Chrome framing) to the local
//! extension TCP bridge. Injects the bridge token on `hello` when the extension
//! has not stored it yet (zero user setup).

use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::net::TcpStream;

use crate::connection::get_socket_dir;

const DEFAULT_SESSION: &str = "stella-app-bridge";
const DEFAULT_PORT: u16 = 39040;

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
    use std::time::Duration;

    let sock = SockRef::from(stream);
    let _ = sock.set_keepalive(true);
    let _ = sock.set_tcp_keepalive(
        &socket2::TcpKeepalive::new()
            .with_time(Duration::from_secs(60))
            .with_interval(Duration::from_secs(10)),
    );
}

/// Run as Chrome native messaging host (stdio ↔ TCP bridge).
pub fn run_native_host() -> Result<(), String> {
    let session = std::env::var("STELLA_BROWSER_SESSION").unwrap_or_else(|_| DEFAULT_SESSION.to_string());
    let port = read_bridge_port(&session);
    let bridge_token = read_bridge_token(&session).unwrap_or_default();

    let tcp = TcpStream::connect(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Stella browser bridge is not running yet ({}). Open Stella first.", e))?;

    // No read/write timeout — the connection is long-lived and Chrome may
    // suspend the service worker for extended periods (delaying keepalive
    // pings). TCP keepalive detects a dead peer without a hard deadline.
    set_tcp_keepalive(&tcp);
    let tcp_read = tcp.try_clone().map_err(|e| e.to_string())?;

    let chrome_to_tcp = std::thread::spawn(move || -> io::Result<()> {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        let mut tcp = tcp;
        loop {
            let buf = match read_chrome_frame(&mut stdin) {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e),
            };

            // Fast path: forward raw bytes when no token injection is needed.
            let needs_injection = !bridge_token.is_empty()
                && buf.windows(b"\"hello\"".len()).any(|w| w == b"\"hello\"");

            if needs_injection {
                let mut value: Value = match serde_json::from_slice(&buf) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                inject_token_if_needed(&mut value, &bridge_token);
                let mut line = serde_json::to_string(&value).map_err(|e| {
                    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
                })?;
                line.push('\n');
                tcp.write_all(line.as_bytes())?;
            } else {
                tcp.write_all(&buf)?;
                tcp.write_all(b"\n")?;
            }
            tcp.flush()?;
        }
        Ok(())
    });

    let tcp_to_chrome = std::thread::spawn(move || -> io::Result<()> {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        let mut reader = std::io::BufReader::new(tcp_read);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line)?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Err(e) = write_chrome_frame(&mut stdout, trimmed.as_bytes()) {
                let _ = writeln!(std::io::stderr(), "native-host: dropping oversized message ({} bytes): {}", trimmed.len(), e);
                continue;
            }
        }
        Ok(())
    });

    let _ = chrome_to_tcp.join();
    let _ = tcp_to_chrome.join();
    Ok(())
}
