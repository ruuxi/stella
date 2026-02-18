import { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { useUiState } from "../../app/state/ui-state";
import { useContextCapture } from "./use-context-capture";
import { useMiniChat } from "./use-mini-chat";
import { useVoiceInput } from "../../hooks/use-voice-input";
import { MiniInput } from "./MiniInput";
import { MiniOutput } from "./MiniOutput";
import { StellaAnimation } from "../../components/StellaAnimation";
import { useIsLocalMode } from "@/providers/DataProvider";
import { useLocalQuery } from "@/hooks/use-local-query";

export const MiniShell = () => {
  const { setWindow } = useUiState();
  const isLocalMode = useIsLocalMode();
  const [isStreaming, setIsStreaming] = useState(false);

  const {
    chatContext,
    setChatContext,
    selectedText,
    setSelectedText,
    shellVisible,
    previewIndex,
    setPreviewIndex,
  } = useContextCapture();

  const {
    message,
    setMessage,
    streamingText,
    reasoningText,
    pendingUserMessageId,
    events,
    sendMessage,
  } = useMiniChat({
    chatContext,
    selectedText,
    setChatContext,
    setSelectedText,
    isStreaming,
    setIsStreaming,
  });

  // STT voice input
  const sttCloud = useQuery(
    api.data.stt.checkSttAvailable,
    !isLocalMode ? {} : "skip",
  ) as
    | { available: boolean }
    | undefined;
  const sttLocal = useLocalQuery<{ available: boolean }>(
    isLocalMode ? "/api/stt/check-available" : null,
  );
  const sttAvailable = isLocalMode
    ? (sttLocal.data?.available ?? false)
    : (sttCloud?.available ?? false);
  const [partialTranscript, setPartialTranscript] = useState("");

  const voice = useVoiceInput({
    onPartialTranscript: setPartialTranscript,
    onFinalTranscript: useCallback((text: string) => {
      setMessage((prev: string) => (prev ? prev + " " + text : text));
      setPartialTranscript("");
    }, [setMessage]),
    onError: useCallback((err: string) => {
      console.warn("STT error:", err);
      setPartialTranscript("");
    }, []),
  });

  const hasConversation = events.length > 0 || Boolean(streamingText);

  const windowTitle = chatContext?.window
    ? (chatContext.window.title || chatContext.window.app || null)
    : null;

  const handleShellClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      if (previewIndex !== null) {
        setPreviewIndex(null);
      } else {
        window.electronAPI?.closeWindow?.();
      }
    }
  };

  return (
    <div
      className={`raycast-shell${shellVisible ? " is-visible" : ""}`}
      onClick={handleShellClick}
    >
      <div className="raycast-panel">
        <div className="mini-titlebar">
          <div className="mini-titlebar-left">
            <StellaAnimation width={40} height={40} paused={!shellVisible} />
          </div>
          <span className="mini-titlebar-title">
            {windowTitle ?? "Stella"}
          </span>
          <div className="mini-titlebar-right">
            <button
              className="mini-titlebar-action"
              type="button"
              onClick={() => setWindow("full")}
              title="Expand to full view"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </div>
        </div>

        <MiniOutput
          events={events}
          streamingText={streamingText}
          reasoningText={reasoningText}
          isStreaming={isStreaming}
          pendingUserMessageId={pendingUserMessageId}
          showConversation={hasConversation}
        />

        <MiniInput
          message={message}
          setMessage={setMessage}
          chatContext={chatContext}
          setChatContext={setChatContext}
          selectedText={selectedText}
          setSelectedText={setSelectedText}
          shellVisible={shellVisible}
          previewIndex={previewIndex}
          setPreviewIndex={setPreviewIndex}
          isStreaming={isStreaming}
          onSend={() => void sendMessage()}
          sttAvailable={sttAvailable}
          voiceState={voice.state}
          onStartVoice={voice.startRecording}
          onStopVoice={voice.stopRecording}
          partialTranscript={partialTranscript}
        />
      </div>

      {previewIndex !== null &&
        chatContext?.regionScreenshots?.[previewIndex] && (
          <div className="raycast-screenshot-overlay">
            <div className="raycast-screenshot-preview-container">
              <img
                src={chatContext.regionScreenshots[previewIndex].dataUrl}
                className="raycast-screenshot-preview"
                alt="Screenshot preview"
              />
              <button
                type="button"
                className="raycast-screenshot-close"
                onClick={() => setPreviewIndex(null)}
                aria-label="Close preview"
              >
                &times;
              </button>
            </div>
          </div>
        )}
    </div>
  );
};
