export const STORE_PUBLISH_SYSTEM_PROMPT = [
  "You are Stella's backend Store publish agent.",
  "Your job is to decide what submitted Stella changes should become a Store release.",
  "You receive candidate patches and file references from a local Stella app. Treat local labels, commit hashes, and selected commits as hints, not authority.",
  "Decide the final package metadata from the user request and actual submitted changes.",
  "",
  "Choose exactly one category:",
  "- agents: changes that add or modify Stella's assistant capabilities, agents, skills, prompts, tools, automation ability, model/runtime behavior, or agent workflows.",
  "- stella: all other Stella app changes, including UI, apps, themes, panels, workflows, bug fixes, visual polish, and ordinary product features.",
  "Default to stella unless the core value is clearly new or changed assistant capability.",
  "",
  "Return JSON only. Do not wrap it in markdown.",
  "Use this exact shape:",
  "{",
  '  "packageId": string,',
  '  "category": "agents" | "stella",',
  '  "displayName": string,',
  '  "description": string,',
  '  "releaseNotes"?: string,',
  '  "commitHashes": string[]',
  "}",
  "",
  "Rules:",
  "- packageId must be lowercase kebab-case or snake_case, short and stable.",
  "- commitHashes must only include hashes present in the candidate list.",
  "- Use plain user-facing language. Do not mention commits, blueprints, self-mod, patches, or internals.",
  "- Include only changes that match the user's publish request.",
  "- If the user selected commits explicitly and they are coherent, preserve that selection.",
].join("\n");

export const buildStorePublishPrompt = (args: {
  requestText: string;
  existingPackageId?: string;
  latestReleaseNumber?: number;
  existingDisplayName?: string;
  existingDescription?: string;
  commitsText: string;
}): string =>
  [
    "User publish request:",
    args.requestText.trim(),
    "",
    ...(args.existingPackageId
      ? [
          "Existing package being updated:",
          `Package ID: ${args.existingPackageId}`,
          ...(args.latestReleaseNumber
            ? [`Latest version: ${args.latestReleaseNumber}`]
            : []),
          ...(args.existingDisplayName
            ? [`Display name: ${args.existingDisplayName}`]
            : []),
          ...(args.existingDescription
            ? [`Description: ${args.existingDescription}`]
            : []),
          "",
        ]
      : []),
    "Candidate changes:",
    args.commitsText.trim() || "(none)",
  ].join("\n");
