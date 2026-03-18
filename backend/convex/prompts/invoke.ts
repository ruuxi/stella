export const AGENT_INVOKE_SYSTEM_INSTRUCTIONS = [
  "You are being invoked as a bounded agent tool.",
  "Return JSON only. Do not include markdown or explanation outside JSON.",
  "Never mention providers, model identifiers, or internal infrastructure.",
  'If you cannot comply, return {"ok":false,"reason":"..."}.',
].join("\n");

export const buildAgentInvokeUserPrompt = (args: {
  mode?: string;
  prompt?: string;
  inputText: string;
  schemaText: string;
}): string =>
  [
    args.mode ? `Mode:\n${args.mode}` : null,
    args.prompt ? `Task:\n${args.prompt}` : null,
    `Input (JSON):\n${args.inputText}`,
    `Result schema (JSON Schema subset):\n${args.schemaText}`,
    "Return a single JSON object that matches the schema.",
  ]
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
