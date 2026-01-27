import { promises as fs } from "fs";
import path from "path";
import YAML from "yaml";
import { normalizeAbsolutePath, relativeToRoot, toPosix } from "./path-utils.js";
const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const coerceStringArray = (value) => {
    if (!value)
        return [];
    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === "string" ? item : String(item)))
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    if (typeof value === "string") {
        return value
            .split("\n")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    return [String(value)];
};
const globToRegExp = (pattern) => {
    const escaped = pattern
        .split("")
        .map((char) => {
        if (char === "*")
            return "__STAR__";
        if (char === "?")
            return "__Q__";
        return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    })
        .join("");
    const withStars = escaped
        .replace(/__STAR____STAR__/g, ".*")
        .replace(/__STAR__/g, "[^/]*")
        .replace(/__Q__/g, ".");
    return new RegExp(`^${withStars}$`);
};
const parseFrontMatter = (markdown) => {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!match) {
        return { policy: {} };
    }
    try {
        const parsed = YAML.parse(match[1]);
        if (!isRecord(parsed)) {
            return { policy: {} };
        }
        const policy = {
            blockPaths: coerceStringArray(parsed.blockPaths),
            allowPaths: coerceStringArray(parsed.allowPaths),
            invariants: coerceStringArray(parsed.invariants),
            compatibilityNotes: coerceStringArray(parsed.compatibilityNotes),
        };
        return { policy };
    }
    catch {
        return { policy: {} };
    }
};
const loadInstructionFile = async (filePath) => {
    try {
        const markdown = await fs.readFile(filePath, "utf-8");
        const parsed = parseFrontMatter(markdown);
        return {
            filePath,
            directory: path.dirname(filePath),
            markdown,
            policy: parsed.policy,
        };
    }
    catch {
        return null;
    }
};
const collectInstructionFiles = async (absoluteFilePath, projectRoot) => {
    const instructions = [];
    const root = normalizeAbsolutePath(projectRoot);
    let currentDir = path.dirname(absoluteFilePath);
    const visited = new Set();
    while (true) {
        const normalized = normalizeAbsolutePath(currentDir);
        if (visited.has(normalized)) {
            break;
        }
        visited.add(normalized);
        const candidate = path.join(normalized, INSTRUCTIONS_FILE);
        const loaded = await loadInstructionFile(candidate);
        if (loaded) {
            instructions.push(loaded);
        }
        if (normalized === root) {
            break;
        }
        const parent = path.dirname(normalized);
        if (parent === normalized) {
            break;
        }
        currentDir = parent;
    }
    return instructions.reverse();
};
const matchAnyGlob = (patterns, relativePath) => {
    if (patterns.length === 0)
        return false;
    const normalized = toPosix(relativePath);
    return patterns.some((pattern) => globToRegExp(toPosix(pattern)).test(normalized));
};
const evaluatePolicies = (instructionFiles, classification) => {
    const blockReasons = [];
    const invariants = [];
    const compatibilityNotes = [];
    for (const file of instructionFiles) {
        const rel = relativeToRoot(file.directory, classification.absolutePath);
        const relPath = rel.startsWith("..") ? classification.zoneRelativePath : rel;
        const relPosix = toPosix(relPath);
        const blockPaths = file.policy.blockPaths ?? [];
        if (blockPaths.length > 0 && matchAnyGlob(blockPaths, relPosix)) {
            blockReasons.push(`Blocked by ${path.join(file.directory, INSTRUCTIONS_FILE)} (blockPaths matched "${relPosix}").`);
        }
        const allowPaths = file.policy.allowPaths ?? [];
        if (allowPaths.length > 0 && !matchAnyGlob(allowPaths, relPosix)) {
            blockReasons.push(`Blocked by ${path.join(file.directory, INSTRUCTIONS_FILE)} (path not allowlisted: "${relPosix}").`);
        }
        invariants.push(...(file.policy.invariants ?? []));
        compatibilityNotes.push(...(file.policy.compatibilityNotes ?? []));
    }
    return {
        blocked: blockReasons.length > 0,
        blockReasons,
        invariants,
        compatibilityNotes,
    };
};
export const createInstructionManager = (zoneManager) => {
    const getInstructionsForPath = async (inputPath) => {
        const classification = zoneManager.classifyPath(inputPath);
        const instructionFiles = await collectInstructionFiles(classification.absolutePath, zoneManager.projectRoot);
        const evaluation = evaluatePolicies(instructionFiles, classification);
        return {
            ...evaluation,
            classification,
            instructionFiles,
        };
    };
    const summarizeInstructionFiles = (instructionFiles) => instructionFiles.map((file) => file.filePath);
    return {
        getInstructionsForPath,
        summarizeInstructionFiles,
    };
};
