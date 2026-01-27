import path from "path";

export const toPosix = (value: string) => value.replace(/\\/g, "/");

export const normalizeAbsolutePath = (value: string) => {
  const resolved = path.resolve(value);
  return path.normalize(resolved);
};

export const relativeToRoot = (root: string, absolutePath: string) => {
  const rel = path.relative(root, absolutePath);
  return toPosix(rel);
};

export const ensureWithinRoot = (root: string, absolutePath: string) => {
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedPath = normalizeAbsolutePath(absolutePath);
  if (normalizedPath === normalizedRoot) {
    return true;
  }
  const rel = path.relative(normalizedRoot, normalizedPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const joinRoot = (root: string, relativePosixPath: string) => {
  const parts = relativePosixPath.split("/").filter(Boolean);
  return path.join(root, ...parts);
};

export const safeRelativeKey = (root: string, absolutePath: string) => {
  const rel = relativeToRoot(root, absolutePath);
  if (rel.startsWith("..")) {
    return toPosix(absolutePath);
  }
  return rel;
};

