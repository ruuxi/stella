use std::path::Path;
use tokio::fs;

/// Get available bytes on the volume containing `path`.
pub async fn available_bytes(path: &str) -> Option<u64> {
    let resolved = Path::new(path);
    let mut current = resolved.to_path_buf();
    loop {
        if fs::metadata(&current).await.is_ok() {
            break;
        }
        if !current.pop() {
            return None;
        }
    }

    match fs2::available_space(&current) {
        Ok(bytes) => Some(bytes),
        Err(_) => None,
    }
}
