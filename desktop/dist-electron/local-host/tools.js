import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
const MAX_OUTPUT = 30000;
const MAX_FILE_BYTES = 1000000;
const ensureAbsolutePath = (filePath) => {
    if (!path.isAbsolute(filePath)) {
        return {
            ok: false,
            error: `file_path must be absolute. Received: ${filePath}`,
        };
    }
    return { ok: true };
};
const truncate = (value, max = MAX_OUTPUT) => value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;
const isIgnoredDir = (name) => name === "node_modules" ||
    name === ".git" ||
    name === "dist" ||
    name === "dist-electron" ||
    name === "release";
const toPosix = (value) => value.replace(/\\/g, "/");
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
const walkFiles = async (basePath) => {
    const results = [];
    const stack = [basePath];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            continue;
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!isIgnoredDir(entry.name)) {
                    stack.push(fullPath);
                }
                continue;
            }
            if (entry.isFile()) {
                results.push(fullPath);
            }
        }
    }
    return results;
};
const readFileSafe = async (filePath) => {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_BYTES) {
        return {
            ok: false,
            error: `File too large to read safely (${stat.size} bytes): ${filePath}`,
        };
    }
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return { ok: true, content };
    }
    catch {
        const buffer = await fs.readFile(filePath);
        const base64 = buffer.toString("base64");
        return {
            ok: true,
            content: `[binary:${buffer.byteLength} bytes]\n${truncate(base64, 4000)}`,
        };
    }
};
const formatWithLineNumbers = (content, offset = 1, limit = 2000) => {
    const lines = content.split("\n");
    const startLine = Math.max(0, offset - 1);
    const endLine = Math.min(lines.length, startLine + limit);
    const selected = lines.slice(startLine, endLine);
    const body = selected
        .map((line, index) => {
        const lineNum = startLine + index + 1;
        const truncatedLine = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
        return `${String(lineNum).padStart(6, " ")}\t${truncatedLine}`;
    })
        .join("\n");
    return {
        header: `File has ${lines.length} lines. Showing ${startLine + 1}-${endLine}.`,
        body,
    };
};
const stripHtml = (html) => {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};
const getStatePath = (userDataPath, kind, id) => path.join(userDataPath, kind, `${id}.json`);
const loadJson = async (filePath, fallback) => {
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
};
const saveJson = async (filePath, value) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
};
export const createToolHost = ({ userDataPath }) => {
    const shells = new Map();
    const tasks = new Map();
    const startShell = (command, cwd) => {
        const id = crypto.randomUUID();
        const shell = process.platform === "win32" ? "cmd.exe" : "bash";
        const args = process.platform === "win32" ? ["/c", command] : ["-lc", command];
        const child = spawn(shell, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const record = {
            id,
            command,
            cwd,
            output: "",
            running: true,
            exitCode: null,
            startedAt: Date.now(),
            completedAt: null,
            kill: () => {
                child.kill();
            },
        };
        const append = (data) => {
            record.output = truncate(`${record.output}${data.toString()}`);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("close", (code) => {
            record.running = false;
            record.exitCode = code ?? null;
            record.completedAt = Date.now();
        });
        shells.set(id, record);
        return record;
    };
    const runShell = async (command, cwd, timeoutMs) => {
        const shell = process.platform === "win32" ? "cmd.exe" : "bash";
        const args = process.platform === "win32" ? ["/c", command] : ["-lc", command];
        return new Promise((resolve) => {
            const child = spawn(shell, args, {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            let finished = false;
            const timer = setTimeout(() => {
                if (finished)
                    return;
                finished = true;
                child.kill();
                resolve(`Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`);
            }, timeoutMs);
            const append = (data) => {
                output = truncate(`${output}${data.toString()}`);
            };
            child.stdout.on("data", append);
            child.stderr.on("data", append);
            child.on("close", (code) => {
                if (finished)
                    return;
                finished = true;
                clearTimeout(timer);
                if (code === 0) {
                    resolve(output || "Command completed successfully (no output).");
                }
                else {
                    resolve(`Command exited with code ${code}.\n\n${truncate(output)}`);
                }
            });
            child.on("error", (error) => {
                if (finished)
                    return;
                finished = true;
                clearTimeout(timer);
                resolve(`Failed to execute command: ${error.message}`);
            });
        });
    };
    const handleRead = async (args) => {
        const filePath = String(args.file_path ?? "");
        const pathCheck = ensureAbsolutePath(filePath);
        if (!pathCheck.ok)
            return { error: pathCheck.error };
        try {
            await fs.access(filePath);
        }
        catch {
            return { error: `File not found: ${filePath}` };
        }
        const offset = Number(args.offset ?? 1);
        const limit = Number(args.limit ?? 2000);
        try {
            const read = await readFileSafe(filePath);
            if (!read.ok)
                return { error: read.error };
            const formatted = formatWithLineNumbers(read.content, offset, limit);
            return {
                result: `File: ${filePath}\n${formatted.header}\n\n${formatted.body}`,
            };
        }
        catch (error) {
            return { error: `Error reading file: ${error.message}` };
        }
    };
    const handleWrite = async (args) => {
        const filePath = String(args.file_path ?? "");
        const content = String(args.content ?? "");
        const pathCheck = ensureAbsolutePath(filePath);
        if (!pathCheck.ok)
            return { error: pathCheck.error };
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, "utf-8");
            const lines = content.split("\n").length;
            return {
                result: `Wrote ${content.length} characters (${lines} lines) to ${filePath}`,
            };
        }
        catch (error) {
            return { error: `Error writing file: ${error.message}` };
        }
    };
    const handleEdit = async (args) => {
        const filePath = String(args.file_path ?? "");
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        const replaceAll = Boolean(args.replace_all ?? false);
        const pathCheck = ensureAbsolutePath(filePath);
        if (!pathCheck.ok)
            return { error: pathCheck.error };
        let content;
        try {
            content = await fs.readFile(filePath, "utf-8");
        }
        catch (error) {
            return { error: `Error reading file: ${error.message}` };
        }
        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
            return { error: "old_string not found in file." };
        }
        if (!replaceAll && occurrences > 1) {
            return {
                error: `old_string appears ${occurrences} times. Provide more context or set replace_all=true.`,
            };
        }
        const next = replaceAll
            ? content.split(oldString).join(newString)
            : content.replace(oldString, newString);
        try {
            await fs.writeFile(filePath, next, "utf-8");
            return {
                result: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${filePath}`,
            };
        }
        catch (error) {
            return { error: `Error writing file: ${error.message}` };
        }
    };
    const handleGlob = async (args) => {
        const pattern = String(args.pattern ?? "");
        const basePath = String(args.path ?? process.cwd());
        try {
            const stat = await fs.stat(basePath);
            if (!stat.isDirectory()) {
                return { error: `Path is not a directory: ${basePath}` };
            }
        }
        catch {
            return { error: `Directory not found: ${basePath}` };
        }
        const regex = globToRegExp(toPosix(pattern));
        const files = await walkFiles(basePath);
        const matches = files.filter((file) => {
            const rel = toPosix(path.relative(basePath, file));
            return regex.test(rel);
        });
        if (matches.length === 0) {
            return { result: `No files found matching "${pattern}" in ${basePath}` };
        }
        const withTimes = await Promise.all(matches.map(async (file) => {
            try {
                const stat = await fs.stat(file);
                return { file, mtime: stat.mtime.getTime() };
            }
            catch {
                return { file, mtime: 0 };
            }
        }));
        withTimes.sort((a, b) => b.mtime - a.mtime);
        return {
            result: `Found ${withTimes.length} files:\n\n${withTimes
                .map((entry) => entry.file)
                .join("\n")}`,
        };
    };
    const runRipgrep = async (args, cwd) => {
        return new Promise((resolve) => {
            const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (data) => {
                stdout += data.toString();
            });
            child.stderr.on("data", (data) => {
                stderr += data.toString();
            });
            child.on("error", (error) => {
                resolve({ ok: false, output: "", error: error.message });
            });
            child.on("close", (code) => {
                if (code === 0) {
                    resolve({ ok: true, output: stdout });
                }
                else if (code === 1) {
                    resolve({ ok: true, output: "" });
                }
                else {
                    resolve({ ok: false, output: stdout, error: stderr || `rg exited ${code}` });
                }
            });
        });
    };
    const handleGrep = async (args) => {
        const pattern = String(args.pattern ?? "");
        const basePath = String(args.path ?? process.cwd());
        const glob = args.glob ? String(args.glob) : undefined;
        const type = args.type ? String(args.type) : undefined;
        const outputMode = String(args.output_mode ?? "files_with_matches");
        const caseInsensitive = Boolean(args.case_insensitive ?? false);
        const contextLines = args.context_lines ? Number(args.context_lines) : undefined;
        const maxResults = args.max_results ? Number(args.max_results) : 100;
        try {
            await fs.access(basePath);
        }
        catch {
            return { error: `Path not found: ${basePath}` };
        }
        const rgArgs = [];
        if (outputMode === "files_with_matches")
            rgArgs.push("-l");
        if (outputMode === "count")
            rgArgs.push("-c");
        if (outputMode === "content") {
            rgArgs.push("-n");
            if (contextLines)
                rgArgs.push("-C", String(contextLines));
        }
        if (caseInsensitive)
            rgArgs.push("-i");
        if (glob)
            rgArgs.push("--glob", glob);
        if (type)
            rgArgs.push("--type", type);
        rgArgs.push("--max-count", String(maxResults));
        rgArgs.push(pattern, basePath);
        const rgResult = await runRipgrep(rgArgs, basePath);
        if (rgResult.ok) {
            const lines = rgResult.output.trim();
            if (!lines) {
                return { result: `No matches found for pattern: ${pattern}` };
            }
            return {
                result: `Found matches:\n\n${truncate(rgResult.output)}`,
            };
        }
        // Fallback: simple scan.
        const files = await walkFiles(basePath);
        const regex = new RegExp(pattern, caseInsensitive ? "gi" : "g");
        const results = [];
        for (const file of files) {
            const rel = toPosix(path.relative(basePath, file));
            if (glob) {
                const globRegex = globToRegExp(toPosix(glob));
                if (!globRegex.test(rel))
                    continue;
            }
            try {
                const read = await readFileSafe(file);
                if (!read.ok)
                    continue;
                const lines = read.content.split("\n");
                let matchCount = 0;
                lines.forEach((line, index) => {
                    if (regex.test(line)) {
                        matchCount += 1;
                        if (outputMode === "content") {
                            results.push(`${file}:${index + 1}:${line}`);
                        }
                    }
                    regex.lastIndex = 0;
                });
                if (matchCount > 0) {
                    if (outputMode === "files_with_matches") {
                        results.push(file);
                    }
                    else if (outputMode === "count") {
                        results.push(`${file}:${matchCount}`);
                    }
                }
            }
            catch {
                // Skip unreadable files.
            }
            if (results.length >= maxResults)
                break;
        }
        if (results.length === 0) {
            return { result: `No matches found for pattern: ${pattern}` };
        }
        return {
            result: `Found ${results.length} result(s):\n\n${truncate(results.join("\n"))}`,
        };
    };
    const handleBash = async (args) => {
        const command = String(args.command ?? "");
        const timeout = Math.min(Number(args.timeout ?? 120000), 600000);
        const cwd = String(args.working_directory ?? process.cwd());
        const runInBackground = Boolean(args.run_in_background ?? false);
        if (runInBackground) {
            const record = startShell(command, cwd);
            return {
                result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(record.output || "(no output yet)")}`,
            };
        }
        const output = await runShell(command, cwd, timeout);
        return { result: truncate(output) };
    };
    const handleKillShell = async (args) => {
        const shellId = String(args.shell_id ?? "");
        const record = shells.get(shellId);
        if (!record) {
            return { error: `Shell not found: ${shellId}` };
        }
        if (!record.running) {
            return {
                result: `Shell ${shellId} already completed.\nExit: ${record.exitCode ?? "?"}`,
            };
        }
        record.kill();
        return {
            result: `Killed shell ${shellId}.\n\nOutput:\n${truncate(record.output)}`,
        };
    };
    const handleWebFetch = async (args) => {
        const url = String(args.url ?? "");
        const prompt = String(args.prompt ?? "");
        const secureUrl = url.replace(/^http:/, "https:");
        try {
            const response = await fetch(secureUrl, {
                headers: {
                    "User-Agent": "StellarLocalHost/1.0",
                },
            });
            if (!response.ok) {
                return { error: `Failed to fetch (${response.status} ${response.statusText})` };
            }
            const text = await response.text();
            const contentType = response.headers.get("content-type") ?? "";
            const body = contentType.includes("text/html") ? stripHtml(text) : text;
            return {
                result: `Content from ${secureUrl}\nPrompt: ${prompt}\n\n${truncate(body, 15000)}`,
            };
        }
        catch (error) {
            return { error: `Error fetching URL: ${error.message}` };
        }
    };
    const flattenTopics = (topics) => {
        const results = [];
        for (const topic of topics) {
            if (!topic || typeof topic !== "object")
                continue;
            const record = topic;
            if (record.Text && record.FirstURL) {
                results.push({ title: record.Text, url: record.FirstURL });
            }
            if (record.Topics) {
                results.push(...flattenTopics(record.Topics));
            }
        }
        return results;
    };
    const handleWebSearch = async (args) => {
        const query = String(args.query ?? "");
        try {
            const url = new URL("https://api.duckduckgo.com/");
            url.searchParams.set("q", query);
            url.searchParams.set("format", "json");
            url.searchParams.set("no_html", "1");
            url.searchParams.set("skip_disambig", "1");
            const response = await fetch(url);
            if (!response.ok) {
                return { error: `Search failed (${response.status})` };
            }
            const data = (await response.json());
            const items = [];
            if (data.AbstractText && data.AbstractURL) {
                items.push({ title: data.AbstractText, url: data.AbstractURL });
            }
            if (Array.isArray(data.Results)) {
                for (const result of data.Results) {
                    if (result.Text && result.FirstURL) {
                        items.push({ title: result.Text, url: result.FirstURL });
                    }
                }
            }
            if (Array.isArray(data.RelatedTopics)) {
                items.push(...flattenTopics(data.RelatedTopics));
            }
            const unique = Array.from(new Map(items.map((item) => [item.url, item])).values()).slice(0, 6);
            if (unique.length === 0) {
                return { result: `No web results found for "${query}".` };
            }
            const formatted = unique
                .map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}`)
                .join("\n");
            return {
                result: `Web search results for "${query}":\n\n${formatted}`,
            };
        }
        catch (error) {
            return { error: `Search failed: ${error.message}` };
        }
    };
    const handleTodoWrite = async (args, context) => {
        const todos = Array.isArray(args.todos) ? args.todos : [];
        const inProgress = todos.filter((item) => typeof item === "object" && item && item.status === "in_progress");
        if (inProgress.length > 1) {
            return { error: "Only one todo can be in_progress at a time." };
        }
        const filePath = getStatePath(userDataPath, "todos", context.conversationId);
        await saveJson(filePath, todos);
        const completed = todos.filter((item) => typeof item === "object" && item.status === "completed").length;
        const formatted = todos
            .map((item) => {
            if (!item || typeof item !== "object")
                return "- Invalid todo";
            const todo = item;
            const icon = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]";
            return `${icon} ${todo.content ?? "(no content)"}`;
        })
            .join("\n");
        return {
            result: `Todos updated (${completed}/${todos.length} completed):\n\n${formatted}`,
        };
    };
    const handleTestWrite = async (args, context) => {
        const action = String(args.action ?? "");
        const filePath = getStatePath(userDataPath, "tests", context.conversationId);
        const current = await loadJson(filePath, []);
        if (action === "add") {
            const tests = Array.isArray(args.tests) ? args.tests : [];
            if (tests.length === 0) {
                return { error: "tests array is required for add action." };
            }
            const next = [
                ...current,
                ...tests.map((test) => {
                    const record = test;
                    return {
                        id: crypto.randomUUID(),
                        description: record.description ?? "(no description)",
                        filePath: record.filePath,
                        status: record.status ?? "planned",
                        acceptanceCriteria: record.acceptanceCriteria,
                    };
                }),
            ];
            await saveJson(filePath, next);
            return { result: `Added ${next.length - current.length} test(s).` };
        }
        if (action === "update_status") {
            const testId = String(args.testId ?? "");
            const newStatus = args.newStatus ? String(args.newStatus) : undefined;
            const newFilePath = args.newFilePath ? String(args.newFilePath) : undefined;
            const updated = current.map((test) => {
                if (test.id !== testId)
                    return test;
                return {
                    ...test,
                    ...(newStatus ? { status: newStatus } : {}),
                    ...(newFilePath ? { filePath: newFilePath } : {}),
                };
            });
            await saveJson(filePath, updated);
            return { result: `Updated test ${testId || "(unknown)"}.` };
        }
        return { error: `Unsupported action: ${action}` };
    };
    const handleTask = async (args) => {
        const description = String(args.description ?? "Task");
        const prompt = String(args.prompt ?? "");
        const id = crypto.randomUUID();
        const record = {
            id,
            description,
            status: "completed",
            result: `Task delegation is not implemented yet.\n\nDescription: ${description}\nPrompt: ${prompt}`,
            startedAt: Date.now(),
            completedAt: Date.now(),
        };
        tasks.set(id, record);
        return {
            result: `Agent completed.\nTask ID: ${id}\n\n--- Agent Result ---\n${record.result}`,
        };
    };
    const handleTaskOutput = async (args) => {
        const taskId = String(args.task_id ?? "");
        const record = tasks.get(taskId);
        if (!record) {
            return { error: `Task not found: ${taskId}` };
        }
        if (record.status === "completed") {
            const duration = (record.completedAt ?? Date.now()) - record.startedAt;
            return {
                result: `Task completed.\nDuration: ${duration}ms\n\n--- Result ---\n${record.result}`,
            };
        }
        if (record.status === "error") {
            const duration = (record.completedAt ?? Date.now()) - record.startedAt;
            return {
                result: `Task failed.\nDuration: ${duration}ms\n\n--- Error ---\n${record.error}`,
            };
        }
        const elapsed = Date.now() - record.startedAt;
        return {
            result: `Task still running.\nTask ID: ${taskId}\nElapsed: ${elapsed}ms`,
        };
    };
    const handleAskUser = async (args) => {
        const questions = Array.isArray(args.questions) ? args.questions : [];
        if (questions.length === 0) {
            return { error: "questions array is required." };
        }
        const summary = questions
            .map((question, index) => {
            if (!question || typeof question !== "object") {
                return `Question ${index + 1}: (invalid)`;
            }
            const record = question;
            const options = (record.options ?? [])
                .map((option, optionIndex) => {
                return `  ${optionIndex + 1}. ${option.label ?? "Option"} - ${option.description ?? ""}`;
            })
                .join("\n");
            return `Question ${index + 1}: ${record.question ?? ""}\n${options}`;
        })
            .join("\n\n");
        return {
            result: "User input is required. Ask the user directly in chat.\n\n" + truncate(summary, 8000),
        };
    };
    const notConfigured = (name) => ({
        result: `${name} is not configured on this device yet.`,
    });
    const handlers = {
        Read: (args) => handleRead(args),
        Write: (args) => handleWrite(args),
        Edit: (args) => handleEdit(args),
        Glob: (args) => handleGlob(args),
        Grep: (args) => handleGrep(args),
        Bash: (args) => handleBash(args),
        KillShell: (args) => handleKillShell(args),
        WebFetch: (args) => handleWebFetch(args),
        WebSearch: (args) => handleWebSearch(args),
        TodoWrite: (args, context) => handleTodoWrite(args, context),
        TestWrite: (args, context) => handleTestWrite(args, context),
        Task: (args) => handleTask(args),
        TaskOutput: (args) => handleTaskOutput(args),
        AskUserQuestion: (args) => handleAskUser(args),
        ImageGenerate: async () => notConfigured("ImageGenerate"),
        ImageEdit: async () => notConfigured("ImageEdit"),
        VideoGenerate: async () => notConfigured("VideoGenerate"),
    };
    const executeTool = async (toolName, toolArgs, context) => {
        const handler = handlers[toolName];
        if (!handler) {
            return { error: `Unknown tool: ${toolName}` };
        }
        try {
            return await handler(toolArgs, context);
        }
        catch (error) {
            return { error: `Tool ${toolName} failed: ${error.message}` };
        }
    };
    return {
        executeTool,
        getShells: () => Array.from(shells.values()),
    };
};
