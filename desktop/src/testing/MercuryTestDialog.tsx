import { useState, useRef, useEffect } from "react";
import { Dialog } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { createServiceRequest } from "@/services/http/service-request";
import "./mercury-test-dialog.css";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Message = {
  role: "user" | "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/** Fake tools to send with every request so we can observe Mercury's tool-call behavior. */
const FAKE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get the current weather in a given location",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "A brief natural language message to show the user explaining what you're doing and why",
          },
          location: {
            type: "string",
            description: "City and state, e.g. 'San Francisco, CA'",
          },
          unit: {
            type: "string",
            enum: ["celsius", "fahrenheit"],
          },
        },
        required: ["description", "location", "unit"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_web",
      description: "Search the web for information on a topic",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "A brief natural language message to show the user explaining what you're doing and why",
          },
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["description", "query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_code",
      description: "Execute a snippet of Python code and return the output",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "A brief natural language message to show the user explaining what you're doing and why",
          },
          code: {
            type: "string",
            description: "The Python code to execute",
          },
        },
        required: ["description", "code"],
      },
    },
  },
];

export default function MercuryTestDialog({ open, onOpenChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, rawResponse]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setLoading(true);
    setRawResponse(null);

    try {
      const { endpoint, headers } = await createServiceRequest("/api/ai/llm-proxy", {
        "Content-Type": "application/json",
        "X-Provider": "inception",
        "X-Original-Path": "/v1/chat/completions",
        "X-Model-Id": "inception/mercury-2",
        "X-Agent-Type": "mercury-test",
      });

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "inception/mercury-2",
          messages: [
            {
              role: "system",
              content: "Always include a brief natural language response in your message content, even when calling tools. Your content field should never be empty.",
            },
            ...history.map((m) => ({
              role: m.role,
              content: m.content ?? "",
            })),
          ],
          tools: FAKE_TOOLS,
          max_tokens: 2000,
        }),
      });

      const data = await res.json();
      setRawResponse(JSON.stringify(data, null, 2));

      const choice = data.choices?.[0]?.message;
      if (choice) {
        const assistantMsg: Message = {
          role: "assistant",
          content: choice.content ?? null,
          tool_calls: choice.tool_calls ?? undefined,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (err) {
      setRawResponse(
        JSON.stringify({ error: String(err) }, null, 2),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="xl" className="mercury-test-content">
        <Dialog.Header>
          <Dialog.Title>Mercury Test</Dialog.Title>
          <Dialog.Description>
            Chat with Mercury to inspect raw responses — text, tool_calls, or both.
          </Dialog.Description>
          <Dialog.CloseButton />
        </Dialog.Header>
        <Dialog.Body>
          <div className="mercury-test-layout">
            {/* Left: Chat */}
            <div className="mercury-test-chat">
              <div className="mercury-test-tools-banner">
                Tools: {FAKE_TOOLS.map((t) => t.function.name).join(", ")}
              </div>

              <div className="mercury-test-messages" ref={scrollRef}>
                {messages.length === 0 && (
                  <div className="mercury-test-empty">
                    Send a message to test Mercury's response format.
                    <br />
                    Try asking about the weather to trigger tool calls.
                  </div>
                )}
                {messages.map((msg, i) => (
                  <div key={i} className="mercury-test-msg" data-role={msg.role}>
                    <div className="mercury-test-msg-role">{msg.role}</div>
                    {msg.content && (
                      <div className="mercury-test-msg-content">{msg.content}</div>
                    )}
                    {msg.tool_calls && msg.tool_calls.length > 0 && (
                      <div className="mercury-test-msg-tools">
                        {msg.tool_calls.map((tc) => (
                          <div key={tc.id} className="mercury-test-tool-call">
                            <span className="mercury-test-tool-name">
                              {tc.function.name}
                            </span>
                            <pre className="mercury-test-tool-args">
                              {JSON.stringify(JSON.parse(tc.function.arguments), null, 2)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.role === "assistant" && !msg.content && !msg.tool_calls?.length && (
                      <div className="mercury-test-msg-content mercury-test-empty-content">
                        (empty content, no tool calls)
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="mercury-test-msg" data-role="assistant">
                    <div className="mercury-test-msg-role">assistant</div>
                    <div className="mercury-test-msg-content mercury-test-loading">
                      Waiting for Mercury...
                    </div>
                  </div>
                )}
              </div>

              <div className="mercury-test-input-row">
                <input
                  className="mercury-test-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder="Type a message..."
                  disabled={loading}
                />
                <Button
                  variant="primary"
                  size="normal"
                  onClick={() => void sendMessage()}
                  disabled={loading || !input.trim()}
                >
                  Send
                </Button>
              </div>
            </div>

            {/* Right: Raw JSON */}
            <div className="mercury-test-raw">
              <div className="mercury-test-raw-label">Raw API Response</div>
              <pre className="mercury-test-raw-json">
                {rawResponse ?? "No response yet."}
              </pre>
            </div>
          </div>
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
