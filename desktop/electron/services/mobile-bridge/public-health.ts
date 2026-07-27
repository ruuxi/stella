import dns from "dns";
import https from "https";
import type net from "net";

/**
 * Independent public resolvers used when the configured resolver can't (or
 * won't) resolve the tunnel hostname. VPN clients commonly point the OS at
 * their own DNS server (e.g. 10.2.0.1 on a utun interface), and those servers
 * can return NXDOMAIN for a freshly created tunnel record long after public
 * DNS has it — `dns.resolve*` still queries the *configured* servers, so it
 * inherits the same stale answer. Pinning known-public resolvers is safe here
 * because this module only ever resolves Stella-owned tunnel hostnames.
 */
const PUBLIC_FALLBACK_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const PUBLIC_FALLBACK_DNS_TIMEOUT_MS = 2_000;

let publicFallbackResolver: dns.Resolver | null = null;
const getPublicFallbackResolver = (): dns.Resolver => {
  if (!publicFallbackResolver) {
    publicFallbackResolver = new dns.Resolver({
      timeout: PUBLIC_FALLBACK_DNS_TIMEOUT_MS,
      tries: 1,
    });
    publicFallbackResolver.setServers(PUBLIC_FALLBACK_DNS_SERVERS);
  }
  return publicFallbackResolver;
};

/** Try A then AAAA on the given resolver; null when neither yields a record. */
const resolveAddresses = (
  resolver: Pick<dns.Resolver, "resolve4" | "resolve6">,
  hostname: string,
  callback: (addresses: dns.LookupAddress[] | null) => void,
) => {
  resolver.resolve4(hostname, (err4, ipv4) => {
    if (!err4 && ipv4.length > 0) {
      callback(ipv4.map((address) => ({ address, family: 4 })));
      return;
    }
    resolver.resolve6(hostname, (err6, ipv6) => {
      if (!err6 && ipv6.length > 0) {
        callback(ipv6.map((address) => ({ address, family: 6 })));
        return;
      }
      callback(null);
    });
  });
};

/**
 * DNS lookup that bypasses the OS resolver cache by querying the configured
 * DNS servers directly via c-ares (`dns.resolve*`). Tunnel hostnames are
 * created server-side moments before the first health probe; when that first
 * lookup races DNS propagation, macOS caches the NXDOMAIN for up to ~30
 * minutes and every later probe fails instantly even though the record now
 * exists — which blocks bridge registration and leaves the phone unable to
 * connect.
 *
 * When the configured resolver comes up empty (stale NXDOMAIN from a VPN's
 * DNS server is the common case) we retry against pinned public resolvers,
 * and only then fall back to the system resolver for networks that block
 * direct DNS queries entirely.
 */
const cacheBypassLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => {
  const finish = (addresses: dns.LookupAddress[]) => {
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
  resolveAddresses(dns, hostname, (configured) => {
    if (configured) {
      finish(configured);
      return;
    }
    resolveAddresses(getPublicFallbackResolver(), hostname, (fallback) => {
      if (fallback) {
        finish(fallback);
        return;
      }
      dns.lookup(hostname, options, (err, address, family) =>
        callback(err, address, family),
      );
    });
  });
};

/**
 * Probe the public tunnel's `/bridge/health` endpoint, resolving the hostname
 * outside the OS resolver cache so a freshly created DNS record is seen as
 * soon as it propagates.
 */
export const probeBridgePublicHealth = (
  url: string,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(`${url.replace(/\/+$/, "")}/bridge/health`);
    } catch {
      resolve(false);
      return;
    }

    const request = https.request(
      {
        host: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: target.pathname,
        method: "GET",
        timeout: timeoutMs,
        lookup: cacheBypassLookup as net.LookupFunction,
      },
      (response) => {
        response.resume();
        resolve(
          typeof response.statusCode === "number" &&
            response.statusCode >= 200 &&
            response.statusCode < 300,
        );
      },
    );
    request.on("timeout", () => {
      request.destroy();
    });
    request.on("error", () => resolve(false));
    request.end();
  });
