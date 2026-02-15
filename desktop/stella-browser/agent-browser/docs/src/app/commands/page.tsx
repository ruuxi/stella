import { CodeBlock } from "@/components/code-block";

export default function Commands() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="prose">
        <h1>Commands</h1>

        <h2>Core</h2>
        <CodeBlock code={`stella-browser open <url>              # Navigate (aliases: goto, navigate)
stella-browser click <sel>             # Click element
stella-browser dblclick <sel>          # Double-click
stella-browser fill <sel> <text>       # Clear and fill
stella-browser type <sel> <text>       # Type into element
stella-browser press <key>             # Press key (Enter, Tab, Control+a)
stella-browser hover <sel>             # Hover element
stella-browser select <sel> <val>      # Select dropdown option
stella-browser check <sel>             # Check checkbox
stella-browser uncheck <sel>           # Uncheck checkbox
stella-browser scroll <dir> [px]       # Scroll (up/down/left/right)
stella-browser screenshot [path]       # Screenshot (--full for full page)
stella-browser snapshot                # Accessibility tree with refs
stella-browser eval <js>               # Run JavaScript
stella-browser close                   # Close browser`} />

        <h2>Get info</h2>
        <CodeBlock code={`stella-browser get text <sel>          # Get text content
stella-browser get html <sel>          # Get innerHTML
stella-browser get value <sel>         # Get input value
stella-browser get attr <sel> <attr>   # Get attribute
stella-browser get title               # Get page title
stella-browser get url                 # Get current URL
stella-browser get count <sel>         # Count matching elements
stella-browser get box <sel>           # Get bounding box`} />

        <h2>Check state</h2>
        <CodeBlock code={`stella-browser is visible <sel>        # Check if visible
stella-browser is enabled <sel>        # Check if enabled
stella-browser is checked <sel>        # Check if checked`} />

        <h2>Find elements</h2>
        <p>Semantic locators with actions (<code>click</code>, <code>fill</code>, <code>check</code>, <code>hover</code>, <code>text</code>):</p>
        <CodeBlock code={`stella-browser find role <role> <action> [value]
stella-browser find text <text> <action>
stella-browser find label <label> <action> [value]
stella-browser find placeholder <ph> <action> [value]
stella-browser find testid <id> <action> [value]
stella-browser find first <sel> <action> [value]
stella-browser find nth <n> <sel> <action> [value]`} />
        <p>Examples:</p>
        <CodeBlock code={`stella-browser find role button click --name "Submit"
stella-browser find label "Email" fill "test@test.com"
stella-browser find first ".item" click`} />

        <h2>Wait</h2>
        <CodeBlock code={`stella-browser wait <selector>         # Wait for element
stella-browser wait <ms>               # Wait for time
stella-browser wait --text "Welcome"   # Wait for text
stella-browser wait --url "**/dash"    # Wait for URL pattern
stella-browser wait --load networkidle # Wait for load state
stella-browser wait --fn "condition"   # Wait for JS condition
stella-browser wait --download [path]  # Wait for download`} />

        <h2>Downloads</h2>
        <CodeBlock code={`stella-browser download <sel> <path>   # Click element to trigger download
stella-browser wait --download [path]  # Wait for any download to complete`} />

        <h2>Mouse</h2>
        <CodeBlock code={`stella-browser mouse move <x> <y>      # Move mouse
stella-browser mouse down [button]     # Press button
stella-browser mouse up [button]       # Release button
stella-browser mouse wheel <dy> [dx]   # Scroll wheel`} />

        <h2>Settings</h2>
        <CodeBlock code={`stella-browser set viewport <w> <h>    # Set viewport size
stella-browser set device <name>       # Emulate device ("iPhone 14")
stella-browser set geo <lat> <lng>     # Set geolocation
stella-browser set offline [on|off]    # Toggle offline mode
stella-browser set headers <json>      # Extra HTTP headers
stella-browser set credentials <u> <p> # HTTP basic auth
stella-browser set media [dark|light]  # Emulate color scheme`} />

        <h2>Cookies & storage</h2>
        <CodeBlock code={`stella-browser cookies                 # Get all cookies
stella-browser cookies set <name> <val> # Set cookie
stella-browser cookies clear           # Clear cookies

stella-browser storage local           # Get all localStorage
stella-browser storage local <key>     # Get specific key
stella-browser storage local set <k> <v>  # Set value
stella-browser storage local clear     # Clear all

stella-browser storage session         # Same for sessionStorage`} />

        <h2>Network</h2>
        <CodeBlock code={`stella-browser network route <url>              # Intercept requests
stella-browser network route <url> --abort      # Block requests
stella-browser network route <url> --body <json>  # Mock response
stella-browser network unroute [url]            # Remove routes
stella-browser network requests                 # View tracked requests`} />

        <h2>Tabs & frames</h2>
        <CodeBlock code={`stella-browser tab                     # List tabs
stella-browser tab new [url]           # New tab
stella-browser tab <n>                 # Switch to tab
stella-browser tab close [n]           # Close tab
stella-browser frame <sel>             # Switch to iframe
stella-browser frame main              # Back to main frame`} />

        <h2>Debug</h2>
        <CodeBlock code={`stella-browser trace start [path]      # Start trace
stella-browser trace stop [path]       # Stop and save trace
stella-browser console                 # View console messages
stella-browser errors                  # View page errors
stella-browser highlight <sel>         # Highlight element
stella-browser state save <path>       # Save auth state
stella-browser state load <path>       # Load auth state`} />

        <h2>Navigation</h2>
        <CodeBlock code={`stella-browser back                    # Go back
stella-browser forward                 # Go forward
stella-browser reload                  # Reload page`} />

        <h2>Global options</h2>
        <CodeBlock code={`--session <name>         # Isolated browser session
--profile <path>         # Persistent browser profile directory
--headed                 # Show browser window (not headless)
--cdp <port>             # Connect via Chrome DevTools Protocol
--executable-path <path> # Custom browser executable
--args <args>            # Browser launch args (comma separated)
--user-agent <ua>        # Custom User-Agent string
--proxy <url>            # Proxy server URL
--headers <json>         # HTTP headers scoped to URL's origin
--ignore-https-errors    # Ignore HTTPS certificate errors
--allow-file-access      # Allow file:// URLs to access local files (Chromium only)
--json                   # JSON output (for scripts)
--debug                  # Debug output`} />

        <h2>Local files</h2>
        <p>Open local files (PDFs, HTML) using <code>file://</code> URLs:</p>
        <CodeBlock code={`stella-browser --allow-file-access open file:///path/to/document.pdf
stella-browser --allow-file-access open file:///path/to/page.html
stella-browser screenshot output.png`} />
        <p>
          The <code>--allow-file-access</code> flag enables JavaScript to access other local files. Chromium only.
        </p>
      </div>
    </div>
  );
}
