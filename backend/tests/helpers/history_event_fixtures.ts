export type EventLike = {
  _id: string;
  _creationTime: number;
  conversationId: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
  requestId?: string;
  targetDeviceId?: string;
  deviceId?: string;
};

export const createEventFactory = (conversationId = "conv_1") => {
  let seq = 0;

  const makeEvent = (args: Partial<EventLike>): EventLike => {
    seq += 1;
    return {
      _id: `evt_${seq}`,
      _creationTime: Date.now(),
      conversationId,
      timestamp: seq,
      type: "assistant_message",
      payload: {},
      ...args,
    };
  };

  const makeToolPair = (requestId: string, resultChars = 64_000): EventLike[] => [
    makeEvent({
      type: "tool_request",
      requestId,
      payload: {
        toolName: "Read",
        args: { file_path: `/tmp/${requestId}.ts` },
        agentType: "orchestrator",
      },
    }),
    makeEvent({
      type: "tool_result",
      requestId,
      payload: {
        toolName: "Read",
        result: "x".repeat(resultChars),
        agentType: "orchestrator",
      },
    }),
  ];

  const reset = () => {
    seq = 0;
  };

  return { makeEvent, makeToolPair, reset };
};
