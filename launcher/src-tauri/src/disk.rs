use std::path::Path;
use tokio::fs;

/// Get available bytes on the volume containing `path`.
pub async fn available_bytes(path: &str) -> Option<u64> {
    // Walk up to find an existing ancestor
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

    // Use fs2 to get available space
    match fs2::available_space(&current) {
        Ok(bytes) => Some(bytes),
        Err(_) => None,
    }
}

/// Recursively compute directory size in bytes.
pub async fn dir_size(path: &str) -> u64 {
    dir_size_inner(Path::new(path)).await
}

async fn dir_size_inner(path: &Path) -> u64 {
    let meta = match fs::metadata(path).await {
        Ok(m) => m,
        Err(_) => return 0,
    };

    if !meta.is_dir() {
        return meta.len();
    }

    let mut total = 0u64;
    let mut entries = match fs::read_dir(path).await {
        Ok(e) => e,
        Err(_) => return 0,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let entry_path = entry.path();
        let entry_meta = match fs::metadata(&entry_path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if entry_meta.is_dir() {
            total += Box::pin(dir_size_inner(&entry_path)).await;
        } else {
            total += entry_meta.len();
        }
    }

    total
}
