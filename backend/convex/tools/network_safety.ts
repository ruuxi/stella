const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "host.docker.internal",
  "gateway.docker.internal",
  "metadata",
  "metadata.google.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
];

const IPV6_LITERAL_PATTERN = /^[0-9a-f:]+$/i;

const normalizeHostname = (hostname: string) => {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
};

const parseIpv4 = (hostname: string): [number, number, number, number] | null => {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((value) => value === null)) return null;
  return octets as [number, number, number, number];
};

const isPrivateOrReservedIpv4 = ([a, b, c]: [number, number, number, number]) => {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
};

const isIpv6Literal = (hostname: string) =>
  hostname.includes(":") && IPV6_LITERAL_PATTERN.test(hostname);

type IntegrationHostSafetyOptions = {
  allowPrivateNetworkHosts?: boolean;
};

const isUnsafeIntegrationHostname = (hostname: string) => {
  if (!hostname) return true;
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (/^\d+$/.test(hostname)) return true;

  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    return isPrivateOrReservedIpv4(ipv4);
  }

  if (isIpv6Literal(hostname)) {
    const normalized = hostname.toLowerCase();
    if (
      normalized === "::" ||
      normalized === "::1" ||
      normalized === "0:0:0:0:0:0:0:0" ||
      normalized === "0:0:0:0:0:0:0:1"
    ) {
      return true;
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) return true;
    return false;
  }

  return false;
};

export const getUnsafeIntegrationHostError = (
  url: URL,
  options?: IntegrationHostSafetyOptions,
): string | null => {
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    return "IntegrationRequest requires a hostname.";
  }
  if (options?.allowPrivateNetworkHosts) return null;
  if (!isUnsafeIntegrationHostname(hostname)) return null;

  return `Host "${url.hostname}" is blocked for security in this request context.`;
};
