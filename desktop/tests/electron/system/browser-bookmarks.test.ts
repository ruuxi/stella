import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { collectBrowserBookmarks } from "../../../electron/system/browser-bookmarks.js";

const normalizePath = (value: string) => value.replaceAll("\\", "/");

describe("collectBrowserBookmarks", () => {
  let mockReadFile: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile = vi.spyOn(fs.promises, "readFile");
    vi.spyOn(os, "platform").mockReturnValue("win32");
    vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\Test");
    process.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local";
    process.env.APPDATA = "C:\\Users\\Test\\AppData\\Roaming";
  });

  it("reads bookmarks only from the selected browser profile", async () => {
    const expectedBookmarksPath = path.join(
      "C:\\Users\\Test\\AppData\\Local",
      "Google",
      "Chrome",
      "User Data",
      "Profile 2",
      "Bookmarks",
    );

    mockReadFile.mockImplementation(async (filePath: fs.PathLike) => {
      const normalizedPath = normalizePath(filePath.toString());
      if (
        !normalizedPath.includes("/Google/Chrome/User Data/Profile 2/Bookmarks")
      ) {
        throw new Error("ENOENT");
      }

      return JSON.stringify({
        roots: {
          bookmark_bar: {
            type: "folder",
            children: [
              {
                type: "url",
                name: "Stella",
                url: "https://stella.test",
              },
            ],
          },
        },
      });
    });

    const result = await collectBrowserBookmarks({
      selectedBrowser: "chrome",
      selectedProfile: "Profile 2",
    });

    expect(result).toEqual({
      browser: "Chrome",
      bookmarks: [
        {
          title: "Stella",
          url: "https://stella.test",
          folder: undefined,
        },
      ],
      folders: [],
    });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(
      normalizePath(mockReadFile.mock.calls[0][0]!.toString()),
    ).toContain("/Google/Chrome/User Data/Profile 2/Bookmarks");
  });
});
