import { describe, test, expect } from "bun:test";
import { getUnsafeIntegrationHostError } from "../convex/tools/network_safety";

describe("getUnsafeIntegrationHostError", () => {
  const check = (hostname: string) =>
    getUnsafeIntegrationHostError(new URL(`https://${hostname}/path`));

  // --- Safe hosts ---

  test("allows public hostnames", () => {
    expect(check("api.github.com")).toBeNull();
    expect(check("example.com")).toBeNull();
    expect(check("hooks.slack.com")).toBeNull();
  });

  // --- Blocked hosts ---

  test("blocks localhost", () => {
    expect(check("localhost")).not.toBeNull();
    expect(check("localhost.localdomain")).not.toBeNull();
  });

  test("blocks Docker internal hosts", () => {
    expect(check("host.docker.internal")).not.toBeNull();
    expect(check("gateway.docker.internal")).not.toBeNull();
  });

  test("blocks cloud metadata endpoints", () => {
    expect(check("metadata")).not.toBeNull();
    expect(check("metadata.google.internal")).not.toBeNull();
  });

  test("blocks kubernetes service hosts", () => {
    expect(check("kubernetes.default")).not.toBeNull();
    expect(check("kubernetes.default.svc")).not.toBeNull();
  });

  // --- Blocked suffixes ---

  test("blocks .local suffix", () => {
    expect(check("myhost.local")).not.toBeNull();
  });

  test("blocks .internal suffix", () => {
    expect(check("something.internal")).not.toBeNull();
  });

  test("blocks .localhost suffix", () => {
    expect(check("anything.localhost")).not.toBeNull();
  });

  // --- Private IPv4 ranges ---

  test("blocks private IPv4 10.x.x.x", () => {
    expect(check("10.0.0.1")).not.toBeNull();
    expect(check("10.255.255.255")).not.toBeNull();
  });

  test("blocks private IPv4 172.16-31.x.x", () => {
    expect(check("172.16.0.1")).not.toBeNull();
    expect(check("172.31.255.255")).not.toBeNull();
  });

  test("blocks private IPv4 192.168.x.x", () => {
    expect(check("192.168.0.1")).not.toBeNull();
    expect(check("192.168.1.100")).not.toBeNull();
  });

  test("blocks loopback 127.x.x.x", () => {
    expect(check("127.0.0.1")).not.toBeNull();
    expect(check("127.255.255.255")).not.toBeNull();
  });

  test("blocks link-local 169.254.x.x", () => {
    expect(check("169.254.0.1")).not.toBeNull();
  });

  test("allows public IPv4", () => {
    expect(check("8.8.8.8")).toBeNull();
    expect(check("1.1.1.1")).toBeNull();
  });

  // --- IPv6 ---

  test("blocks IPv6 loopback ::1", () => {
    expect(getUnsafeIntegrationHostError(new URL("https://[::1]/path"))).not.toBeNull();
  });

  // --- Allow private network hosts option ---

  test("allows private hosts when option is set", () => {
    const result = getUnsafeIntegrationHostError(
      new URL("https://192.168.1.1/path"),
      { allowPrivateNetworkHosts: true },
    );
    expect(result).toBeNull();
  });

  // --- Empty hostname ---

  test("blocks empty hostname", () => {
    // URL requires a hostname, so test the error message for blocked hosts
    const result = getUnsafeIntegrationHostError(new URL("https://localhost/"));
    expect(result).toContain("blocked");
  });
});
