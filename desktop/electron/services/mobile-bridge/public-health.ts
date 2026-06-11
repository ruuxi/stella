import dns from "dns";
import https from "https";
import type net from "net";

/**
 * DNS lookup that bypasses the OS resolver cache by querying the configured
 * DNS servers directly via c-ares (`dns.resolve*`). Tunnel hostnames are
 * created server-side moments before the first health probe; when that first
 * lookup races DNS propagation, macOS caches the NXDOMAIN for up to ~30
 * minutes and every later probe fails instantly even though the record now
 * exists — which blocks bridge registration and leaves the phone unable to
 * connect. Falls back to the system resolver for networks that block direct
 * DNS queries.
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
  dns.resolve4(hostname, (err4, ipv4) => {
    if (!err4 && ipv4.length > 0) {
      if (options.all) {
        callback(null, ipv4.map((address) => ({ address, family: 4 })));
      } else {
        callback(null, ipv4[0], 4);
      }
      return;
    }
    dns.resolve6(hostname, (err6, ipv6) => {
      if (!err6 && ipv6.length > 0) {
        if (options.all) {
          callback(null, ipv6.map((address) => ({ address, family: 6 })));
        } else {
          callback(null, ipv6[0], 6);
        }
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
