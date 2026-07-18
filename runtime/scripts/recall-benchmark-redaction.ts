import { redactMemoryText } from "../kernel/memory/redaction.js";

const BENCHMARK_EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BENCHMARK_PHONE_RE =
  /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
export const BENCHMARK_POSTAL_ADDRESS_RE =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,8}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Way)\b(?:\s+(?:Ste|Suite|Apt|Unit)\s*#?[A-Za-z0-9-]+)?/gi;

export const redactBenchmarkBrief = (brief: string): string =>
  redactMemoryText(brief)
    .replace(BENCHMARK_EMAIL_RE, "[REDACTED EMAIL]")
    .replace(BENCHMARK_PHONE_RE, "[REDACTED PHONE]")
    .replace(BENCHMARK_POSTAL_ADDRESS_RE, "[REDACTED POSTAL ADDRESS]");
