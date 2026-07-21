import { describe, expect, it } from "vitest";

import type { Tool, ToolCall } from "../../../../../runtime/ai/types.js";
import { convertTools as convertAnthropicTools } from "../../../../../runtime/ai/providers/anthropic.js";
import { validateToolArguments } from "../../../../../runtime/ai/utils/validation.js";
import { buildCodexThreadStartParams } from "../../../../../runtime/kernel/integrations/codex-agent-runtime.js";
import { createImageGenTool } from "../../../../../runtime/kernel/tools/defs/image-gen.js";
import { MAX_MANAGED_IMAGE_REFERENCE_ITEMS } from "../../../../../runtime/kernel/tools/managed-image-references.js";

const imageTool = createImageGenTool({});

const references = (pathCount: number, urlCount: number) => ({
  prompt: "render these references",
  referenceImagePaths: Array.from(
    { length: pathCount },
    (_, index) => `/tmp/reference-${index}.png`,
  ),
  referenceImageUrls: Array.from(
    { length: urlCount },
    (_, index) => `https://example.test/reference-${index}.png`,
  ),
});

const mixedOverflowPartitions = Array.from(
  { length: MAX_MANAGED_IMAGE_REFERENCE_ITEMS },
  (_, pathIndex) => pathIndex + 1,
).flatMap((pathCount) =>
  Array.from(
    { length: MAX_MANAGED_IMAGE_REFERENCE_ITEMS },
    (_, urlIndex) => urlIndex + 1,
  )
    .filter(
      (urlCount) => pathCount + urlCount > MAX_MANAGED_IMAGE_REFERENCE_ITEMS,
    )
    .map((urlCount) => [pathCount, urlCount] as const),
);

const validate = (
  tool: Pick<Tool, "name" | "description" | "parameters">,
  pathCount: number,
  urlCount: number,
) =>
  validateToolArguments(tool as Tool, {
    type: "toolCall",
    id: `image-${pathCount}-${urlCount}`,
    name: "image_gen",
    arguments: references(pathCount, urlCount),
  } satisfies ToolCall);

describe("image_gen advertised reference schema", () => {
  it("accepts every paths + URLs partition totaling zero through four", () => {
    for (
      let total = 0;
      total <= MAX_MANAGED_IMAGE_REFERENCE_ITEMS;
      total += 1
    ) {
      for (let pathCount = 0; pathCount <= total; pathCount += 1) {
        expect(() =>
          validate(imageTool, pathCount, total - pathCount),
        ).not.toThrow();
      }
    }
  });

  it.each(mixedOverflowPartitions)(
    "rejects mixed reference partition %i + %i",
    (pathCount, urlCount) => {
      expect(() => validate(imageTool, pathCount, urlCount)).toThrow(
        /Validation failed for tool "image_gen"/,
      );
    },
  );

  it("retains the per-array ceiling", () => {
    expect(() => validate(imageTool, 5, 0)).toThrow();
    expect(() => validate(imageTool, 0, 5)).toThrow();
  });

  it("survives native, Anthropic, and Codex schema serialization", () => {
    const serialized = JSON.parse(
      JSON.stringify(imageTool.parameters),
    ) as Record<string, unknown>;
    expect(() =>
      validate(
        { ...imageTool, parameters: serialized },
        MAX_MANAGED_IMAGE_REFERENCE_ITEMS,
        1,
      ),
    ).toThrow();

    const anthropicSchema = convertAnthropicTools(
      [imageTool as unknown as Tool],
      false,
      false,
    )[0]?.input_schema as Record<string, unknown>;
    const anthropicCompatibleSchema = structuredClone(serialized);
    delete anthropicCompatibleSchema.oneOf;
    delete anthropicCompatibleSchema.allOf;
    delete anthropicCompatibleSchema.anyOf;
    expect(anthropicSchema).toEqual(anthropicCompatibleSchema);
    expect(anthropicSchema).not.toHaveProperty("oneOf");
    expect(anthropicSchema).not.toHaveProperty("allOf");
    expect(anthropicSchema).not.toHaveProperty("anyOf");
    expect(() =>
      validate({ ...imageTool, parameters: anthropicSchema }, 5, 0),
    ).toThrow();

    const dynamicTool = buildCodexThreadStartParams({
      model: "gpt-5.4",
      tools: [imageTool],
    }).dynamicTools?.[0];
    expect(dynamicTool?.name).toBe("image_gen");
    expect(dynamicTool?.inputSchema).toEqual(serialized);
    expect(() =>
      validate(
        {
          name: dynamicTool!.name,
          description: dynamicTool!.description,
          parameters: dynamicTool!.inputSchema,
        },
        2,
        3,
      ),
    ).toThrow();
  });
});
