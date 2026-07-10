mod connection;
mod install;
mod native;
#[cfg(test)]
mod test_utils;
mod validation;

use serde_json::{json, Value};
use std::env;
use std::process::exit;
use uuid::Uuid;

const DEFAULT_SESSION: &str = "default";

fn print_help() {
    println!(
        r#"stella-browser - Stella browser service

Usage:
  stella-browser service run [--session <name>]
  stella-browser service ensure [--session <name>] [--json]
  stella-browser diagnostics health [--session <name>] [--json]
  stella-browser diagnostics tabs [--session <name>] [--json]
  stella-browser native-host

Browser automation is available through Stella's persistent node_repl browser
API. This executable only hosts and diagnoses the native browser service."#
    );
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value).unwrap_or_else(|_| {
            r#"{"success":false,"error":"Failed to serialize response"}"#.to_string()
        })
    );
}

fn fail(message: impl AsRef<str>, json_mode: bool) -> ! {
    if json_mode {
        print_json(&json!({ "success": false, "error": message.as_ref() }));
    } else {
        eprintln!("{}", message.as_ref());
    }
    exit(1);
}

fn parse_common_options(args: &[String]) -> Result<(String, bool), String> {
    let mut session = env::var("STELLA_BROWSER_SESSION").unwrap_or_else(|_| DEFAULT_SESSION.into());
    let mut json_mode = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => json_mode = true,
            "--session" => {
                index += 1;
                session = args
                    .get(index)
                    .cloned()
                    .ok_or_else(|| "--session requires a value".to_string())?;
            }
            value if value.starts_with("--session=") => {
                session = value["--session=".len()..].to_string();
            }
            value => return Err(format!("Unknown option: {value}")),
        }
        index += 1;
    }
    if !validation::is_valid_session_name(&session) {
        return Err(validation::session_name_error(&session));
    }
    Ok((session, json_mode))
}

fn run_daemon(session: &str) {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    env::set_var("STELLA_BROWSER_SESSION", session);
    let runtime = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    runtime.block_on(native::daemon::run_daemon(session));
}

fn run_diagnostic(action: &str, session: &str, json_mode: bool) {
    let command = json!({
        "id": format!("r{}", Uuid::new_v4().simple()),
        "action": action,
    });
    match connection::send_command(command, session) {
        Ok(response) => {
            let value = serde_json::to_value(&response).unwrap_or_else(
                |_| json!({ "success": false, "error": "Failed to serialize response" }),
            );
            if json_mode {
                print_json(&value);
            } else if response.success {
                if let Some(data) = response.data {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
                    );
                } else {
                    println!("ok");
                }
            } else {
                fail(
                    response.error.unwrap_or_else(|| "Diagnostic failed".into()),
                    false,
                );
            }
        }
        Err(error) => fail(error, json_mode),
    }
}

fn ensure_extension_backend(session: &str) -> Result<(), String> {
    let command = json!({
        "id": format!("r{}", Uuid::new_v4().simple()),
        "action": "launch",
        "provider": "extension",
    });
    let response = connection::send_command(command, session)?;
    if response.success {
        Ok(())
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "Failed to initialize the extension backend".into()))
    }
}

fn main() {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }

    let args: Vec<String> = env::args().skip(1).collect();

    // Chromium passes the extension origin to native hosts on Windows.
    let spawned_by_chromium = cfg!(windows)
        && args
            .iter()
            .any(|arg| arg.starts_with("chrome-extension://"));
    if spawned_by_chromium || args.first().is_some_and(|arg| arg == "native-host") {
        if let Err(error) = native::native_host::run_native_host() {
            eprintln!("{error}");
            exit(1);
        }
        return;
    }

    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return;
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("stella-browser {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    match (
        args.first().map(String::as_str),
        args.get(1).map(String::as_str),
    ) {
        (Some("service"), Some("run")) => match parse_common_options(&args[2..]) {
            Ok((session, _)) => run_daemon(&session),
            Err(error) => fail(error, args.iter().any(|arg| arg == "--json")),
        },
        (Some("service"), Some("ensure")) => match parse_common_options(&args[2..]) {
            Ok((session, json_mode)) => {
                match connection::ensure_daemon(&session).and_then(|result| {
                    ensure_extension_backend(&session)?;
                    Ok(result)
                }) {
                    Ok(result) => {
                        let value = json!({
                            "success": true,
                            "data": {
                                "session": session,
                                "status": if result.already_running { "running" } else { "started" },
                            }
                        });
                        if json_mode {
                            print_json(&value);
                        } else {
                            println!("{}", value["data"]["status"].as_str().unwrap_or("running"));
                        }
                    }
                    Err(error) => fail(error, json_mode),
                }
            }
            Err(error) => fail(error, args.iter().any(|arg| arg == "--json")),
        },
        (Some("diagnostics"), Some("health")) => match parse_common_options(&args[2..]) {
            Ok((session, json_mode)) => run_diagnostic("healthcheck", &session, json_mode),
            Err(error) => fail(error, args.iter().any(|arg| arg == "--json")),
        },
        (Some("diagnostics"), Some("tabs")) => match parse_common_options(&args[2..]) {
            Ok((session, json_mode)) => run_diagnostic("tab_list", &session, json_mode),
            Err(error) => fail(error, args.iter().any(|arg| arg == "--json")),
        },
        _ => fail(
            "Browser action commands were removed. Use Stella's node_repl browser API.",
            args.iter().any(|arg| arg == "--json"),
        ),
    }
}
