import dns from "dns/promises";
import net from "net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "host.docker.internal",
]);

const isBlockedIpv4 = (ip: string) => {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

const isBlockedIpv6 = (ip: string) => {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
};

/** True only for literal IP strings that are loopback / RFC1918 / link-local. Domain names are not IPs (net.isIP === 0) and must not be blocked here — DNS handles those. */
const isBlockedIpAddress = (ip: string) => {
  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    return isBlockedIpv4(ip);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(ip);
  }
  return false;
};

const assertPublicHostname = async (
  hostname: string,
  skipResolvedAddressCheck: boolean,
) => {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    throw new Error("URL hostname is required.");
  }
  if (
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    throw new Error("Private and local network targets are blocked.");
  }
  if (isBlockedIpAddress(normalized)) {
    throw new Error("Private and local network targets are blocked.");
  }

  if (skipResolvedAddressCheck) {
    return;
  }

  const results = await dns.lookup(normalized, { all: true });
  if (results.length === 0) {
    throw new Error(`Could not resolve hostname "${normalized}".`);
  }
  if (results.some((result) => isBlockedIpAddress(result.address))) {
    const addrs = results.map((r) => r.address).join(", ");
    throw new Error(
      `Private and local network targets are blocked. "${normalized}" resolved to: ${addrs}. Check hosts file, VPN, or DNS if this should be a public site.`,
    );
  }
};

export type NormalizeSafeExternalUrlOptions = {
  /**
   * When true, only the hostname string is validated (no localhost/private literals).
   * DNS is not checked — use in development when VPN/DNS maps public names to private IPs.
   */
  skipResolvedAddressCheck?: boolean;
};

export const normalizeSafeExternalUrl = async (
  inputUrl: string,
  options?: NormalizeSafeExternalUrlOptions,
) => {
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

  await assertPublicHostname(
    parsed.hostname,
    options?.skipResolvedAddressCheck ?? false,
  );
  return parsed.toString();
};
