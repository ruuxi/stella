use crate::color;
use crate::connection::Response;

pub fn print_response(resp: &Response, json_mode: bool, action: Option<&str>) {
    if json_mode {
        println!("{}", serde_json::to_string(resp).unwrap_or_default());
        return;
    }

    if !resp.success {
        eprintln!(
            "{} {}",
            color::error_indicator(),
            resp.error.as_deref().unwrap_or("Unknown error")
        );
        return;
    }

    if let Some(data) = &resp.data {
        // Navigation response
        if let Some(url) = data.get("url").and_then(|v| v.as_str()) {
            if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
                println!("{} {}", color::success_indicator(), color::bold(title));
                println!("  {}", color::dim(url));
                return;
            }
            println!("{}", url);
            return;
        }
        // Snapshot
        if let Some(snapshot) = data.get("snapshot").and_then(|v| v.as_str()) {
            println!("{}", snapshot);
            return;
        }
        // Title
        if let Some(title) = data.get("title").and_then(|v| v.as_str()) {
            println!("{}", title);
            return;
        }
        // Text
        if let Some(text) = data.get("text").and_then(|v| v.as_str()) {
            println!("{}", text);
            return;
        }
        // HTML
        if let Some(html) = data.get("html").and_then(|v| v.as_str()) {
            println!("{}", html);
            return;
        }
        // Value
        if let Some(value) = data.get("value").and_then(|v| v.as_str()) {
            println!("{}", value);
            return;
        }
        // Count
        if let Some(count) = data.get("count").and_then(|v| v.as_i64()) {
            println!("{}", count);
            return;
        }
        // Boolean results
        if let Some(visible) = data.get("visible").and_then(|v| v.as_bool()) {
            println!("{}", visible);
            return;
        }
        if let Some(enabled) = data.get("enabled").and_then(|v| v.as_bool()) {
            println!("{}", enabled);
            return;
        }
        if let Some(checked) = data.get("checked").and_then(|v| v.as_bool()) {
            println!("{}", checked);
            return;
        }
        // Eval result
        if let Some(result) = data.get("result") {
            println!(
                "{}",
                serde_json::to_string_pretty(result).unwrap_or_default()
            );
            return;
        }
        // iOS Devices
        if let Some(devices) = data.get("devices").and_then(|v| v.as_array()) {
            if devices.is_empty() {
                println!("No iOS devices available. Open Xcode to download simulator runtimes.");
                return;
            }

            // Separate real devices from simulators
            let real_devices: Vec<_> = devices
                .iter()
                .filter(|d| d.get("isRealDevice").and_then(|v| v.as_bool()).unwrap_or(false))
                .collect();
            let simulators: Vec<_> = devices
                .iter()
                .filter(|d| !d.get("isRealDevice").and_then(|v| v.as_bool()).unwrap_or(false))
                .collect();

            if !real_devices.is_empty() {
                println!("Connected Devices:\n");
                for device in real_devices.iter() {
                    let name = device.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let runtime = device.get("runtime").and_then(|v| v.as_str()).unwrap_or("");
                    let udid = device.get("udid").and_then(|v| v.as_str()).unwrap_or("");
                    println!("  {} {} ({})", color::green("●"), name, runtime);
                    println!("    {}", color::dim(udid));
                }
                println!();
            }

            if !simulators.is_empty() {
                println!("Simulators:\n");
                for device in simulators.iter() {
                    let name = device.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let runtime = device.get("runtime").and_then(|v| v.as_str()).unwrap_or("");
                    let state = device.get("state").and_then(|v| v.as_str()).unwrap_or("Unknown");
                    let udid = device.get("udid").and_then(|v| v.as_str()).unwrap_or("");
                    let state_indicator = if state == "Booted" {
                        color::green("●")
                    } else {
                        color::dim("○")
                    };
                    println!("  {} {} ({})", state_indicator, name, runtime);
                    println!("    {}", color::dim(udid));
                }
            }
            return;
        }
        // Tabs
        if let Some(tabs) = data.get("tabs").and_then(|v| v.as_array()) {
            for (i, tab) in tabs.iter().enumerate() {
                let title = tab
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Untitled");
                let url = tab.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let active = tab.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                let marker = if active {
                    color::cyan("→")
                } else {
                    " ".to_string()
                };
                println!("{} [{}] {} - {}", marker, i, title, url);
            }
            return;
        }
        // Console logs
        if let Some(logs) = data.get("messages").and_then(|v| v.as_array()) {
            for log in logs {
                let level = log.get("type").and_then(|v| v.as_str()).unwrap_or("log");
                let text = log.get("text").and_then(|v| v.as_str()).unwrap_or("");
                println!("{} {}", color::console_level_prefix(level), text);
            }
            return;
        }
        // Errors
        if let Some(errors) = data.get("errors").and_then(|v| v.as_array()) {
            for err in errors {
                let msg = err.get("message").and_then(|v| v.as_str()).unwrap_or("");
                println!("{} {}", color::error_indicator(), msg);
            }
            return;
        }
        // Cookies
        if let Some(cookies) = data.get("cookies").and_then(|v| v.as_array()) {
            for cookie in cookies {
                let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let value = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
                println!("{}={}", name, value);
            }
            return;
        }
        // Network requests
        if let Some(requests) = data.get("requests").and_then(|v| v.as_array()) {
            if requests.is_empty() {
                println!("No requests captured");
            } else {
                for req in requests {
                    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
                    let url = req.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let resource_type = req
                        .get("resourceType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    println!("{} {} ({})", method, url, resource_type);
                }
            }
            return;
        }
        // Cleared requests
        if let Some(cleared) = data.get("cleared").and_then(|v| v.as_bool()) {
            if cleared {
                println!("{} Request log cleared", color::success_indicator());
                return;
            }
        }
        // Bounding box
        if let Some(box_data) = data.get("box") {
            println!(
                "{}",
                serde_json::to_string_pretty(box_data).unwrap_or_default()
            );
            return;
        }
        // Element styles
        if let Some(elements) = data.get("elements").and_then(|v| v.as_array()) {
            for (i, el) in elements.iter().enumerate() {
                let tag = el.get("tag").and_then(|v| v.as_str()).unwrap_or("?");
                let text = el.get("text").and_then(|v| v.as_str()).unwrap_or("");
                println!("[{}] {} \"{}\"", i, tag, text);

                if let Some(box_data) = el.get("box") {
                    let w = box_data.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
                    let h = box_data.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
                    let x = box_data.get("x").and_then(|v| v.as_i64()).unwrap_or(0);
                    let y = box_data.get("y").and_then(|v| v.as_i64()).unwrap_or(0);
                    println!("    box: {}x{} at ({}, {})", w, h, x, y);
                }

                if let Some(styles) = el.get("styles") {
                    let font_size = styles
                        .get("fontSize")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let font_weight = styles
                        .get("fontWeight")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let font_family = styles
                        .get("fontFamily")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let color = styles.get("color").and_then(|v| v.as_str()).unwrap_or("");
                    let bg = styles
                        .get("backgroundColor")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let radius = styles
                        .get("borderRadius")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    println!("    font: {} {} {}", font_size, font_weight, font_family);
                    println!("    color: {}", color);
                    println!("    background: {}", bg);
                    if radius != "0px" {
                        println!("    border-radius: {}", radius);
                    }
                }
                println!();
            }
            return;
        }
        // Closed
        if data.get("closed").is_some() {
            println!("{} Browser closed", color::success_indicator());
            return;
        }
        // Recording start (has "started" field)
        if let Some(started) = data.get("started").and_then(|v| v.as_bool()) {
            if started {
                if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                    println!("{} Recording started: {}", color::success_indicator(), path);
                } else {
                    println!("{} Recording started", color::success_indicator());
                }
                return;
            }
        }
        // Recording restart (has "stopped" field - from recording_restart action)
        if data.get("stopped").is_some() {
            let path = data
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            if let Some(prev_path) = data.get("previousPath").and_then(|v| v.as_str()) {
                println!(
                    "{} Recording restarted: {} (previous saved to {})",
                    color::success_indicator(),
                    path,
                    prev_path
                );
            } else {
                println!("{} Recording started: {}", color::success_indicator(), path);
            }
            return;
        }
        // Recording stop (has "frames" field - from recording_stop action)
        if data.get("frames").is_some() {
            if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                if let Some(error) = data.get("error").and_then(|v| v.as_str()) {
                    println!(
                        "{} Recording saved to {} - {}",
                        color::warning_indicator(),
                        path,
                        error
                    );
                } else {
                    println!("{} Recording saved to {}", color::success_indicator(), path);
                }
            } else {
                println!("{} Recording stopped", color::success_indicator());
            }
            return;
        }
        // Download response (has "suggestedFilename" or "filename" field)
        if data.get("suggestedFilename").is_some() || data.get("filename").is_some() {
            if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
                let filename = data
                    .get("suggestedFilename")
                    .or_else(|| data.get("filename"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if filename.is_empty() {
                    println!(
                        "{} Downloaded to {}",
                        color::success_indicator(),
                        color::green(path)
                    );
                } else {
                    println!(
                        "{} Downloaded to {} ({})",
                        color::success_indicator(),
                        color::green(path),
                        filename
                    );
                }
                return;
            }
        }
        // Path-based operations (screenshot/pdf/trace/har/download/state/video)
        if let Some(path) = data.get("path").and_then(|v| v.as_str()) {
            match action.unwrap_or("") {
                "screenshot" => println!(
                    "{} Screenshot saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "pdf" => println!(
                    "{} PDF saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "trace_stop" => println!(
                    "{} Trace saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "har_stop" => println!(
                    "{} HAR saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "download" | "waitfordownload" => println!(
                    "{} Download saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "video_stop" => println!(
                    "{} Video saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "state_save" => println!(
                    "{} State saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
                "state_load" => {
                    if let Some(note) = data.get("note").and_then(|v| v.as_str()) {
                        println!("{}", note);
                    }
                    println!(
                        "{} State path set to {}",
                        color::success_indicator(),
                        color::green(path)
                    );
                }
                // video_start and other commands that provide a path with a note
                "video_start" => {
                    if let Some(note) = data.get("note").and_then(|v| v.as_str()) {
                        println!("{}", note);
                    }
                    println!("Path: {}", path);
                }
                _ => println!(
                    "{} Saved to {}",
                    color::success_indicator(),
                    color::green(path)
                ),
            }
            return;
        }

        // Informational note
        if let Some(note) = data.get("note").and_then(|v| v.as_str()) {
            println!("{}", note);
            return;
        }
        // Default success
        println!("{} Done", color::success_indicator());
    }
}

/// Print command-specific help. Returns true if help was printed, false if command unknown.
pub fn print_command_help(command: &str) -> bool {
    let help = match command {
        // === Navigation ===
        "open" | "goto" | "navigate" => {
            r##"
stella-browser open - Navigate to a URL

Usage: stella-browser open <url>

Navigates the browser to the specified URL. If no protocol is provided,
https:// is automatically prepended.

Aliases: goto, navigate

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session
  --headers <json>     Set HTTP headers (scoped to this origin)
  --headed             Show browser window

Examples:
  stella-browser open example.com
  stella-browser open https://github.com
  stella-browser open localhost:3000
  stella-browser open api.example.com --headers '{"Authorization": "Bearer token"}'
    # ^ Headers only sent to api.example.com, not other domains
"##
        }
        "back" => {
            r##"
stella-browser back - Navigate back in history

Usage: stella-browser back

Goes back one page in the browser history, equivalent to clicking
the browser's back button.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser back
"##
        }
        "forward" => {
            r##"
stella-browser forward - Navigate forward in history

Usage: stella-browser forward

Goes forward one page in the browser history, equivalent to clicking
the browser's forward button.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser forward
"##
        }
        "reload" => {
            r##"
stella-browser reload - Reload the current page

Usage: stella-browser reload

Reloads the current page, equivalent to pressing F5 or clicking
the browser's reload button.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser reload
"##
        }

        // === Core Actions ===
        "click" => {
            r##"
stella-browser click - Click an element

Usage: stella-browser click <selector>

Clicks on the specified element. The selector can be a CSS selector,
XPath, or an element reference from snapshot (e.g., @e1).

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser click "#submit-button"
  stella-browser click @e1
  stella-browser click "button.primary"
  stella-browser click "//button[@type='submit']"
"##
        }
        "dblclick" => {
            r##"
stella-browser dblclick - Double-click an element

Usage: stella-browser dblclick <selector>

Double-clicks on the specified element. Useful for text selection
or triggering double-click handlers.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser dblclick "#editable-text"
  stella-browser dblclick @e5
"##
        }
        "fill" => {
            r##"
stella-browser fill - Clear and fill an input field

Usage: stella-browser fill <selector> <text>

Clears the input field and fills it with the specified text.
This replaces any existing content in the field.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser fill "#email" "user@example.com"
  stella-browser fill @e3 "Hello World"
  stella-browser fill "input[name='search']" "query"
"##
        }
        "type" => {
            r##"
stella-browser type - Type text into an element

Usage: stella-browser type <selector> <text>

Types text into the specified element character by character.
Unlike fill, this does not clear existing content first.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser type "#search" "hello"
  stella-browser type @e2 "additional text"
"##
        }
        "hover" => {
            r##"
stella-browser hover - Hover over an element

Usage: stella-browser hover <selector>

Moves the mouse to hover over the specified element. Useful for
triggering hover states or dropdown menus.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser hover "#dropdown-trigger"
  stella-browser hover @e4
"##
        }
        "focus" => {
            r##"
stella-browser focus - Focus an element

Usage: stella-browser focus <selector>

Sets keyboard focus to the specified element.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser focus "#input-field"
  stella-browser focus @e2
"##
        }
        "check" => {
            r##"
stella-browser check - Check a checkbox

Usage: stella-browser check <selector>

Checks a checkbox element. If already checked, no action is taken.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser check "#terms-checkbox"
  stella-browser check @e7
"##
        }
        "uncheck" => {
            r##"
stella-browser uncheck - Uncheck a checkbox

Usage: stella-browser uncheck <selector>

Unchecks a checkbox element. If already unchecked, no action is taken.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser uncheck "#newsletter-opt-in"
  stella-browser uncheck @e8
"##
        }
        "select" => {
            r##"
stella-browser select - Select a dropdown option

Usage: stella-browser select <selector> <value...>

Selects one or more options in a <select> dropdown by value.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser select "#country" "US"
  stella-browser select @e5 "option2"
  stella-browser select "#menu" "opt1" "opt2" "opt3"
"##
        }
        "drag" => {
            r##"
stella-browser drag - Drag and drop

Usage: stella-browser drag <source> <target>

Drags an element from source to target location.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser drag "#draggable" "#drop-zone"
  stella-browser drag @e1 @e2
"##
        }
        "upload" => {
            r##"
stella-browser upload - Upload files

Usage: stella-browser upload <selector> <files...>

Uploads one or more files to a file input element.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser upload "#file-input" ./document.pdf
  stella-browser upload @e3 ./image1.png ./image2.png
"##
        }
        "download" => {
            r##"
stella-browser download - Download a file by clicking an element

Usage: stella-browser download <selector> <path>

Clicks an element that triggers a download and saves the file to the specified path.

Arguments:
  selector             Element to click (CSS selector or @ref)
  path                 Path where the downloaded file will be saved

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser download "#download-btn" ./file.pdf
  stella-browser download @e5 ./report.xlsx
  stella-browser download "a[href$='.zip']" ./archive.zip
"##
        }

        // === Keyboard ===
        "press" | "key" => {
            r##"
stella-browser press - Press a key or key combination

Usage: stella-browser press <key>

Presses a key or key combination. Supports special keys and modifiers.

Aliases: key

Special Keys:
  Enter, Tab, Escape, Backspace, Delete, Space
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight
  Home, End, PageUp, PageDown
  F1-F12

Modifiers (combine with +):
  Control, Alt, Shift, Meta

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser press Enter
  stella-browser press Tab
  stella-browser press Control+a
  stella-browser press Control+Shift+s
  stella-browser press Escape
"##
        }
        "keydown" => {
            r##"
stella-browser keydown - Press a key down (without release)

Usage: stella-browser keydown <key>

Presses a key down without releasing it. Use keyup to release.
Useful for holding modifier keys.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser keydown Shift
  stella-browser keydown Control
"##
        }
        "keyup" => {
            r##"
stella-browser keyup - Release a key

Usage: stella-browser keyup <key>

Releases a key that was pressed with keydown.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser keyup Shift
  stella-browser keyup Control
"##
        }

        // === Scroll ===
        "scroll" => {
            r##"
stella-browser scroll - Scroll the page

Usage: stella-browser scroll [direction] [amount]

Scrolls the page in the specified direction.

Arguments:
  direction            up, down, left, right (default: down)
  amount               Pixels to scroll (default: 300)

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser scroll
  stella-browser scroll down 500
  stella-browser scroll up 200
  stella-browser scroll left 100
"##
        }
        "scrollintoview" | "scrollinto" => {
            r##"
stella-browser scrollintoview - Scroll element into view

Usage: stella-browser scrollintoview <selector>

Scrolls the page until the specified element is visible in the viewport.

Aliases: scrollinto

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser scrollintoview "#footer"
  stella-browser scrollintoview @e15
"##
        }

        // === Wait ===
        "wait" => {
            r##"
stella-browser wait - Wait for condition

Usage: stella-browser wait <selector|ms|option>

Waits for an element to appear, a timeout, or other conditions.

Modes:
  <selector>           Wait for element to appear
  <ms>                 Wait for specified milliseconds
  --url <pattern>      Wait for URL to match pattern
  --load <state>       Wait for load state (load, domcontentloaded, networkidle)
  --fn <expression>    Wait for JavaScript expression to be truthy
  --text <text>        Wait for text to appear on page
  --download [path]    Wait for a download to complete (optionally save to path)

Download Options (with --download):
  --timeout <ms>       Timeout in milliseconds for download to start

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser wait "#loading-spinner"
  stella-browser wait 2000
  stella-browser wait --url "**/dashboard"
  stella-browser wait --load networkidle
  stella-browser wait --fn "window.appReady === true"
  stella-browser wait --text "Welcome back"
  stella-browser wait --download ./file.pdf
  stella-browser wait --download ./report.xlsx --timeout 30000
"##
        }

        // === Screenshot/PDF ===
        "screenshot" => {
            r##"
stella-browser screenshot - Take a screenshot

Usage: stella-browser screenshot [path]

Captures a screenshot of the current page. If no path is provided,
saves to a temporary directory with a generated filename.

Options:
  --full, -f           Capture full page (not just viewport)

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser screenshot
  stella-browser screenshot ./screenshot.png
  stella-browser screenshot --full ./full-page.png
"##
        }
        "pdf" => {
            r##"
stella-browser pdf - Save page as PDF

Usage: stella-browser pdf <path>

Saves the current page as a PDF file.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser pdf ./page.pdf
  stella-browser pdf ~/Documents/report.pdf
"##
        }

        // === Snapshot ===
        "snapshot" => {
            r##"
stella-browser snapshot - Get accessibility tree snapshot

Usage: stella-browser snapshot [options]

Returns an accessibility tree representation of the page with element
references (like @e1, @e2) that can be used in subsequent commands.
Designed for AI agents to understand page structure.

Options:
  -i, --interactive    Only include interactive elements
  -C, --cursor         Include cursor-interactive elements (cursor:pointer, onclick, tabindex)
  -c, --compact        Remove empty structural elements
  -d, --depth <n>      Limit tree depth
  -s, --selector <sel> Scope snapshot to CSS selector

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser snapshot
  stella-browser snapshot -i
  stella-browser snapshot -i -C         # Interactive + cursor-interactive elements
  stella-browser snapshot --compact --depth 5
  stella-browser snapshot -s "#main-content"
"##
        }

        // === Eval ===
        "eval" => {
            r##"
stella-browser eval - Execute JavaScript

Usage: stella-browser eval [options] <script>

Executes JavaScript code in the browser context and returns the result.

Options:
  -b, --base64         Decode script from base64 (avoids shell escaping issues)
  --stdin              Read script from stdin (useful for heredocs/multiline)

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser eval "document.title"
  stella-browser eval "window.location.href"
  stella-browser eval "document.querySelectorAll('a').length"
  stella-browser eval -b "ZG9jdW1lbnQudGl0bGU="

  # Read from stdin with heredoc
  cat <<'EOF' | stella-browser eval --stdin
  const links = document.querySelectorAll('a');
  links.length;
  EOF
"##
        }

        // === Close ===
        "close" | "quit" | "exit" => {
            r##"
stella-browser close - Close the browser

Usage: stella-browser close

Closes the browser instance for the current session.

Aliases: quit, exit

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser close
  stella-browser close --session mysession
"##
        }

        // === Get ===
        "get" => {
            r##"
stella-browser get - Retrieve information from elements or page

Usage: stella-browser get <subcommand> [args]

Retrieves various types of information from elements or the page.

Subcommands:
  text <selector>            Get text content of element
  html <selector>            Get inner HTML of element
  value <selector>           Get value of input element
  attr <selector> <name>     Get attribute value
  title                      Get page title
  url                        Get current URL
  count <selector>           Count matching elements
  box <selector>             Get bounding box (x, y, width, height)
  styles <selector>          Get computed styles of elements

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser get text @e1
  stella-browser get html "#content"
  stella-browser get value "#email-input"
  stella-browser get attr "#link" href
  stella-browser get title
  stella-browser get url
  stella-browser get count "li.item"
  stella-browser get box "#header"
  stella-browser get styles "button"
  stella-browser get styles @e1
"##
        }

        // === Is ===
        "is" => {
            r##"
stella-browser is - Check element state

Usage: stella-browser is <subcommand> <selector>

Checks the state of an element and returns true/false.

Subcommands:
  visible <selector>   Check if element is visible
  enabled <selector>   Check if element is enabled (not disabled)
  checked <selector>   Check if checkbox/radio is checked

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser is visible "#modal"
  stella-browser is enabled "#submit-btn"
  stella-browser is checked "#agree-checkbox"
"##
        }

        // === Find ===
        "find" => {
            r##"
stella-browser find - Find and interact with elements by locator

Usage: stella-browser find <locator> <value> [action] [text]

Finds elements using semantic locators and optionally performs an action.

Locators:
  role <role>              Find by ARIA role (--name <n>, --exact)
  text <text>              Find by text content (--exact)
  label <label>            Find by associated label (--exact)
  placeholder <text>       Find by placeholder text (--exact)
  alt <text>               Find by alt text (--exact)
  title <text>             Find by title attribute (--exact)
  testid <id>              Find by data-testid attribute
  first <selector>         First matching element
  last <selector>          Last matching element
  nth <index> <selector>   Nth matching element (0-based)

Actions (default: click):
  click, fill, type, hover, focus, check, uncheck

Options:
  --name <name>        Filter role by accessible name
  --exact              Require exact text match

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser find role button click --name Submit
  stella-browser find text "Sign In" click
  stella-browser find label "Email" fill "user@example.com"
  stella-browser find placeholder "Search..." type "query"
  stella-browser find testid "login-form" click
  stella-browser find first "li.item" click
  stella-browser find nth 2 ".card" hover
"##
        }

        // === Mouse ===
        "mouse" => {
            r##"
stella-browser mouse - Low-level mouse operations

Usage: stella-browser mouse <subcommand> [args]

Performs low-level mouse operations for precise control.

Subcommands:
  move <x> <y>         Move mouse to coordinates
  down [button]        Press mouse button (left, right, middle)
  up [button]          Release mouse button
  wheel <dy> [dx]      Scroll mouse wheel

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser mouse move 100 200
  stella-browser mouse down
  stella-browser mouse up
  stella-browser mouse down right
  stella-browser mouse wheel 100
  stella-browser mouse wheel -50 0
"##
        }

        // === Set ===
        "set" => {
            r##"
stella-browser set - Configure browser settings

Usage: stella-browser set <setting> [args]

Configures various browser settings and emulation options.

Settings:
  viewport <w> <h>           Set viewport size
  device <name>              Emulate device (e.g., "iPhone 12")
  geo <lat> <lng>            Set geolocation
  offline [on|off]           Toggle offline mode
  headers <json>             Set extra HTTP headers
  credentials <user> <pass>  Set HTTP authentication
  media [dark|light]         Set color scheme preference
        [reduced-motion]     Enable reduced motion

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser set viewport 1920 1080
  stella-browser set device "iPhone 12"
  stella-browser set geo 37.7749 -122.4194
  stella-browser set offline on
  stella-browser set headers '{"X-Custom": "value"}'
  stella-browser set credentials admin secret123
  stella-browser set media dark
  stella-browser set media light reduced-motion
"##
        }

        // === Network ===
        "network" => {
            r##"
stella-browser network - Network interception and monitoring

Usage: stella-browser network <subcommand> [args]

Intercept, mock, or monitor network requests.

Subcommands:
  route <url> [options]      Intercept requests matching URL pattern
    --abort                  Abort matching requests
    --body <json>            Respond with custom body
  unroute [url]              Remove route (all if no URL)
  requests [options]         List captured requests
    --clear                  Clear request log
    --filter <pattern>       Filter by URL pattern

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser network route "**/api/*" --abort
  stella-browser network route "**/data.json" --body '{"mock": true}'
  stella-browser network unroute
  stella-browser network requests
  stella-browser network requests --filter "api"
  stella-browser network requests --clear
"##
        }

        // === Storage ===
        "storage" => {
            r##"
stella-browser storage - Manage web storage

Usage: stella-browser storage <type> [operation] [key] [value]

Manage localStorage and sessionStorage.

Types:
  local                localStorage
  session              sessionStorage

Operations:
  get [key]            Get all storage or specific key
  set <key> <value>    Set a key-value pair
  clear                Clear all storage

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser storage local
  stella-browser storage local get authToken
  stella-browser storage local set theme "dark"
  stella-browser storage local clear
  stella-browser storage session get userId
"##
        }

        // === Cookies ===
        "cookies" => {
            r##"
stella-browser cookies - Manage browser cookies

Usage: stella-browser cookies [operation] [args]

Manage browser cookies for the current context.

Operations:
  get                                Get all cookies (default)
  set <name> <value> [options]       Set a cookie with optional properties
  clear                              Clear all cookies

Cookie Set Options:
  --url <url>                        URL for the cookie (allows setting before page load)
  --domain <domain>                  Cookie domain (e.g., ".example.com")
  --path <path>                      Cookie path (e.g., "/api")
  --httpOnly                         Set HttpOnly flag (prevents JavaScript access)
  --secure                           Set Secure flag (HTTPS only)
  --sameSite <Strict|Lax|None>       SameSite policy
  --expires <timestamp>              Expiration time (Unix timestamp in seconds)

Note: If --url, --domain, and --path are all omitted, the cookie will be set
for the current page URL.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  # Simple cookie for current page
  stella-browser cookies set session_id "abc123"

  # Set cookie for a URL before loading it (useful for authentication)
  stella-browser cookies set session_id "abc123" --url https://app.example.com

  # Set secure, httpOnly cookie with domain and path
  stella-browser cookies set auth_token "xyz789" --domain example.com --path /api --httpOnly --secure

  # Set cookie with SameSite policy
  stella-browser cookies set tracking_consent "yes" --sameSite Strict

  # Set cookie with expiration (Unix timestamp)
  stella-browser cookies set temp_token "temp123" --expires 1735689600

  # Get all cookies
  stella-browser cookies

  # Clear all cookies
  stella-browser cookies clear
"##
        }

        // === Tabs ===
        "tab" => {
            r##"
stella-browser tab - Manage browser tabs

Usage: stella-browser tab [operation] [args]

Manage browser tabs in the current window.

Operations:
  list                 List all tabs (default)
  new [url]            Open new tab
  close [index]        Close tab (current if no index)
  <index>              Switch to tab by index

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser tab
  stella-browser tab list
  stella-browser tab new
  stella-browser tab new https://example.com
  stella-browser tab 2
  stella-browser tab close
  stella-browser tab close 1
"##
        }

        // === Window ===
        "window" => {
            r##"
stella-browser window - Manage browser windows

Usage: stella-browser window <operation>

Manage browser windows.

Operations:
  new                  Open new browser window

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser window new
"##
        }

        // === Frame ===
        "frame" => {
            r##"
stella-browser frame - Switch frame context

Usage: stella-browser frame <selector|main>

Switch to an iframe or back to the main frame.

Arguments:
  <selector>           CSS selector for iframe
  main                 Switch back to main frame

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser frame "#embed-iframe"
  stella-browser frame "iframe[name='content']"
  stella-browser frame main
"##
        }

        // === Dialog ===
        "dialog" => {
            r##"
stella-browser dialog - Handle browser dialogs

Usage: stella-browser dialog <response> [text]

Respond to browser dialogs (alert, confirm, prompt).

Operations:
  accept [text]        Accept dialog, optionally with prompt text
  dismiss              Dismiss/cancel dialog

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser dialog accept
  stella-browser dialog accept "my input"
  stella-browser dialog dismiss
"##
        }

        // === Trace ===
        "trace" => {
            r##"
stella-browser trace - Record execution trace

Usage: stella-browser trace <operation> [path]

Record a trace for debugging with Playwright Trace Viewer.

Operations:
  start [path]         Start recording trace
  stop [path]          Stop recording and save trace

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser trace start
  stella-browser trace start ./my-trace
  stella-browser trace stop
  stella-browser trace stop ./debug-trace.zip
"##
        }

        // === Record (video) ===
        "record" => {
            r##"
stella-browser record - Record browser session to video

Usage: stella-browser record start <path.webm> [url]
       stella-browser record stop
       stella-browser record restart <path.webm> [url]

Record the browser to a WebM video file using Playwright's native recording.
Creates a fresh browser context but preserves cookies and localStorage.
If no URL is provided, automatically navigates to your current page.

Operations:
  start <path> [url]     Start recording (defaults to current URL if omitted)
  stop                   Stop recording and save video
  restart <path> [url]   Stop current recording (if any) and start a new one

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  # Record from current page (preserves login state)
  stella-browser open https://app.example.com/dashboard
  stella-browser snapshot -i            # Explore and plan
  stella-browser record start ./demo.webm
  stella-browser click @e3              # Execute planned actions
  stella-browser record stop

  # Or specify a different URL
  stella-browser record start ./demo.webm https://example.com

  # Restart recording with a new file (stops previous, starts new)
  stella-browser record restart ./take2.webm
"##
        }

        // === Console/Errors ===
        "console" => {
            r##"
stella-browser console - View console logs

Usage: stella-browser console [--clear]

View browser console output (log, warn, error, info).

Options:
  --clear              Clear console log buffer

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser console
  stella-browser console --clear
"##
        }
        "errors" => {
            r##"
stella-browser errors - View page errors

Usage: stella-browser errors [--clear]

View JavaScript errors and uncaught exceptions.

Options:
  --clear              Clear error buffer

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser errors
  stella-browser errors --clear
"##
        }

        // === Highlight ===
        "highlight" => {
            r##"
stella-browser highlight - Highlight an element

Usage: stella-browser highlight <selector>

Visually highlights an element on the page for debugging.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser highlight "#target-element"
  stella-browser highlight @e5
"##
        }

        // === State ===
        "state" => {
            r##"
stella-browser state - Save/load browser state

Usage: stella-browser state <operation> <path>

Save or restore browser state (cookies, localStorage, sessionStorage).

Operations:
  save <path>          Save current state to file
  load <path>          Note: State must be loaded at browser launch via --state flag

Applying State:
  Use --state flag when launching browser to load saved state:
  stella-browser --state ./auth-state.json open https://example.com

  Or set STELLA_BROWSER_STATE environment variable.

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser state save ./auth-state.json
  stella-browser --state ./auth-state.json open https://example.com
"##
        }

        // === Session ===
        "session" => {
            r##"
stella-browser session - Manage sessions

Usage: stella-browser session [operation]

Manage isolated browser sessions. Each session has its own browser
instance with separate cookies, storage, and state.

Operations:
  (none)               Show current session name
  list                 List all active sessions

Environment:
  STELLA_BROWSER_SESSION    Default session name

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser session
  stella-browser session list
  stella-browser --session test open example.com
"##
        }

        // === Install ===
        "install" => {
            r##"
stella-browser install - Install browser binaries

Usage: stella-browser install [--with-deps]

Downloads and installs browser binaries required for automation.

Options:
  -d, --with-deps      Also install system dependencies (Linux only)

Examples:
  stella-browser install
  stella-browser install --with-deps
"##
        }

        // === Connect ===
        "connect" => {
            r##"
stella-browser connect - Connect to browser via CDP

Usage: stella-browser connect <port|url>

Connects to a running browser instance via Chrome DevTools Protocol (CDP).
This allows controlling browsers, Electron apps, or remote browser services.

Arguments:
  <port>               Local port number (e.g., 9222)
  <url>                Full WebSocket URL (ws://, wss://, http://, https://)

Supported URL formats:
  - Port number: 9222 (connects to http://localhost:9222)
  - WebSocket URL: ws://localhost:9222/devtools/browser/...
  - Remote service: wss://remote-browser.example.com/cdp?token=...

Global Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  # Connect to local Chrome with remote debugging
  # Start Chrome: google-chrome --remote-debugging-port=9222
  stella-browser connect 9222

  # Connect using WebSocket URL from /json/version endpoint
  stella-browser connect "ws://localhost:9222/devtools/browser/abc123"

  # Connect to remote browser service
  stella-browser connect "wss://browser-service.example.com/cdp?token=xyz"

  # After connecting, run commands normally
  stella-browser snapshot
  stella-browser click @e1
"##
        }

        // === iOS Commands ===
        "tap" => {
            r##"
stella-browser tap - Tap an element (touch gesture)

Usage: stella-browser tap <selector>

Taps an element. This is an alias for 'click' that provides semantic clarity
for touch-based interfaces like iOS Safari.

Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser tap "#submit-button"
  stella-browser tap @e1
  stella-browser -p ios tap "button:has-text('Sign In')"
"##
        }
        "swipe" => {
            r##"
stella-browser swipe - Swipe gesture (iOS)

Usage: stella-browser swipe <direction> [distance]

Performs a swipe gesture on iOS Safari. The direction determines
which way the content moves (swipe up scrolls down, etc.).

Arguments:
  direction    up, down, left, or right
  distance     Optional distance in pixels (default: 300)

Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser -p ios swipe up
  stella-browser -p ios swipe down 500
  stella-browser -p ios swipe left
"##
        }
        "device" => {
            r##"
stella-browser device - Manage iOS simulators

Usage: stella-browser device <subcommand>

Subcommands:
  list    List available iOS simulators

Options:
  --json               Output as JSON
  --session <name>     Use specific session

Examples:
  stella-browser device list
  stella-browser -p ios device list
"##
        }

        _ => return false,
    };
    println!("{}", help.trim());
    true
}

pub fn print_help() {
    println!(
        r#"
stella-browser - fast browser automation CLI for AI agents

Usage: stella-browser <command> [args] [options]

Core Commands:
  open <url>                 Navigate to URL
  click <sel>                Click element (or @ref)
  dblclick <sel>             Double-click element
  type <sel> <text>          Type into element
  fill <sel> <text>          Clear and fill
  press <key>                Press key (Enter, Tab, Control+a)
  hover <sel>                Hover element
  focus <sel>                Focus element
  check <sel>                Check checkbox
  uncheck <sel>              Uncheck checkbox
  select <sel> <val...>      Select dropdown option
  drag <src> <dst>           Drag and drop
  upload <sel> <files...>    Upload files
  download <sel> <path>      Download file by clicking element
  scroll <dir> [px]          Scroll (up/down/left/right)
  scrollintoview <sel>       Scroll element into view
  wait <sel|ms>              Wait for element or time
  screenshot [path]          Take screenshot
  pdf <path>                 Save as PDF
  snapshot                   Accessibility tree with refs (for AI)
  eval <js>                  Run JavaScript
  connect <port|url>         Connect to browser via CDP
  close                      Close browser

Navigation:
  back                       Go back
  forward                    Go forward
  reload                     Reload page

Get Info:  stella-browser get <what> [selector]
  text, html, value, attr <name>, title, url, count, box, styles

Check State:  stella-browser is <what> <selector>
  visible, enabled, checked

Find Elements:  stella-browser find <locator> <value> <action> [text]
  role, text, label, placeholder, alt, title, testid, first, last, nth

Mouse:  stella-browser mouse <action> [args]
  move <x> <y>, down [btn], up [btn], wheel <dy> [dx]

Browser Settings:  stella-browser set <setting> [value]
  viewport <w> <h>, device <name>, geo <lat> <lng>
  offline [on|off], headers <json>, credentials <user> <pass>
  media [dark|light] [reduced-motion]

Network:  stella-browser network <action>
  route <url> [--abort|--body <json>]
  unroute [url]
  requests [--clear] [--filter <pattern>]

Storage:
  cookies [get|set|clear]    Manage cookies (set supports --url, --domain, --path, --httpOnly, --secure, --sameSite, --expires)
  storage <local|session>    Manage web storage

Tabs:
  tab [new|list|close|<n>]   Manage tabs

Debug:
  trace start|stop [path]    Record trace
  record start <path> [url]  Start video recording (WebM)
  record stop                Stop and save video
  console [--clear]          View console logs
  errors [--clear]           View page errors
  highlight <sel>            Highlight element

Sessions:
  session                    Show current session name
  session list               List active sessions

Setup:
  install                    Install browser binaries
  install --with-deps        Also install system dependencies (Linux)

Snapshot Options:
  -i, --interactive          Only interactive elements
  -c, --compact              Remove empty structural elements
  -d, --depth <n>            Limit tree depth
  -s, --selector <sel>       Scope to CSS selector

Options:
  --session <name>           Isolated session (or STELLA_BROWSER_SESSION env)
  --profile <path>           Persistent browser profile (or STELLA_BROWSER_PROFILE env)
  --state <path>             Load storage state from JSON file (or STELLA_BROWSER_STATE env)
  --headers <json>           HTTP headers scoped to URL's origin (for auth)
  --executable-path <path>   Custom browser executable (or STELLA_BROWSER_EXECUTABLE_PATH)
  --extension <path>         Load browser extensions (repeatable)
  --args <args>              Browser launch args, comma or newline separated (or STELLA_BROWSER_ARGS)
                             e.g., --args "--no-sandbox,--disable-blink-features=AutomationControlled"
  --user-agent <ua>          Custom User-Agent (or STELLA_BROWSER_USER_AGENT)
  --proxy <server>           Proxy server URL (or STELLA_BROWSER_PROXY)
                             e.g., --proxy "http://user:pass@127.0.0.1:7890"
  --proxy-bypass <hosts>     Bypass proxy for these hosts (or STELLA_BROWSER_PROXY_BYPASS)
                             e.g., --proxy-bypass "localhost,*.internal.com"
  --ignore-https-errors      Ignore HTTPS certificate errors
  --allow-file-access        Allow file:// URLs to access local files (Chromium only)
  -p, --provider <name>      Browser provider: ios, browserbase, kernel, browseruse
  --device <name>            iOS device name (e.g., "iPhone 15 Pro")
  --json                     JSON output
  --full, -f                 Full page screenshot
  --headed                   Show browser window (not headless)
  --cdp <port>               Connect via CDP (Chrome DevTools Protocol)
  --debug                    Debug output
  --version, -V              Show version

Environment:
  STELLA_BROWSER_SESSION          Session name (default: "default")
  STELLA_BROWSER_EXECUTABLE_PATH  Custom browser executable path
  STELLA_BROWSER_PROVIDER         Browser provider (ios, browserbase, kernel, browseruse)
  STELLA_BROWSER_STREAM_PORT      Enable WebSocket streaming on port (e.g., 9223)
  STELLA_BROWSER_IOS_DEVICE       Default iOS device name
  STELLA_BROWSER_IOS_UDID         Default iOS device UDID

Examples:
  stella-browser open example.com
  stella-browser snapshot -i              # Interactive elements only
  stella-browser click @e2                # Click by ref from snapshot
  stella-browser fill @e3 "test@example.com"
  stella-browser find role button click --name Submit
  stella-browser get text @e1
  stella-browser screenshot --full
  stella-browser --cdp 9222 snapshot      # Connect via CDP port
  stella-browser --profile ~/.myapp open example.com  # Persistent profile

iOS Simulator (requires Xcode and Appium):
  stella-browser -p ios open example.com                    # Use default iPhone
  stella-browser -p ios --device "iPhone 15 Pro" open url   # Specific device
  stella-browser -p ios device list                         # List simulators
  stella-browser -p ios swipe up                            # Swipe gesture
  stella-browser -p ios tap @e1                             # Touch element
"#
    );
}

pub fn print_version() {
    println!("stella-browser {}", env!("CARGO_PKG_VERSION"));
}
