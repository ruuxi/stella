/**
 * State tools: TodoWrite, TestWrite, Task, TaskOutput handlers.
 */
import { getStatePath, loadJson, saveJson, truncate } from "./tools-utils.js";
export const createStateContext = (stateRoot) => ({
    stateRoot,
    tasks: new Map(),
});
export const handleTodoWrite = async (ctx, args, context) => {
    const todos = Array.isArray(args.todos) ? args.todos : [];
    const inProgress = todos.filter((item) => typeof item === "object" && item && item.status === "in_progress");
    if (inProgress.length > 1) {
        return { error: "Only one todo can be in_progress at a time." };
    }
    const filePath = getStatePath(ctx.stateRoot, "todos", context.conversationId);
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
export const handleTestWrite = async (ctx, args, context) => {
    const action = String(args.action ?? "");
    const filePath = getStatePath(ctx.stateRoot, "tests", context.conversationId);
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
export const handleTask = async (ctx, args) => {
    const description = String(args.description ?? "Task");
    const id = crypto.randomUUID();
    const record = {
        id,
        description,
        status: "completed",
        result: "Task delegation is handled server-side. This device should not receive Task requests.",
        startedAt: Date.now(),
        completedAt: Date.now(),
    };
    ctx.tasks.set(id, record);
    return {
        result: `Agent completed.\nTask ID: ${id}\n\n--- Agent Result ---\n${record.result}`,
    };
};
export const handleTaskOutput = async (ctx, args) => {
    const taskId = String(args.task_id ?? "");
    const record = ctx.tasks.get(taskId);
    if (!record) {
        return { error: `Task not found: ${taskId}` };
    }
    if (record.status === "completed") {
        const duration = (record.completedAt ?? Date.now()) - record.startedAt;
        return {
            result: `Task completed.\nDuration: ${duration}ms\n\n--- Result ---\n${truncate(record.result ?? "")}`,
        };
    }
    if (record.status === "error") {
        const duration = (record.completedAt ?? Date.now()) - record.startedAt;
        return {
            result: `Task failed.\nDuration: ${duration}ms\n\n--- Error ---\n${truncate(record.error ?? "")}`,
        };
    }
    const elapsed = Date.now() - record.startedAt;
    return {
        result: `Task still running.\nTask ID: ${taskId}\nElapsed: ${elapsed}ms`,
    };
};
