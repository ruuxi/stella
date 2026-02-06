import path from "path";
export const toPosix = (value) => value.replace(/\\/g, "/");
export const normalizeAbsolutePath = (value) => {
    const resolved = path.resolve(value);
    return path.normalize(resolved);
};
export const relativeToRoot = (root, absolutePath) => {
    const rel = path.relative(root, absolutePath);
    return toPosix(rel);
};
export const ensureWithinRoot = (root, absolutePath) => {
    const normalizedRoot = normalizeAbsolutePath(root);
    const normalizedPath = normalizeAbsolutePath(absolutePath);
    if (normalizedPath === normalizedRoot) {
        return true;
    }
    const rel = path.relative(normalizedRoot, normalizedPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
export const joinRoot = (root, relativePosixPath) => {
    const parts = relativePosixPath.split("/").filter(Boolean);
    return path.join(root, ...parts);
};
export const safeRelativeKey = (root, absolutePath) => {
    const rel = relativeToRoot(root, absolutePath);
    if (rel.startsWith("..")) {
        return toPosix(absolutePath);
    }
    return rel;
};
