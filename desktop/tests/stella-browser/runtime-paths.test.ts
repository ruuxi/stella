import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { getSocketDir } from '../../stella-browser/src/runtime-paths.js';

describe('getSocketDir', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.STELLA_BROWSER_SOCKET_DIR;
    delete process.env.XDG_RUNTIME_DIR;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('STELLA_BROWSER_SOCKET_DIR', () => {
    it('should use custom path when set', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '/custom/socket/path';
      expect(getSocketDir()).toBe('/custom/socket/path');
    });

    it('should ignore empty string', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '';
      const result = getSocketDir();
      expect(result).toContain('.stella-browser');
    });

    it('should take priority over XDG_RUNTIME_DIR', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '/custom/path';
      process.env.XDG_RUNTIME_DIR = '/run/user/1000';
      expect(getSocketDir()).toBe('/custom/path');
    });
  });

  describe('XDG_RUNTIME_DIR', () => {
    it('should use when STELLA_BROWSER_SOCKET_DIR is not set', () => {
      process.env.XDG_RUNTIME_DIR = '/run/user/1000';
      expect(getSocketDir()).toBe(path.join('/run/user/1000', 'stella-browser'));
    });

    it('should ignore empty string', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '';
      process.env.XDG_RUNTIME_DIR = '';
      const result = getSocketDir();
      expect(result).toContain('.stella-browser');
    });
  });

  describe('fallback', () => {
    it('should use home directory when env vars are not set', () => {
      const result = getSocketDir();
      const expected = path.join(os.homedir(), '.stella-browser');
      expect(result).toBe(expected);
    });
  });
});
