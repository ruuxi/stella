import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { dispatchStellaSendMessage } from "@/shared/lib/stella-send-message";
import "./AskQuestionBubble.css";

const BADGE_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const OTHER_OPTION_KEY = "__other__";

export type AskQuestionOption = {
  label: string;
};

export type AskQuestion = {
  question: string;
  options: AskQuestionOption[];
  allowOther?: boolean;
};

export type AskQuestionPayload = {
  questions: AskQuestion[];
};

type Selection =
  | { kind: "option"; key: string }
  | { kind: "other"; text: string };

export function parseAskQuestionArgs(
  raw: unknown,
): AskQuestionPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const rawQuestions = (raw as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return null;

  const questions: AskQuestion[] = [];
  for (const entry of rawQuestions) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as {
      question?: unknown;
      options?: unknown;
      allowOther?: unknown;
    };
    const question =
      typeof record.question === "string" ? record.question.trim() : "";
    if (!question) continue;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options: AskQuestionOption[] = [];
    for (const option of rawOptions) {
      if (!option || typeof option !== "object") continue;
      const label =
        typeof (option as { label?: unknown }).label === "string"
          ? (option as { label: string }).label.trim()
          : "";
      if (!label) continue;
      options.push({ label });
    }
    if (options.length === 0) continue;
    questions.push({
      question,
      options,
      ...(record.allowOther === true ? { allowOther: true as const } : {}),
    });
  }

  if (questions.length === 0) return null;
  return { questions };
}

function describeSelection(
  question: AskQuestion,
  selection: Selection | undefined,
): string {
  if (!selection) return "(skipped)";
  if (selection.kind === "option") {
    const match = selection.key.match(/-opt-(\d+)$/);
    const optionIndex = match ? Number.parseInt(match[1], 10) : -1;
    if (optionIndex >= 0 && optionIndex < question.options.length) {
      return question.options[optionIndex].label;
    }
    return "(unknown)";
  }
  const text = selection.text.trim();
  return text.length > 0 ? `Other: ${text}` : "(skipped)";
}

function buildAnswersMessage(
  payload: AskQuestionPayload,
  selections: Record<number, Selection>,
): string {
  const lines: string[] = [];
  payload.questions.forEach((question, index) => {
    const answer = describeSelection(question, selections[index]);
    lines.push(`Q: ${question.question}`);
    lines.push(`A: ${answer}`);
    if (index < payload.questions.length - 1) {
      lines.push("");
    }
  });
  return lines.join("\n");
}

export const AskQuestionBubble = memo(function AskQuestionBubble({
  payload,
}: {
  payload: AskQuestionPayload;
}) {
  const total = payload.questions.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, Selection>>({});
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const safeIndex = Math.min(Math.max(activeIndex, 0), total - 1);
  const isFirst = safeIndex === 0;
  const isLast = safeIndex === total - 1;
  const currentSelection = selections[safeIndex];
  const hasAnswer = Boolean(
    currentSelection &&
      (currentSelection.kind === "option" ||
        (currentSelection.kind === "other" && currentSelection.text.trim().length > 0)),
  );

  const goPrev = useCallback(() => {
    if (isFirst || submitted) return;
    setEditingIndex(null);
    setActiveIndex((i) => Math.max(0, i - 1));
  }, [isFirst, submitted]);

  const submitAnswers = useCallback(
    (kind: "answers" | "skip") => {
      if (submitted) return;
      const text =
        kind === "skip"
          ? "(skipped questions)"
          : buildAnswersMessage(payload, selections);
      setSubmitted(true);
      setEditingIndex(null);
      dispatchStellaSendMessage({
        text,
        triggerKind: "ask_question_response",
        triggerSource: "ask-question-bubble",
      });
    },
    [payload, selections, submitted],
  );

  const goNextOrSubmit = useCallback(() => {
    if (submitted) return;
    if (!hasAnswer) return;
    setEditingIndex(null);
    if (isLast) {
      submitAnswers("answers");
      return;
    }
    setActiveIndex((i) => Math.min(total - 1, i + 1));
  }, [hasAnswer, isLast, submitAnswers, submitted, total]);

  const handlePickOption = useCallback(
    (questionIndex: number, optionKey: string) => {
      if (submitted) return;
      setSelections((prev) => ({
        ...prev,
        [questionIndex]: { kind: "option", key: optionKey },
      }));
      setActiveIndex(questionIndex);
      setEditingIndex(null);
    },
    [submitted],
  );

  const handleStartOther = useCallback(
    (questionIndex: number) => {
      if (submitted) return;
      setActiveIndex(questionIndex);
      setEditingIndex(questionIndex);
      setSelections((prev) => {
        const existing = prev[questionIndex];
        if (existing && existing.kind === "other") return prev;
        return {
          ...prev,
          [questionIndex]: { kind: "other", text: "" },
        };
      });
    },
    [submitted],
  );

  const handleOtherChange = useCallback(
    (questionIndex: number, text: string) => {
      if (submitted) return;
      setSelections((prev) => ({
        ...prev,
        [questionIndex]: { kind: "other", text },
      }));
    },
    [submitted],
  );

  const handleOtherSubmit = useCallback(() => {
    if (submitted || !hasAnswer) return;
    goNextOrSubmit();
  }, [goNextOrSubmit, hasAnswer, submitted]);

  const handleStepActivate = useCallback(
    (questionIndex: number) => {
      if (submitted) return;
      setActiveIndex(questionIndex);
      setEditingIndex(null);
    },
    [submitted],
  );

  return (
    <div
      className="ask-question-bubble"
      tabIndex={-1}
      data-submitted={submitted ? "true" : undefined}
      aria-disabled={submitted ? "true" : undefined}
    >
      <div className="ask-question-bubble__header">
        <span className="ask-question-bubble__label">
          {submitted ? "Answered" : "Questions"}
        </span>
        <div className="ask-question-bubble__stepper">
          <button
            type="button"
            className="ask-question-bubble__nav"
            disabled={isFirst || submitted}
            onClick={goPrev}
            aria-label="Previous question"
          >
            <ChevronIcon direction="left" />
          </button>
          <span className="ask-question-bubble__counter">
            {safeIndex + 1} of {total}
          </span>
          <button
            type="button"
            className="ask-question-bubble__nav"
            disabled={isLast || submitted}
            onClick={goNextOrSubmit}
            aria-label="Next question"
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
      </div>

      <div className="ask-question-bubble__body">
        <div className="ask-question-bubble__steps">
          {payload.questions.map((question, index) => (
            <QuestionStep
              key={`q-${index}`}
              index={index}
              question={question}
              isActive={index === safeIndex}
              selection={selections[index]}
              isEditingOther={editingIndex === index}
              disabled={submitted}
              onActivate={() => handleStepActivate(index)}
              onPickOption={(optionKey) => handlePickOption(index, optionKey)}
              onStartOther={() => handleStartOther(index)}
              onOtherChange={(text) => handleOtherChange(index, text)}
              onOtherSubmit={handleOtherSubmit}
              onStopEditingOther={() => setEditingIndex(null)}
            />
          ))}
        </div>
      </div>

      <div className="ask-question-bubble__actions">
        <button
          type="button"
          className="ask-question-bubble__button"
          data-variant="text"
          disabled={submitted}
          onClick={() => submitAnswers("skip")}
        >
          Skip
        </button>
        <button
          type="button"
          className="ask-question-bubble__button"
          data-variant="primary"
          disabled={!hasAnswer || submitted}
          onClick={goNextOrSubmit}
        >
          <span>{submitted ? "Sent" : isLast ? "Done" : "Next"}</span>
          {!submitted && (
            <span className="ask-question-bubble__shortcut">⏎</span>
          )}
        </button>
      </div>
    </div>
  );
});

const QuestionStep = memo(function QuestionStep({
  index,
  question,
  isActive,
  selection,
  isEditingOther,
  disabled,
  onActivate,
  onPickOption,
  onStartOther,
  onOtherChange,
  onOtherSubmit,
  onStopEditingOther,
}: {
  index: number;
  question: AskQuestion;
  isActive: boolean;
  selection: Selection | undefined;
  isEditingOther: boolean;
  disabled: boolean;
  onActivate: () => void;
  onPickOption: (optionKey: string) => void;
  onStartOther: () => void;
  onOtherChange: (text: string) => void;
  onOtherSubmit: () => void;
  onStopEditingOther: () => void;
}) {
  const handleStepKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (isActive || disabled) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
    [disabled, isActive, onActivate],
  );

  const optionEntries = useMemo(() => {
    const entries = question.options.map((option, optionIndex) => ({
      key: `q-${index}-opt-${optionIndex}`,
      letter: BADGE_LETTERS[optionIndex] ?? "?",
      label: option.label,
      isOther: false,
    }));
    if (question.allowOther) {
      entries.push({
        key: OTHER_OPTION_KEY,
        letter: BADGE_LETTERS[question.options.length] ?? "?",
        label: "Other...",
        isOther: true,
      });
    }
    return entries;
  }, [index, question.allowOther, question.options]);

  return (
    <div
      className="ask-question-bubble__step"
      data-active={isActive ? "true" : "false"}
      {...(isActive || disabled
        ? {}
        : {
            role: "button",
            tabIndex: 0,
            onClick: onActivate,
            onKeyDown: handleStepKeyDown,
          })}
    >
      <p className="ask-question-bubble__step-prompt">{question.question}</p>
      <div className="ask-question-bubble__options">
        {optionEntries.map((entry) => {
          if (entry.isOther) {
            const isSelected = selection?.kind === "other";
            const otherText = isSelected ? selection.text : "";
            return (
              <OtherOption
                key={entry.key}
                letter={entry.letter}
                isActive={isActive}
                isEditing={isEditingOther}
                isSelected={isSelected}
                value={otherText}
                disabled={disabled}
                onStartEditing={onStartOther}
                onChange={onOtherChange}
                onSubmit={onOtherSubmit}
                onStopEditing={onStopEditingOther}
              />
            );
          }
          const isSelected =
            selection?.kind === "option" && selection.key === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              className="ask-question-bubble__option"
              data-selected={isSelected ? "true" : undefined}
              tabIndex={isActive && !disabled ? 0 : -1}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onPickOption(entry.key);
              }}
            >
              <span className="ask-question-bubble__badge">{entry.letter}</span>
              <span className="ask-question-bubble__option-label">
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

function OtherOption({
  letter,
  isActive,
  isEditing,
  isSelected,
  value,
  disabled,
  onStartEditing,
  onChange,
  onSubmit,
  onStopEditing,
}: {
  letter: string;
  isActive: boolean;
  isEditing: boolean;
  isSelected: boolean;
  value: string;
  disabled: boolean;
  onStartEditing: () => void;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onStopEditing: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && !disabled) {
      inputRef.current?.focus();
    }
  }, [disabled, isEditing]);

  if (isEditing && !disabled) {
    return (
      <div
        className="ask-question-bubble__option ask-question-bubble__option--editing"
        data-selected="true"
        onClick={(event) => {
          event.stopPropagation();
          inputRef.current?.focus();
        }}
      >
        <span className="ask-question-bubble__badge">{letter}</span>
        <input
          ref={inputRef}
          type="text"
          className="ask-question-bubble__option-input"
          placeholder="Type your answer..."
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              onStopEditing();
            } else if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className="ask-question-bubble__option"
      data-selected={isSelected ? "true" : undefined}
      tabIndex={isActive && !disabled ? 0 : -1}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onStartEditing();
      }}
    >
      <span className="ask-question-bubble__badge">{letter}</span>
      <span
        className="ask-question-bubble__option-label"
        data-placeholder={isSelected && value.trim().length > 0 ? undefined : "true"}
      >
        {isSelected && value.trim().length > 0 ? value : "Other..."}
      </span>
    </button>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  const d = direction === "left" ? "M9.5 4l-4 4 4 4" : "M6.5 4l4 4-4 4";
  return (
    <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
