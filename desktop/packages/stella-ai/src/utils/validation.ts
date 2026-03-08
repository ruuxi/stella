import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { ErrorObject } from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";

import type { Tool, ToolCall } from "../types.js";

type MaybeDefaultExport<T> = T & { default?: T };

function resolveDefaultExport<T>(module: MaybeDefaultExport<T>): T {
	return module.default ?? module;
}

// Handle both default and named exports
const Ajv = resolveDefaultExport(AjvModule);
const addFormats = resolveDefaultExport(addFormatsModule);

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
type ChromeRuntimeGlobal = typeof globalThis & {
	chrome?: {
		runtime?: {
			id?: string;
		};
	};
};

const isBrowserExtension =
	typeof globalThis !== "undefined" && (globalThis as ChromeRuntimeGlobal).chrome?.runtime?.id !== undefined;

// Create a singleton AJV instance with formats (only if not in browser extension)
// AJV requires 'unsafe-eval' CSP which is not allowed in Manifest V3
let ajv: InstanceType<typeof Ajv> | null = null;
if (!isBrowserExtension) {
	try {
		ajv = new Ajv({
			allErrors: true,
			strict: false,
			coerceTypes: true,
		});
		addFormats(ajv);
	} catch (_e) {
		// AJV initialization failed (likely CSP restriction)
		console.warn("AJV validation disabled due to CSP restrictions");
	}
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall<TParameters extends TSchema>(
	tools: Tool<TParameters>[],
	toolCall: ToolCall,
): Static<TParameters> {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments<TParameters extends TSchema>(
	tool: Tool<TParameters>,
	toolCall: ToolCall,
): Static<TParameters> {
	// Skip validation in browser extension environment (CSP restrictions prevent AJV from working)
	if (!ajv || isBrowserExtension) {
		// Trust the LLM's output without validation
		// Browser extensions can't use AJV due to Manifest V3 CSP restrictions
		return toolCall.arguments as Static<TParameters>;
	}

	// Compile the schema
	const validate = ajv.compile(tool.parameters);

	// Clone arguments so AJV can safely mutate for type coercion
	const args = structuredClone(toolCall.arguments) as Static<TParameters>;

	// Validate the arguments (AJV mutates args in-place for type coercion)
	if (validate(args)) {
		return args;
	}

	// Format validation errors nicely
	const errors =
		validate.errors
			?.map((err: ErrorObject) => {
				const missingProperty =
					typeof err.params === "object" &&
					err.params !== null &&
					"missingProperty" in err.params &&
					typeof err.params.missingProperty === "string"
						? err.params.missingProperty
						: undefined;
				const path = err.instancePath ? err.instancePath.substring(1) : missingProperty || "root";
				return `  - ${path}: ${err.message}`;
			})
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
