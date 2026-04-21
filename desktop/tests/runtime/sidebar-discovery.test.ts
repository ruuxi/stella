import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APPS_DIR = fileURLToPath(new URL("../../src/apps", import.meta.url));
const ROUTES_DIR = fileURLToPath(new URL("../../src/routes", import.meta.url));

const VALID_SLOTS = new Set(["top", "bottom"]);

const listAppDirs = () =>
  readdirSync(APPS_DIR).filter((entry) => {
    if (entry.startsWith("_")) return false;
    return statSync(join(APPS_DIR, entry)).isDirectory();
  });

describe("sidebar app discovery", () => {
  const appDirs = listAppDirs();

  it("finds at least the four built-in apps", () => {
    for (const id of ["chat", "social", "settings", "store"]) {
      expect(appDirs).toContain(id);
    }
  });

  it.each(appDirs)("`apps/%s/` exposes a well-formed metadata.ts", async (dirName) => {
    const mod = (await import(join(APPS_DIR, dirName, "metadata.ts"))) as {
      default: unknown;
    };
    const metadata = mod.default as Record<string, unknown>;

    expect(metadata, `apps/${dirName}/metadata.ts must export default`).toBeTruthy();
    expect(typeof metadata.id).toBe("string");
    expect(typeof metadata.label).toBe("string");
    expect(typeof metadata.route).toBe("string");
    expect(typeof metadata.icon).toBe("function");
    expect(VALID_SLOTS.has(metadata.slot as string)).toBe(true);
    if (metadata.order !== undefined) {
      expect(typeof metadata.order).toBe("number");
    }
    expect((metadata.route as string).startsWith("/")).toBe(true);

    // The directory name *is* the app id. Diverging makes discovery + the
    // routes/<id>.tsx convention quietly inconsistent (e.g. an `apps/chat`
    // folder declaring `id: "home"` would still appear in the sidebar but
    // would not match its directory or the route filename).
    expect(
      metadata.id,
      `apps/${dirName}/metadata.ts must declare id: "${dirName}" (matches the directory name)`,
    ).toBe(dirName);
  });

  it.each(appDirs)(
    "`apps/%s/`'s metadata.route has a matching `routes/<id>.tsx` shell",
    async (dirName) => {
      const mod = (await import(join(APPS_DIR, dirName, "metadata.ts"))) as {
        default: { route: string };
      };
      const route = mod.default.route;
      const routeFile = `${route.replace(/^\//, "") || "index"}.tsx`;
      const routePath = join(ROUTES_DIR, routeFile);
      expect(
        statSync(routePath).isFile(),
        `expected ${routePath} to exist (routes/<id>.tsx is the file-system shell)`,
      ).toBe(true);
    },
  );

  it("each route's id matches a unique sidebar app id", async () => {
    const ids = new Set<string>();
    for (const dirName of appDirs) {
      const mod = (await import(join(APPS_DIR, dirName, "metadata.ts"))) as {
        default: { id: string };
      };
      const { id } = mod.default;
      expect(ids.has(id), `duplicate metadata.id: ${id}`).toBe(false);
      ids.add(id);
    }
  });
});
