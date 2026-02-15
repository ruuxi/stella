import { CodeBlock } from "@/components/code-block";

export default function Selectors() {
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="prose">
        <h1>Selectors</h1>

        <h2>Refs (recommended)</h2>
        <p>
          Refs provide deterministic element selection from snapshots. Best for AI agents.
        </p>
        <CodeBlock code={`# 1. Get snapshot with refs
stella-browser snapshot
# Output:
# - heading "Example Domain" [ref=e1] [level=1]
# - button "Submit" [ref=e2]
# - textbox "Email" [ref=e3]
# - link "Learn more" [ref=e4]

# 2. Use refs to interact
stella-browser click @e2                   # Click the button
stella-browser fill @e3 "test@example.com" # Fill the textbox
stella-browser get text @e1                # Get heading text
stella-browser hover @e4                   # Hover the link`} />

        <h3>Why refs?</h3>
        <ul>
          <li><strong>Deterministic</strong> - Ref points to exact element from snapshot</li>
          <li><strong>Fast</strong> - No DOM re-query needed</li>
          <li><strong>AI-friendly</strong> - LLMs can reliably parse and use refs</li>
        </ul>

        <h2>CSS selectors</h2>
        <CodeBlock code={`stella-browser click "#id"
stella-browser click ".class"
stella-browser click "div > button"
stella-browser click "[data-testid='submit']"`} />

        <h2>Text & XPath</h2>
        <CodeBlock code={`stella-browser click "text=Submit"
stella-browser click "xpath=//button[@type='submit']"`} />

        <h2>Semantic locators</h2>
        <p>Find elements by role, label, or other semantic properties:</p>
        <CodeBlock code={`stella-browser find role button click --name "Submit"
stella-browser find label "Email" fill "test@test.com"
stella-browser find placeholder "Search..." fill "query"
stella-browser find testid "submit-btn" click`} />
      </div>
    </div>
  );
}
