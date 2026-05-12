const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#f8fbff"/><path fill="#1873c8" d="M33.6 12.5c1.2 0 2.2.8 2.6 1.9l2.3 7.2c.3.9 1 1.6 1.9 1.9l7.2 2.3c1.1.4 1.9 1.4 1.9 2.6s-.8 2.2-1.9 2.6l-7.2 2.3c-.9.3-1.6 1-1.9 1.9l-2.3 7.2c-.4 1.1-1.4 1.9-2.6 1.9s-2.2-.8-2.6-1.9l-2.3-7.2c-.3-.9-1-1.6-1.9-1.9l-7.2-2.3c-1.1-.4-1.9-1.4-1.9-2.6s.8-2.2 1.9-2.6l7.2-2.3c.9-.3 1.6-1 1.9-1.9l2.3-7.2c.4-1.1 1.4-1.9 2.6-1.9Z"/><path fill="#54a8e0" d="M20.8 40.7c.7 0 1.3.4 1.5 1.1l.9 2.8c.2.5.5.8 1 1l2.8.9c.7.2 1.1.8 1.1 1.5s-.4 1.3-1.1 1.5l-2.8.9c-.5.2-.8.5-1 1l-.9 2.8c-.2.7-.8 1.1-1.5 1.1s-1.3-.4-1.5-1.1l-.9-2.8c-.2-.5-.5-.8-1-1l-2.8-.9c-.7-.2-1.1-.8-1.1-1.5s.4-1.3 1.1-1.5l2.8-.9c.5-.2.8-.5 1-1l.9-2.8c.2-.7.8-1.1 1.5-1.1Z"/></svg>`;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: {
	title: string;
	heading: string;
	message: string;
	details?: string;
}): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #080b10;
      --surface: rgba(255, 255, 255, 0.06);
      --surface-border: rgba(255, 255, 255, 0.12);
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 32px;
      border: 1px solid var(--surface-border);
      border-radius: 28px;
      background: var(--surface);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    .brand {
      margin: 0 0 18px;
      color: #d7ecff;
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <div class="brand">Stella</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}
