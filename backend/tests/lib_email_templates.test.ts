import { describe, test, expect } from "bun:test";
import { buildMagicLinkEmail } from "../convex/lib/email_templates";

describe("buildMagicLinkEmail", () => {
  const logoSrc = "https://example.com/logo.png";
  const signInUrl = "https://example.com/auth?token=abc123";

  test("returns valid HTML", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  test("includes logo source", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain(logoSrc);
  });

  test("includes sign-in URL", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain(signInUrl);
  });

  test("includes sign-in button text", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain("Sign in to Stella");
  });

  test("includes Stella branding", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain("Stella");
  });

  test("includes expiry notice", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain("expire");
  });

  test("includes safety notice", () => {
    const html = buildMagicLinkEmail(logoSrc, signInUrl);
    expect(html).toContain("safely ignore");
  });
});
