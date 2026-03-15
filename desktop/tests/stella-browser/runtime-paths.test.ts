import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { getSocketDir } from '../../stella-browser/src/runtime-paths.js';

describe('getSocketDir', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.STELLA_BROWSER_SOCKET_DIR;
    delete process.env.XDG_RUNTIME_DIR;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('STELLA_BROWSER_SOCKET_DIR', () => {
    it('should use custom path when set', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '/custom/socket/path';
      expect(getSocketDir()).toBe('/custom/socket/path');
    });

    it('should ignore empty string', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '';
      const result = getSocketDir();
      expect(result).toContain(path.join('.stella', 'stella-browser'));
    });

    it('should take priority over XDG_RUNTIME_DIR', () => {
      process.env.STELLA_BROWSER_SOCKET_DIR = '/custom/path';
      process.env.XDG_RUNTIME_DIR = '/run/user/1000';
      expect(getSocketDir()).toBe('/custom/path');
    });
  });

  describe('XDG_RUNTIME_DIR', () => {
    it('should use when STELLA_BROWSER_SOCKET_DIR is not set', () => {
      const tempDir = path.join(os.tmpdir(), `stella-browser-xdg-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
      tempDirs.push(tempDir);
      process.chdir(tempDir);
      process.env.XDG_RUNTIME_DIR = '/run/user/1000';
      expect(getSocketDir()).toBe(path.join('/run/user/1000', 'stella-browser'));
    });

    it('should ignore empty string', () => {
      const tempDir = path.join(os.tmpdir(), `stella-browser-empty-xdg-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
      tempDirs.push(tempDir);
      process.chdir(tempDir);
      process.env.STELLA_BROWSER_SOCKET_DIR = '';
      process.env.XDG_RUNTIME_DIR = '';
      const result = getSocketDir();
      expect(result).toContain('.stella-browser');
    });
  });

  describe('fallback', () => {
    it('should prefer repo-local .stella directory when env vars are not set', () => {
      const result = getSocketDir();
      const expected = path.join(path.resolve(process.cwd(), '..'), '.stella', 'stella-browser');
      expect(result).toBe(expected);
    });
  });
});
