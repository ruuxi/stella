import { CodeBlock } from "@/components/code-block";

export default function QuickStart() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="prose">
        <h1>Quick Start</h1>

        <h2>Core workflow</h2>
        <p>Every browser automation follows this pattern:</p>
        <CodeBlock code={`# 1. Navigate
stella-browser open example.com

# 2. Snapshot to get element refs
stella-browser snapshot -i
# Output:
# @e1 [heading] "Example Domain"
# @e2 [link] "More information..."

# 3. Interact using refs
stella-browser click @e2

# 4. Re-snapshot after page changes
stella-browser snapshot -i`} />

        <h2>Common commands</h2>
        <CodeBlock code={`stella-browser open example.com
stella-browser snapshot -i                # Get interactive elements with refs
stella-browser click @e2                  # Click by ref
stella-browser fill @e3 "test@example.com" # Fill input by ref
stella-browser get text @e1               # Get text content
stella-browser screenshot                 # Save to temp directory
stella-browser screenshot page.png        # Save to specific path
stella-browser close`} />

        <h2>Traditional selectors</h2>
        <p>CSS selectors and semantic locators also supported:</p>
        <CodeBlock code={`stella-browser click "#submit"
stella-browser fill "#email" "test@example.com"
stella-browser find role button click --name "Submit"`} />

        <h2>Headed mode</h2>
        <p>Show browser window for debugging:</p>
        <CodeBlock code="stella-browser open example.com --headed" />

        <h2>Wait for content</h2>
        <CodeBlock code={`stella-browser wait @e1                   # Wait for element
stella-browser wait --load networkidle    # Wait for network idle
stella-browser wait --url "**/dashboard"  # Wait for URL pattern
stella-browser wait 2000                  # Wait milliseconds`} />

        <h2>JSON output</h2>
        <p>For programmatic parsing in scripts:</p>
        <CodeBlock code={`stella-browser snapshot --json
stella-browser get text @e1 --json`} />
        <p>
          Note: The default text output is more compact and preferred for AI agents.
        </p>
      </div>
    </div>
  );
}
