import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APPS_DIR = fileURLToPath(new URL("../../src/apps", import.meta.url));
const ROUTES_DIR = fileURLToPath(new URL("../../src/routes", import.meta.url));
const ROUTE_TREE_PATH = fileURLToPath(
  new URL("../../src/routeTree.gen.ts", import.meta.url),
);

const listAppDirs = () =>
  readdirSync(APPS_DIR).filter((entry) => {
    if (entry.startsWith("_")) return false;
    return statSync(join(APPS_DIR, entry)).isDirectory();
  });

/**
 * A "flat top-level route" is `routes/<name>.tsx` where `<name>` is a single
 * URL segment of safe characters. This intentionally excludes layout files
 * (`__root.tsx`), the `/` redirect (`index.tsx`), nested files
 * (`foo.bar.tsx`), dynamic params (`$id.tsx`), and route groups (`(group)`),
 * so this suite stays valid the moment we introduce any of those.
 */
const FLAT_ROUTE_FILE = /^([a-z][a-z0-9-]*)\.tsx$/;

const listFlatRouteFiles = () =>
  readdirSync(ROUTES_DIR).filter(
    (entry) => FLAT_ROUTE_FILE.test(entry) && entry !== "index.tsx",
  );

describe("route smoke", () => {
  it("routeTree.gen.ts exists and references the root route", () => {
    const tree = readFileSync(ROUTE_TREE_PATH, "utf-8");
    expect(tree).toContain("./routes/__root");
    expect(tree).toContain("FileRoutesByFullPath");
  });

  it("every flat routes/<id>.tsx is registered in routeTree.gen.ts", () => {
    const tree = readFileSync(ROUTE_TREE_PATH, "utf-8");
    for (const file of listFlatRouteFiles()) {
      const path = `/${file.replace(/\.tsx$/, "")}`;
      // The generated tree quotes paths with single quotes today; tolerate
      // either quote style so a future formatter switch doesn't break us.
      expect(tree).toMatch(
        new RegExp(`['"\`]${path.replace(/\//g, "\\/")}['"\`]\\s*:\\s*typeof`),
      );
    }
  });

  const routeFiles = listFlatRouteFiles();
  it.each(routeFiles)(
    "routes/%s declares createFileRoute with the matching path",
    (file) => {
      const path = `/${file.replace(/\.tsx$/, "")}`;
      const source = readFileSync(join(ROUTES_DIR, file), "utf-8");
      expect(source).toMatch(/from\s+["'`]@tanstack\/react-router["'`]/);
      expect(source).toMatch(
        new RegExp(
          `createFileRoute\\(\\s*["'\`]${path.replace(/\//g, "\\/")}["'\`]\\s*\\)`,
        ),
      );
    },
  );

  it("every metadata.route resolves to a registered route", () => {
    const tree = readFileSync(ROUTE_TREE_PATH, "utf-8");
    for (const dirName of listAppDirs()) {
      const metaSource = readFileSync(
        join(APPS_DIR, dirName, "metadata.ts"),
        "utf-8",
      );
      const match = metaSource.match(/route:\s*["']([^"']+)["']/);
      expect(match, `apps/${dirName}/metadata.ts must declare route: "..."`).toBeTruthy();
      const route = match![1];
      expect(tree).toMatch(
        new RegExp(`['"\`]${route.replace(/\//g, "\\/")}['"\`]\\s*:\\s*typeof`),
      );
    }
  });

  it("the chat route declares the `c` (conversationId) search param", () => {
    const source = readFileSync(join(ROUTES_DIR, "chat.tsx"), "utf-8");
    expect(source).toMatch(/c:\s*z\.string\(\)/);
  });

  it("the settings route declares the `tab` search param enum", () => {
    const source = readFileSync(join(ROUTES_DIR, "settings.tsx"), "utf-8");
    expect(source).toMatch(/tab:\s*z[\s\S]*\.enum\(/);
  });

  it("the root route declares the `dialog` search param enum", () => {
    const source = readFileSync(join(ROUTES_DIR, "__root.tsx"), "utf-8");
    expect(source).toMatch(/dialog:\s*z[\s\S]*\.enum\(/);
  });
});
