import type { AgentCallbacks } from "./types.js";

export type AutomationTurnResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string };

type AutomationTurnResolver = (value: AutomationTurnResult) => void;

const getRuntimeErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "Stella runtime failed";
};

export const createAutomationErrorResult = (
  error: string,
): AutomationTurnResult => ({
  status: "error",
  finalText: "",
  error,
});

export const createAutomationSuccessResult = (
  finalText: string,
): AutomationTurnResult => ({
  status: "ok",
  finalText,
});

export const createAutomationAgentCallbacks = (
  resolveResult: AutomationTurnResolver,
): AgentCallbacks => ({
  onStream: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onError: (event) => {
    resolveResult(createAutomationErrorResult(event.error || "Stella runtime failed"));
  },
  onEnd: (event) => {
    resolveResult(createAutomationSuccessResult(event.finalText));
  },
});

export const createAutomationFatalErrorHandler =
  (resolveResult: AutomationTurnResolver) => (error: unknown) => {
    resolveResult(createAutomationErrorResult(getRuntimeErrorMessage(error)));
  };

export const createOrchestratorFatalErrorHandler = (args: {
  runId: string;
  agentType: string;
  callbacks: Pick<AgentCallbacks, "onError">;
}) => {
  return (error: unknown) => {
    args.callbacks.onError({
      runId: args.runId,
      agentType: args.agentType,
      seq: Date.now(),
      error: getRuntimeErrorMessage(error),
      fatal: true,
    });
  };
};
