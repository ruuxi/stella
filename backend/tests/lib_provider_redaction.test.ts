import { describe, test, expect } from "bun:test";
import { scrubProviderTerms, scrubValue } from "../convex/lib/provider_redaction";

describe("scrubProviderTerms", () => {
  test("replaces provider names", () => {
    expect(scrubProviderTerms("Using OpenAI for inference")).not.toContain("OpenAI");
    expect(scrubProviderTerms("Anthropic Claude model")).not.toContain("Anthropic");
    expect(scrubProviderTerms("Anthropic Claude model")).not.toContain("Claude");
  });

  test("replaces model names", () => {
    expect(scrubProviderTerms("gpt4 is great")).not.toContain("gpt4");
    expect(scrubProviderTerms("gpt-4 is great")).not.toContain("gpt-4");
    expect(scrubProviderTerms("gemini rocks")).not.toContain("gemini");
    expect(scrubProviderTerms("llama is open")).not.toContain("llama");
    expect(scrubProviderTerms("mistral 7b")).not.toContain("mistral");
  });

  test("is case insensitive", () => {
    expect(scrubProviderTerms("OPENAI")).not.toContain("OPENAI");
    expect(scrubProviderTerms("openAI")).not.toContain("openAI");
  });

  test("replaces with 'model'", () => {
    const result = scrubProviderTerms("Using OpenAI");
    expect(result).toContain("model");
  });

  test("leaves unrelated text unchanged", () => {
    expect(scrubProviderTerms("Hello world")).toBe("Hello world");
  });

  test("scrubs 'provider' and 'model id' terms", () => {
    expect(scrubProviderTerms("the provider is")).not.toContain("provider");
    expect(scrubProviderTerms("set model id to")).not.toContain("model id");
  });
});

describe("scrubValue", () => {
  test("scrubs strings", () => {
    const result = scrubValue("Using OpenAI") as string;
    expect(result).not.toContain("OpenAI");
  });

  test("scrubs arrays recursively", () => {
    const result = scrubValue(["OpenAI", "safe text"]) as string[];
    expect(result[0]).not.toContain("OpenAI");
    expect(result[1]).toBe("safe text");
  });

  test("scrubs objects recursively", () => {
    const result = scrubValue({ key: "OpenAI model" }) as Record<string, string>;
    expect(result.key).not.toContain("OpenAI");
  });

  test("scrubs nested structures", () => {
    const input = { arr: [{ msg: "gpt4 error" }] };
    const result = scrubValue(input) as { arr: Array<{ msg: string }> };
    expect(result.arr[0].msg).not.toContain("gpt4");
  });

  test("passes through primitives", () => {
    expect(scrubValue(42)).toBe(42);
    expect(scrubValue(true)).toBe(true);
    expect(scrubValue(null)).toBeNull();
    expect(scrubValue(undefined)).toBeUndefined();
  });
});
