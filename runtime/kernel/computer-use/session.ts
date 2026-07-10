import {
  parseComputerUseRequest,
  parseComputerUseResponse,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseResponseFor,
} from "./contract.js";

export type ComputerUseSessionRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export interface ComputerUseSession {
  request(
    request: ComputerUseRequest,
    options?: ComputerUseSessionRequestOptions,
  ): Promise<unknown>;
}

export type ComputerUseSessionHandler = ComputerUseSession["request"];

export const createComputerUseSession = (
  handler: ComputerUseSessionHandler,
): ComputerUseSession => {
  if (typeof handler !== "function") {
    throw new TypeError("ComputerUseSession handler must be a function.");
  }
  return Object.freeze({ request: handler });
};

export class ComputerUseSessionError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(response: Extract<ComputerUseResponse, { type: "error" }>) {
    super(response.error.message);
    this.name = "ComputerUseSessionError";
    this.code = response.error.code;
    this.requestId = response.requestId;
    this.retryable = response.error.retryable ?? false;
  }
}

export class ComputerUseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUseProtocolError";
  }
}

const expectedResponseType = (
  request: ComputerUseRequest,
): ComputerUseResponse["type"] => {
  if (request.type === "get_app_state") return "app_state";
  if (request.type === "resolve_target") return "target_policy";
  return request.type;
};

const sameTarget = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const assertReceiptMatchesRequest = (
  request: ComputerUseRequest,
  response: ComputerUseResponse,
) => {
  if (request.type === "action" && response.type === "action") {
    if (response.receipt.action !== request.command.action.type) {
      throw new ComputerUseProtocolError(
        `Computer-use action receipt reported ${response.receipt.action} for ${request.command.action.type}.`,
      );
    }
    if (!sameTarget(response.receipt.target, request.command.target)) {
      throw new ComputerUseProtocolError(
        "Computer-use action receipt target does not match its request.",
      );
    }
  }
  if (request.type === "batch" && response.type === "batch") {
    if (response.receipt.receipts.length !== request.commands.length) {
      throw new ComputerUseProtocolError(
        "Computer-use batch receipt count does not match its request.",
      );
    }
    response.receipt.receipts.forEach((receipt, index) => {
      const command = request.commands[index]!;
      if (
        receipt.action !== command.action.type ||
        !sameTarget(receipt.target, command.target)
      ) {
        throw new ComputerUseProtocolError(
          `Computer-use batch receipt ${index} does not match its request command.`,
        );
      }
    });
  }
};

export const executeComputerUseRequest = async <
  TRequest extends ComputerUseRequest,
>(
  session: ComputerUseSession,
  request: TRequest,
  options?: ComputerUseSessionRequestOptions,
): Promise<Exclude<ComputerUseResponseFor<TRequest>, { type: "error" }>> => {
  if (!session || typeof session.request !== "function") {
    throw new TypeError("A ComputerUseSession is required.");
  }
  parseComputerUseRequest(request);

  const rawResponse = await session.request(request, options);
  let response: ComputerUseResponse;
  try {
    response = parseComputerUseResponse(rawResponse);
  } catch (cause) {
    throw new ComputerUseProtocolError(
      `Computer-use session returned an invalid response: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (
    response.requestId !== request.requestId ||
    response.sessionId !== request.sessionId
  ) {
    throw new ComputerUseProtocolError(
      "Computer-use response correlation does not match its request.",
    );
  }
  if (response.type === "error") {
    throw new ComputerUseSessionError(response);
  }
  const expected = expectedResponseType(request);
  if (response.type !== expected) {
    throw new ComputerUseProtocolError(
      `Computer-use session returned ${response.type} for ${request.type}; expected ${expected}.`,
    );
  }
  assertReceiptMatchesRequest(request, response);
  return response as Exclude<
    ComputerUseResponseFor<TRequest>,
    { type: "error" }
  >;
};
