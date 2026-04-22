import { memo, useMemo, useState } from "react";
import "./AskQuestionBubble.css";

const BADGE_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

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

const OTHER_OPTION_KEY = "__other__";

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

export const AskQuestionBubble = memo(function AskQuestionBubble({
  payload,
}: {
  payload: AskQuestionPayload;
}) {
  const total = payload.questions.length;
  const [activeIndex, setActiveIndex] = useState(0);
  const [selections, setSelections] = useState<Record<number, string>>({});

  const safeIndex = Math.min(Math.max(activeIndex, 0), total - 1);
  const isFirst = safeIndex === 0;
  const isLast = safeIndex === total - 1;
  const hasAnswer = Object.prototype.hasOwnProperty.call(selections, safeIndex);

  const goPrev = () => {
    if (isFirst) return;
    setActiveIndex((i) => Math.max(0, i - 1));
  };

  const goNext = () => {
    if (isLast) return;
    setActiveIndex((i) => Math.min(total - 1, i + 1));
  };

  const handlePick = (questionIndex: number, optionKey: string) => {
    setSelections((prev) => ({ ...prev, [questionIndex]: optionKey }));
    setActiveIndex(questionIndex);
  };

  return (
    <div className="ask-question-bubble" tabIndex={-1}>
      <div className="ask-question-bubble__header">
        <span className="ask-question-bubble__label">Questions</span>
        <div className="ask-question-bubble__stepper">
          <button
            type="button"
            className="ask-question-bubble__nav"
            disabled={isFirst}
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
            disabled={isLast}
            onClick={goNext}
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
              selectedKey={selections[index]}
              onActivate={() => setActiveIndex(index)}
              onPick={(optionKey) => handlePick(index, optionKey)}
            />
          ))}
        </div>
      </div>

      <div className="ask-question-bubble__actions">
        <button
          type="button"
          className="ask-question-bubble__button"
          data-variant="text"
        >
          Skip
        </button>
        <button
          type="button"
          className="ask-question-bubble__button"
          data-variant="primary"
          disabled={!hasAnswer}
        >
          <span>{isLast ? "Done" : "Next"}</span>
          <span className="ask-question-bubble__shortcut">⏎</span>
        </button>
      </div>
    </div>
  );
});

const QuestionStep = memo(function QuestionStep({
  index,
  question,
  isActive,
  selectedKey,
  onActivate,
  onPick,
}: {
  index: number;
  question: AskQuestion;
  isActive: boolean;
  selectedKey: string | undefined;
  onActivate: () => void;
  onPick: (optionKey: string) => void;
}) {
  const stepProps = isActive
    ? ({ "data-active": "true" } as const)
    : ({
        "data-active": "false",
        role: "button",
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate();
          }
        },
      } as const);

  const optionEntries = useMemo(() => {
    const entries = question.options.map((option, optionIndex) => ({
      key: `q-${index}-opt-${optionIndex}`,
      letter: BADGE_LETTERS[optionIndex] ?? "?",
      label: option.label,
      isPlaceholder: false,
    }));
    if (question.allowOther) {
      entries.push({
        key: OTHER_OPTION_KEY,
        letter: BADGE_LETTERS[question.options.length] ?? "?",
        label: "Other...",
        isPlaceholder: true,
      });
    }
    return entries;
  }, [index, question.allowOther, question.options]);

  return (
    <div className="ask-question-bubble__step" {...stepProps}>
      <p className="ask-question-bubble__step-prompt">{question.question}</p>
      <div className="ask-question-bubble__options">
        {optionEntries.map((entry) => {
          const isSelected = selectedKey === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              className="ask-question-bubble__option"
              data-selected={isSelected ? "true" : undefined}
              tabIndex={isActive ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation();
                onPick(entry.key);
              }}
            >
              <span className="ask-question-bubble__badge">{entry.letter}</span>
              <span
                className="ask-question-bubble__option-label"
                data-placeholder={entry.isPlaceholder ? "true" : undefined}
              >
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

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
