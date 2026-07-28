/**
 * SSRF guard for every outbound fetch of a model- or user-supplied URL.
 *
 * Two halves, and both have to hold:
 *
 * 1. LITERAL classification — what the hostname says it is. The WHATWG URL
 *    parser already canonicalizes exotic IPv4 spellings (decimal
 *    `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short `127.1`) into
 *    dotted-quad before this module sees them. IPv6 needs real parsing:
 *    IPv4-mapped (`::ffff:127.0.0.1`), IPv4-COMPATIBLE (`::7f00:1`), and
 *    NAT64 (`64:ff9b::/96`) all embed a v4 address that must be classified as
 *    v4. Prefix string matching misses every one of them.
 *
 * 2. RESOLVED classification — what the hostname actually points at. A name
 *    the attacker controls can resolve anywhere, so without this the literal
 *    checks are close to decorative.
 *
 * Historically the resolved half was disabled wholesale whenever
 * `NODE_ENV === "development"`, which meant a dev-mode Stella — the way this
 * app is normally run — had no protection beyond a six-entry hostname set.
 * It is now always on, with a NAMED-HOST escape hatch instead of a blanket
 * off switch, so a split-DNS setup can be accommodated without disarming the
 * guard for every other host. See `STELLA_ALLOW_PRIVATE_HOSTS`.
 *
 * Known limit, stated rather than implied: this is resolve-then-fetch, and
 * `fetch` performs its own lookup. A rebinding record (TTL 0, second answer
 * private) is not fully closed by any check expressible through the fetch
 * API. Callers that follow redirects MUST re-run this on every hop.
 */

import dns from "dns/promises";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

/**
 * Hosts the operator has explicitly declared safe despite resolving into
 * private space — the split-DNS / VPN case the old dev-mode skip existed
 * for. Comma-separated exact hostnames, e.g.
 * `STELLA_ALLOW_PRIVATE_HOSTS=internal.corp.example,staging.local`.
 *
 * Read per call, not cached: this is not hot, and a cached copy would ignore
 * an env change until restart.
 */
const allowedPrivateHosts = (): Set<string> =>
  new Set(
    (process.env.STELLA_ALLOW_PRIVATE_HOSTS ?? "")
      .split(",")
      .map((entry) => normalizeHostForClassification(entry))
      .filter((entry) => entry.length > 0),
  );

/**
 * Canonical form for hostname comparison: lowercased, brackets stripped, and
 * a single trailing dot removed. `localhost.` is the same host as `localhost`
 * to DNS but a different string to a Set, so without this the name blocklist
 * is bypassed by typing one extra dot.
 */
const normalizeHostForClassification = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

const parseDottedQuad = (host: string): number[] | null => {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
};

const isBlockedIpv4Bytes = (bytes: number[]): boolean => {
  const [a, b] = bytes;
  return (
    a === 0 || // "this network", including 0.0.0.0
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local — cloud metadata lives here
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    a >= 240 // reserved 240/4 + broadcast
  );
};

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null when the
 * string is not valid IPv6. Accepts the trailing-dotted-quad form
 * (`::ffff:127.0.0.1`) the URL parser preserves.
 */
const parseIpv6Groups = (host: string): number[] | null => {
  let input = host;
  const v4TailMatch = input.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4TailMatch) {
    const bytes = parseDottedQuad(v4TailMatch[2]);
    if (!bytes) return null;
    input =
      v4TailMatch[1] +
      ((bytes[0] << 8) | bytes[1]).toString(16) +
      ":" +
      ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const doubleColonSplits = input.split("::");
  if (doubleColonSplits.length > 2) return null;
  const parseGroups = (section: string): number[] | null => {
    if (section === "") return [];
    const groups: number[] = [];
    for (const raw of section.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null;
      groups.push(Number.parseInt(raw, 16));
    }
    return groups;
  };
  if (doubleColonSplits.length === 1) {
    const groups = parseGroups(input);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = parseGroups(doubleColonSplits[0]);
  const tail = parseGroups(doubleColonSplits[1]);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [
    ...head,
    ...new Array(8 - head.length - tail.length).fill(0),
    ...tail,
  ];
};

const isBlockedIpv6Groups = (groups: number[]): boolean => {
  const isZeroThrough = (count: number) =>
    groups.slice(0, count).every((group) => group === 0);
  // Unspecified (::) and loopback (::1).
  if (isZeroThrough(7) && (groups[7] === 0 || groups[7] === 1)) return true;
  // ULA fc00::/7.
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // Embedded-IPv4 forms: mapped ::ffff:x/96, translated ::ffff:0:x/96,
  // NAT64 64:ff9b::/96, and the deprecated IPv4-COMPATIBLE ::a.b.c.d. In all
  // of them the effective target is the embedded v4 address.
  const embeddedV4 =
    (isZeroThrough(5) && groups[5] === 0xffff) ||
    (isZeroThrough(4) && groups[4] === 0xffff && groups[5] === 0) ||
    (groups[0] === 0x64 &&
      groups[1] === 0xff9b &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0) ||
    (isZeroThrough(6) && (groups[6] !== 0 || groups[7] !== 0));
  if (embeddedV4) {
    return isBlockedIpv4Bytes([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }
  return false;
};

/**
 * True for literal IP strings targeting loopback, private, link-local,
 * CGNAT, reserved, or embedded-v4-blocked space. Domain names return false —
 * resolution is the caller's job.
 */
export const isBlockedIpAddress = (ip: string): boolean => {
  const trimmed = normalizeHostForClassification(ip);
  const v4 = parseDottedQuad(trimmed);
  if (v4) return isBlockedIpv4Bytes(v4);
  if (trimmed.includes(":")) {
    const groups = parseIpv6Groups(trimmed);
    // An unparseable bracketed literal is refused rather than resolved.
    if (!groups) return true;
    return isBlockedIpv6Groups(groups);
  }
  return false;
};

const privateTargetError = (detail: string) =>
  new Error(
    `Private and local network targets are blocked.${detail} If this host is genuinely safe, add it to STELLA_ALLOW_PRIVATE_HOSTS (comma-separated hostnames).`,
  );

const assertPublicHostname = async (hostname: string) => {
  const normalized = normalizeHostForClassification(hostname);
  if (!normalized) {
    throw new Error("URL hostname is required.");
  }
  if (allowedPrivateHosts().has(normalized)) {
    return;
  }
  if (
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw privateTargetError("");
  }
  if (isBlockedIpAddress(normalized)) {
    throw privateTargetError("");
  }

  // Always resolved, never skipped. A name is only as safe as what it points
  // at, and the attacker picks the name.
  const results = await dns.lookup(normalized, { all: true });
  if (results.length === 0) {
    throw new Error(`Could not resolve hostname "${normalized}".`);
  }
  if (results.some((result) => isBlockedIpAddress(result.address))) {
    const addrs = results.map((r) => r.address).join(", ");
    throw privateTargetError(
      ` "${normalized}" resolved to: ${addrs}. Check hosts file, VPN, or DNS if this should be a public site.`,
    );
  }
};

export const normalizeSafeExternalUrl = async (inputUrl: string) => {
  const trimmed = inputUrl.trim();
  if (!trimmed) {
    throw new Error("URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Embedded URL credentials are not allowed.");
  }

  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }

  await assertPublicHostname(parsed.hostname);
  return parsed.toString();
};
