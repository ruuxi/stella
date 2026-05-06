use keyring::Entry;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

const SERVICE: &str = "Stella Protected Storage";
const PREFIX: &str = "stella-launcher-keychain";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtectedStorageRequest {
    operation: String,
    scope: String,
    value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtectedStorageResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn scoped_prefix(scope: &str) -> String {
    format!("{PREFIX}:{scope}:v1:")
}

fn keychain_user(scope: &str, key_id: &str) -> String {
    format!("{scope}:{key_id}")
}

fn random_key_id() -> String {
    let mut bytes = [0_u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn protect(scope: &str, plaintext: &str) -> Result<String, String> {
    let key_id = random_key_id();
    let entry = Entry::new(SERVICE, &keychain_user(scope, &key_id))
        .map_err(|err| format!("Could not open launcher keychain entry: {err}"))?;
    entry
        .set_password(plaintext)
        .map_err(|err| format!("Could not save launcher keychain entry: {err}"))?;
    Ok(format!("{}{key_id}", scoped_prefix(scope)))
}

fn key_id_from_protected(scope: &str, protected: &str) -> Option<String> {
    let prefix = scoped_prefix(scope);
    if !protected.starts_with(&prefix) {
        return None;
    }
    let key_id = protected[prefix.len()..].trim();
    if key_id.is_empty() {
        return None;
    }
    Some(key_id.to_string())
}

fn unprotect(scope: &str, protected: &str) -> Result<Option<String>, String> {
    let Some(key_id) = key_id_from_protected(scope, protected) else {
        return Ok(None);
    };
    let entry = Entry::new(SERVICE, &keychain_user(scope, &key_id))
        .map_err(|err| format!("Could not open launcher keychain entry: {err}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Could not read launcher keychain entry: {err}")),
    }
}

fn delete(scope: &str, protected: &str) -> Result<(), String> {
    let Some(key_id) = key_id_from_protected(scope, protected) else {
        return Ok(());
    };
    let entry = Entry::new(SERVICE, &keychain_user(scope, &key_id))
        .map_err(|err| format!("Could not open launcher keychain entry: {err}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("Could not delete launcher keychain entry: {err}")),
    }
}

fn handle_request(request: ProtectedStorageRequest) -> ProtectedStorageResponse {
    if request.scope.trim().is_empty() {
        return ProtectedStorageResponse {
            ok: false,
            value: None,
            error: Some("Missing protected storage scope.".into()),
        };
    }

    match request.operation.as_str() {
        "protect" => match protect(&request.scope, &request.value) {
            Ok(value) => ProtectedStorageResponse {
                ok: true,
                value: Some(value),
                error: None,
            },
            Err(error) => ProtectedStorageResponse {
                ok: false,
                value: None,
                error: Some(error),
            },
        },
        "unprotect" => match unprotect(&request.scope, &request.value) {
            Ok(value) => ProtectedStorageResponse {
                ok: true,
                value,
                error: None,
            },
            Err(error) => ProtectedStorageResponse {
                ok: false,
                value: None,
                error: Some(error),
            },
        },
        "delete" => match delete(&request.scope, &request.value) {
            Ok(()) => ProtectedStorageResponse {
                ok: true,
                value: None,
                error: None,
            },
            Err(error) => ProtectedStorageResponse {
                ok: false,
                value: None,
                error: Some(error),
            },
        },
        _ => ProtectedStorageResponse {
            ok: false,
            value: None,
            error: Some("Unknown protected storage operation.".into()),
        },
    }
}

pub fn maybe_handle_cli() -> bool {
    if !std::env::args().any(|arg| arg == "--stella-protected-storage") {
        return false;
    }

    let mut input = String::new();
    let response = match std::io::stdin().read_to_string(&mut input) {
        Ok(_) => match serde_json::from_str::<ProtectedStorageRequest>(&input) {
            Ok(request) => handle_request(request),
            Err(err) => ProtectedStorageResponse {
                ok: false,
                value: None,
                error: Some(format!("Invalid protected storage request: {err}")),
            },
        },
        Err(err) => ProtectedStorageResponse {
            ok: false,
            value: None,
            error: Some(format!("Could not read protected storage request: {err}")),
        },
    };

    let mut stdout = std::io::stdout();
    let _ = serde_json::to_writer(&mut stdout, &response);
    let _ = stdout.write_all(b"\n");
    response.ok
}
