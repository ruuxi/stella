import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertAllowedCdpUrl } from '../../../stella-browser/src/cdp-security.js';

describe('cdp-security', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STELLA_ALLOW_REMOTE_CDP;
    delete process.env.STELLA_TRUSTED_REMOTE_CDP_HOSTS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows loopback CDP endpoints without extra configuration', () => {
    expect(() => assertAllowedCdpUrl('http://localhost:9222')).not.toThrow();
    expect(() => assertAllowedCdpUrl('ws://127.0.0.1:9222/devtools/browser/abc')).not.toThrow();
  });

  it('blocks remote CDP endpoints by default', () => {
    expect(() => assertAllowedCdpUrl('wss://remote.example.com/devtools/browser/abc')).toThrow(
      'Remote CDP endpoints are blocked by default.',
    );
  });

  it('allows explicitly trusted remote CDP endpoints', () => {
    process.env.STELLA_TRUSTED_REMOTE_CDP_HOSTS = 'remote.example.com';
    expect(() => assertAllowedCdpUrl('wss://remote.example.com/devtools/browser/abc')).not.toThrow();
  });
});
