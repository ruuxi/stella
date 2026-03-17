import net from "net";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const isLoopbackIp = (hostname: string) => {
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    return hostname.startsWith("127.");
  }
  if (ipVersion === 6) {
    return hostname === "::1";
  }
  return false;
};

const isTrustedRemoteHost = (hostname: string) => {
  const trustedHosts = (process.env.STELLA_TRUSTED_REMOTE_CDP_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return trustedHosts.includes(hostname.toLowerCase());
};

export const assertAllowedCdpUrl = (cdpUrl: string) => {
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new Error("Invalid CDP URL.");
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("CDP URL must use http, https, ws, or wss.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Embedded credentials are not allowed in CDP URLs.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname) || isLoopbackIp(hostname)) {
    return;
  }

  if (
    process.env.STELLA_ALLOW_REMOTE_CDP === "1" ||
    isTrustedRemoteHost(hostname)
  ) {
    return;
  }

  throw new Error(
    "Remote CDP endpoints are blocked by default. Set STELLA_ALLOW_REMOTE_CDP=1 or add the host to STELLA_TRUSTED_REMOTE_CDP_HOSTS to opt in.",
  );
};
