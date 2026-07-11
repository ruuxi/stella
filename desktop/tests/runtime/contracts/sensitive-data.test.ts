import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../../../../runtime/contracts/sensitive-data.js";

describe("redactSensitiveText", () => {
  describe("benign assignments stay readable", () => {
    it.each([
      "count=0",
      "retries=3",
      "timeout=30",
      "set retries=3",
      "mode=fast",
      "status=running",
      "limit=100 offset=20",
      "path=/usr/local/lib/python3.11/site-packages",
      "version=1.2.3",
    ])("keeps %s untouched", (input) => {
      expect(redactSensitiveText(input)).toBe(input);
    });
  });

  describe("sensitive assignments are redacted", () => {
    it.each([
      ["FOO_TOKEN=abc123def", "FOO_TOKEN=[REDACTED]"],
      ["api_key=short", "api_key=[REDACTED]"],
      ["OPENAI_API_KEY=whatever", "OPENAI_API_KEY=[REDACTED]"],
      ["password=hunter2", "password=[REDACTED]"],
      ["AUTH=abc", "AUTH=[REDACTED]"],
      ["credential=x", "credential=[REDACTED]"],
    ])("redacts %s by key name", (input, expected) => {
      expect(redactSensitiveText(input)).toBe(expected);
    });

    it("redacts quoted values even under benign keys", () => {
      expect(redactSensitiveText('note="my private phrase"')).toBe(
        "note=[REDACTED]",
      );
    });

    it("redacts long high-entropy values under benign keys", () => {
      expect(redactSensitiveText("blob=A1b2C3d4E5f6G7h8I9j0K1l2")).toBe(
        "blob=[REDACTED]",
      );
    });
  });

  describe("header, cookie, and token forms", () => {
    it("redacts Authorization headers", () => {
      const out = redactSensitiveText("Authorization: Bearer super-secret");
      expect(out).not.toContain("super-secret");
      expect(out).toContain("[REDACTED]");
    });

    it("redacts bare bearer tokens", () => {
      const out = redactSensitiveText("used Bearer tok-abc.def-123 here");
      expect(out).not.toContain("tok-abc.def-123");
      expect(out).toContain("[REDACTED]");
    });

    it("redacts cookies", () => {
      const out = redactSensitiveText("Cookie: session=leaky-value; extra=1");
      expect(out).not.toContain("leaky-value");
      expect(out).toContain("[REDACTED]");
      // The non-secret pair after the cookie separator stays readable.
      expect(out).toContain("extra=1");
    });

    it("redacts JWTs", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.signature123";
      const out = redactSensitiveText(`token=${jwt}`);
      expect(out).not.toContain(jwt);
      expect(out).toContain("[REDACTED]");
    });

    it("redacts private keys", () => {
      const key =
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
      const out = redactSensitiveText(`the key is ${key}`);
      expect(out).not.toContain("private-material");
      expect(out).toContain("[REDACTED PRIVATE KEY]");
    });

    it("redacts secret CLI flags", () => {
      const out = redactSensitiveText("run --token flag-secret --verbose");
      expect(out).not.toContain("flag-secret");
      expect(out).toContain("[REDACTED]");
      expect(out).toContain("--verbose");
    });

    it("redacts URL secret params", () => {
      const out = redactSensitiveText(
        "fetch https://api.example.com/x?token=url-secret then continue",
      );
      expect(out).not.toContain("url-secret");
      expect(out).toContain("[REDACTED]");
      // Text after the secret param (separated by whitespace) stays readable.
      expect(out).toContain("then continue");
    });
  });

  describe("defense-in-depth bare credentials", () => {
    it("redacts bare AWS access key IDs", () => {
      const out = redactSensitiveText("key AKIAIOSFODNN7EXAMPLE was used");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(out).toContain("[REDACTED]");
    });

    it("redacts 40-char AWS secret keys near an aws/secret context", () => {
      const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const out = redactSensitiveText(
        `"aws_secret_access_key": "${secret}"`,
      );
      expect(out).not.toContain(secret);
      expect(out).toContain("[REDACTED]");
    });

    it("redacts bare sk- provider tokens", () => {
      const out = redactSensitiveText("using sk-abcDEF1234567890ghiJKL now");
      expect(out).not.toContain("sk-abcDEF1234567890ghiJKL");
      expect(out).toContain("[REDACTED]");
    });

    it("does not treat ordinary hyphenated words as sk- tokens", () => {
      const input = "the task-runner and risk-averse plan";
      expect(redactSensitiveText(input)).toBe(input);
    });

    it("leaves a lone 40-char token without aws/secret context alone", () => {
      const input = "checksum abcdef0123456789abcdef0123456789abcdef01";
      expect(redactSensitiveText(input)).toBe(input);
    });
  });
});
