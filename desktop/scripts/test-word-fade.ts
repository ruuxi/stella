/**
 * Streaming word-fade plugin verification harness.
 *
 * Reproduces the desktop chat's markdown pipeline (remark-parse →
 * remark-gfm → remark-rehype → rehype-raw → rehype-sanitize →
 * rehype-harden → rehype-word-fade) and feeds it accumulating slices
 * of test markdown as if a stream were arriving over the wire. For
 * each tick it extracts every `<span data-stella-word-fade>` from the
 * HAST and classifies it against the prior tick:
 *
 *   case 1: same (bufferStart, parentPath) signature as prior tick
 *     → existing DOM span continuing. MUST have no inline style.
 *
 *   case 2: signature is new this tick, but the span's text appears
 *     as a substring of the prior tick's prose
 *     → fresh DOM mount of previously-visible content (markdown
 *     reshape moved the span). MUST have `--stella-word-fade-
 *     duration:0ms`.
 *
 *   case 3: signature is new, text not in prior prose
 *     → genuinely new span. MUST have no inline style.
 *
 * Violations of those invariants are exactly the "flash" bug we
 * shipped fixes for, so the harness fails loudly when one is found.
 *
 * Fixture modes:
 *   - Local: hand-written strings exercising every markdown reshape
 *     (emphasis, links, inline code, lists, headings, tables, nested
 *     emphasis, code spans, etc.). Replays them word-by-word and
 *     character-by-character.
 *   - Live (optional): if `OPENROUTER_API_KEY` is set in the env,
 *     streams a real assistant response from `openai/gpt-5.5` and
 *     replays the actual chunk boundaries the runtime would see.
 *
 * Usage:
 *   bun desktop/scripts/test-word-fade.ts            # local fixtures
 *   bun desktop/scripts/test-word-fade.ts --live     # adds OpenRouter
 *   bun desktop/scripts/test-word-fade.ts --verbose  # logs every tick
 *
 * No mutation of repo files — the harness is read-only and intended
 * to be deleted after the streaming fade is confirmed stable.
 */
import process from "node:process";
import type { Element, Root, RootContent } from "hast";
import { harden } from "rehype-harden";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remend from "remend";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { rehypeWordFade } from "../src/app/chat/rehype-word-fade";

const VERBOSE = process.argv.includes("--verbose");
const LIVE = process.argv.includes("--live");

type EmittedSpan = {
  signature: string;
  parentPath: string;
  content: string;
  start: number;
  end: number;
  instant: boolean;
};

type TickReport = {
  tick: number;
  textLength: number;
  spans: EmittedSpan[];
};

type Violation = {
  fixture: string;
  tick: number;
  textPreview: string;
  kind: "case1-with-style" | "case2-without-style" | "case3-with-style";
  span: EmittedSpan;
  reason: string;
};

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "data*",
      "style",
    ],
    span: [
      ...((defaultSchema.attributes?.span as unknown[]) ?? []),
      "dataStellaWordFade",
      "style",
    ],
  },
} as const;

/**
 * Build the unified pipeline with the same shape as `Markdown.tsx`:
 * Streamdown internally runs remend → remark-parse → remark-gfm →
 * remark-rehype → rehype-raw → rehype-sanitize → rehype-harden →
 * rehypeWordFade. We compile one fresh pipeline per call so each tick
 * gets a clean HAST (matching how React/Streamdown re-parse every
 * stream tick).
 */
const buildProcessor = (cacheKey: string) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remend)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(harden, {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["*"],
      defaultOrigin: undefined,
      allowDataImages: true,
    })
    /*
     * `rehypeWordFade(options)` is a transformer (the already-applied
     * inner function), so wrap it in a 1-arg factory for unified.
     * Streamdown's `rehypePlugins` prop accepts the pre-applied form,
     * but unified's `.use()` always evaluates the plugin function with
     * the processor as `this`, which would otherwise execute the
     * transformer at freeze time against `undefined`.
     */
    .use(() => rehypeWordFade({ cacheKey }));

/**
 * Pull every `<span data-stella-word-fade>` out of the HAST,
 * reconstructing each span's (bufferStart, parentPath) signature so
 * the harness can match the plugin's own internal accounting without
 * importing its private state.
 */
const collectSpans = (root: Root): EmittedSpan[] => {
  const out: EmittedSpan[] = [];

  // Walk by hand so we can track parentPath and cumulative prose
  // position the same way the plugin does.
  const skipTags = new Set([
    "code",
    "pre",
    "math",
    "style",
    "script",
    "noscript",
    "svg",
  ]);
  const skipClassPrefixes = ["katex", "language-mermaid"];
  const isSkippable = (el: Element): boolean => {
    if (skipTags.has(el.tagName.toLowerCase())) return true;
    const props = (el.properties ?? {}) as Record<string, unknown>;
    if (props["dataStreamdown"] !== undefined) return true;
    const className = props.className;
    if (Array.isArray(className)) {
      for (const c of className) {
        if (typeof c !== "string") continue;
        for (const p of skipClassPrefixes) {
          if (c === p || c.startsWith(`${p}-`)) return true;
        }
      }
    }
    return false;
  };

  let position = 0;

  const walk = (
    nodes: RootContent[],
    path: string,
    parent: Root | Element,
  ) => {
    nodes.forEach((node, index) => {
      if (node.type === "element") {
        const el = node as Element;
        if (isSkippable(el)) return;
        const props = (el.properties ?? {}) as Record<string, unknown>;
        const isFadeSpan =
          el.tagName === "span" &&
          (props["data-stella-word-fade"] !== undefined ||
            props["dataStellaWordFade"] !== undefined);
        if (isFadeSpan) {
          // Span content is its single text child.
          const text = (el.children?.[0] as { value?: string })?.value ?? "";
          // bufferStart is the cumulative prose position BEFORE this
          // span's text. We accumulate as we walk, matching the
          // plugin's cursor.
          const bufferStart = position;
          const signature = `${bufferStart}|${path}`;
          const styleValue = props.style;
          const styleStr =
            typeof styleValue === "string" ? styleValue : "";
          const instant = /--stella-word-fade-duration\s*:\s*0ms/i.test(
            styleStr,
          );
          const end = bufferStart + text.length;
          out.push({
            signature,
            parentPath: path,
            content: text,
            start: bufferStart,
            end,
            instant,
          });
          position = end;
          return;
        }
        const nextPath = path
          ? `${path}>${index}:${el.tagName}`
          : `${index}:${el.tagName}`;
        walk((el.children ?? []) as RootContent[], nextPath, el);
      } else if (node.type === "text") {
        position += (node as { value: string }).value.length;
      }
    });
  };

  walk(root.children as RootContent[], "", root);
  return out;
};

const summarizeText = (text: string, limit = 60): string => {
  const flat = text.replace(/\n/g, "\\n");
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…(${flat.length} chars)`;
};

const runStream = (
  fixture: string,
  ticks: string[],
): { reports: TickReport[]; violations: Violation[] } => {
  const cacheKey = `harness-${fixture}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const reports: TickReport[] = [];
  const violations: Violation[] = [];
  let priorReport: TickReport | null = null;

  ticks.forEach((text, tickIndex) => {
    const processor = buildProcessor(cacheKey);
    const tree = processor.runSync(processor.parse(text)) as Root;
    const spans = collectSpans(tree);
    const report: TickReport = {
      tick: tickIndex,
      textLength: text.length,
      spans,
    };
    reports.push(report);

    if (priorReport) {
      const priorSigs = new Set(priorReport.spans.map((s) => s.signature));
      const priorRanges = priorReport.spans.map((s) => ({
        start: s.start,
        end: s.end,
      }));
      const insidePriorRange = (start: number): boolean => {
        for (const r of priorRanges) {
          if (start >= r.start && start < r.end) return true;
        }
        return false;
      };
      for (const span of spans) {
        const isSameSpan = priorSigs.has(span.signature);
        const wasInsidePriorSpan = !isSameSpan && insidePriorRange(span.start);

        if (isSameSpan && span.instant) {
          violations.push({
            fixture,
            tick: tickIndex,
            textPreview: summarizeText(text),
            kind: "case1-with-style",
            span,
            reason:
              "existing span signature carried over from prior tick but received --stella-word-fade-duration:0ms; mid-flight inline-style change truncates the live 600ms fade",
          });
        }
        if (!isSameSpan && wasInsidePriorSpan && !span.instant) {
          violations.push({
            fixture,
            tick: tickIndex,
            textPreview: summarizeText(text),
            kind: "case2-without-style",
            span,
            reason:
              "fresh-mount span whose source-text start position was inside a prior span (markdown reshape) is missing the 0ms duration stamp — will replay the 600ms fade on remount",
          });
        }
        if (!isSameSpan && !wasInsidePriorSpan && span.instant) {
          violations.push({
            fixture,
            tick: tickIndex,
            textPreview: summarizeText(text),
            kind: "case3-with-style",
            span,
            reason:
              "fresh-mount span at a position outside every prior span — that's genuinely new tail content and MUST NOT have the instant stamp, otherwise it freezes at opacity:1 on first mount and never fades",
          });
        }
      }
    }

    // Detect fresh case-2 emits (instant-stamped this tick) so we
    // can scrutinize whether the substring-match heuristic that
    // gives the plugin its "this was visible last tick" signal might
    // be over-firing on genuinely-new content (e.g. common short
    // words appearing twice).
    if (priorReport && VERBOSE) {
      const priorSigs = new Set(priorReport.spans.map((s) => s.signature));
      for (const span of spans) {
        if (priorSigs.has(span.signature)) continue;
        if (span.instant) {
          console.log(
            `      case-2 stamp: content="${summarizeText(span.content, 32)}" path="${span.parentPath}"`,
          );
        }
      }
    }
    if (VERBOSE) {
      const continuing = priorReport
        ? spans.filter((s) =>
            priorReport!.spans.some((p) => p.signature === s.signature),
          ).length
        : 0;
      const fresh = spans.length - continuing;
      const instantCount = spans.filter((s) => s.instant).length;
      // Detect any span whose content was visible last tick but whose
      // signature doesn't match — i.e. a reshape that the plugin did
      // notice (case 2). Also detect signature DROPS — a span that
      // existed last tick but isn't there this tick (which would
      // unmount the DOM node entirely, with the next render mounting
      // a fresh node and replaying the fade if its content is new).
      const droppedSigs = priorReport
        ? priorReport.spans.filter(
            (p) => !spans.some((s) => s.signature === p.signature),
          )
        : [];
      const detail =
        droppedSigs.length > 0
          ? ` dropped=${droppedSigs.length}{${droppedSigs.map((d) => summarizeText(d.content, 16)).join(",")}}`
          : "";
      console.log(
        `  tick=${String(tickIndex).padStart(3, "0")} len=${text.length.toString().padStart(4, " ")} spans=${spans.length} continuing=${continuing} fresh=${fresh} instant=${instantCount}${detail} preview="${summarizeText(text, 50)}"`,
      );
    }

    priorReport = report;
  });

  return { reports, violations };
};

const buildIncrementalTicks = (
  full: string,
  step: "char" | "word",
): string[] => {
  const ticks: string[] = [];
  if (step === "char") {
    for (let i = 1; i <= full.length; i++) ticks.push(full.slice(0, i));
    return ticks;
  }
  const tokens: string[] = [];
  const re = /\s+|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full)) !== null) tokens.push(m[0]);
  let acc = "";
  for (const tok of tokens) {
    acc += tok;
    ticks.push(acc);
  }
  return ticks;
};

type Fixture = {
  name: string;
  body: string;
  step: "char" | "word";
};

/**
 * Each fixture is hand-picked to exercise a specific markdown reshape
 * moment that previously caused the flash bug: the opening token is
 * ambiguous until a later character arrives, at which point Streamdown
 * re-parses and moves the affected text into a different parent
 * element (the markdown reshape).
 */
const FIXTURES: Fixture[] = [
  {
    name: "plain-prose-word",
    body:
      "Hello, this is a streaming assistant message that should fade in word by word as it lands across multiple paragraphs.",
    step: "word",
  },
  {
    name: "plain-prose-char",
    body:
      "Hello, this is a streaming assistant message that should fade in word by word as it lands across multiple paragraphs.",
    step: "char",
  },
  {
    name: "emphasis-reshape",
    body:
      "Look at this *very important phrase* in the middle of a longer sentence with more text after the closing.",
    step: "char",
  },
  {
    name: "bold-reshape",
    body:
      "Pay attention to **this bold callout phrase** which spans several words before continuing.",
    step: "char",
  },
  {
    name: "link-reshape",
    body:
      "Click [the documentation link](https://example.com/docs) to learn more about the feature in question.",
    step: "char",
  },
  {
    name: "inline-code-reshape",
    body:
      "Run the command `bun run dev` from the repo root before testing the change in your local environment.",
    step: "char",
  },
  {
    name: "ordered-list-reshape",
    body: "Steps:\n1. First step here\n2. Second step there\n3. Third final step",
    step: "char",
  },
  {
    name: "heading-then-prose",
    body:
      "# Streaming markdown test\n\nThis section demonstrates a heading emerging mid stream followed by prose.",
    step: "char",
  },
  {
    name: "nested-emphasis",
    body:
      "It is *really **very** important* to handle nested emphasis correctly during streaming reshapes.",
    step: "char",
  },
  {
    name: "table-reshape",
    body:
      "Here is a small table:\n\n| Col A | Col B |\n|-------|-------|\n| one   | two   |\n| three | four  |\n\nAnd some prose after.",
    step: "char",
  },
  {
    name: "mixed-runaway",
    body:
      "Real streams interleave **bold spans**, _emphasis_, `inline code`, [links](https://stella.sh), and prose like this paragraph — sometimes back to back, sometimes broken across newlines.\n\nA second paragraph keeps the reshape pressure on.",
    step: "char",
  },
];

const runFixture = (fixture: Fixture) => {
  const ticks = buildIncrementalTicks(fixture.body, fixture.step);
  console.log(
    `\n▶ ${fixture.name} (${fixture.step}, ${ticks.length} ticks, ${fixture.body.length} chars)`,
  );
  const { reports, violations } = runStream(fixture.name, ticks);
  const lastSpanCount = reports.at(-1)?.spans.length ?? 0;
  const totalInstant = reports.reduce(
    (acc, r) => acc + r.spans.filter((s) => s.instant).length,
    0,
  );
  const totalSpans = reports.reduce((acc, r) => acc + r.spans.length, 0);
  console.log(
    `  final spans=${lastSpanCount} total-span-emits=${totalSpans} instant-stamps=${totalInstant}`,
  );

  if (violations.length === 0) {
    console.log(`  ✓ no invariant violations`);
  } else {
    console.log(`  ✗ ${violations.length} violation(s):`);
    for (const v of violations) {
      console.log(
        `     tick=${v.tick} kind=${v.kind} content="${summarizeText(v.span.content, 40)}" path="${v.span.parentPath}"`,
      );
      console.log(`        reason: ${v.reason}`);
    }
  }
  return violations;
};

const runLiveStream = async (): Promise<Violation[]> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log(
      "\nlive: OPENROUTER_API_KEY not set; skipping live OpenRouter stream",
    );
    return [];
  }
  console.log("\n▶ live OpenRouter stream (openai/gpt-5.5)");

  const prompt =
    "Write 3 short paragraphs about how to test a streaming markdown renderer. Use **bold**, *emphasis*, an [inline link](https://example.com), `inline code`, and an ordered list of 3 items. Keep it under 250 words.";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://stella.sh",
      "X-OpenRouter-Title": "Stella word-fade harness",
    },
    body: JSON.stringify({
      model: "openai/gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    console.log(`  live: HTTP ${res.status} — ${txt.slice(0, 200)}`);
    return [];
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const ticks: string[] = [];
  let acc = "";
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = json.choices?.[0]?.delta?.content ?? "";
        if (!chunk) continue;
        acc += chunk;
        ticks.push(acc);
      } catch {
        // OpenRouter occasionally interleaves comments / keep-alives.
      }
    }
  }
  console.log(
    `  live: ${ticks.length} chunk(s), ${acc.length} chars total`,
  );
  if (VERBOSE) {
    console.log(`  --- assistant response begin ---`);
    console.log(acc);
    console.log(`  --- assistant response end ---`);
  }
  const { violations } = runStream("live-openrouter", ticks);
  if (violations.length === 0) {
    console.log(`  ✓ no invariant violations`);
  } else {
    console.log(`  ✗ ${violations.length} violation(s):`);
    for (const v of violations.slice(0, 20)) {
      console.log(
        `     tick=${v.tick} kind=${v.kind} content="${summarizeText(v.span.content, 40)}"`,
      );
      console.log(`        reason: ${v.reason}`);
    }
    if (violations.length > 20) {
      console.log(`     …and ${violations.length - 20} more`);
    }
  }
  return violations;
};

const main = async () => {
  console.log(
    "Streaming word-fade plugin harness — replays markdown reshapes through the same pipeline the chat renderer uses and asserts the per-span classification invariants.\n",
  );
  let totalViolations = 0;
  for (const fixture of FIXTURES) {
    const violations = runFixture(fixture);
    totalViolations += violations.length;
  }
  if (LIVE) {
    const liveViolations = await runLiveStream();
    totalViolations += liveViolations.length;
  } else {
    console.log("\n(skip --live: pass --live to also stream from OpenRouter)");
  }
  console.log(
    `\n${totalViolations === 0 ? "✓ all fixtures passed" : `✗ ${totalViolations} total violation(s)`}`,
  );
  process.exit(totalViolations === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
