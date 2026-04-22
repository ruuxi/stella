import "./cursor-demo.css";

type TodoStatus = "completed" | "in-progress" | "pending";

type TodoItem = {
  id: string;
  status: TodoStatus;
  label: string;
};

const TODO_ITEMS: ReadonlyArray<TodoItem> = [
  { id: "todo-1", status: "completed", label: "Set up the demo project scaffold" },
  { id: "todo-2", status: "in-progress", label: "Write the placeholder API client" },
  { id: "todo-3", status: "pending", label: "Add end-to-end tests (pending API contract)" },
  { id: "todo-4", status: "pending", label: "Polish error states and empty UI" },
];

type QuestionOption = {
  id: string;
  label: string;
  isPlaceholder?: boolean;
};

type Question = {
  id: string;
  prompt: string;
  options: ReadonlyArray<QuestionOption>;
};

const QUESTIONS: ReadonlyArray<Question> = [
  {
    id: "q1",
    prompt: "Which fictional backend would you pick for a weekend prototype?",
    options: [
      { id: "q1-a", label: "Convex (realtime + functions)" },
      { id: "q1-b", label: "SQLite + a tiny HTTP server" },
      { id: "q1-c", label: "Static JSON in the repo only" },
      { id: "q1-d", label: "Other...", isPlaceholder: true },
    ],
  },
  {
    id: "q2",
    prompt: "What should we optimize for in the UI?",
    options: [
      { id: "q2-a", label: "Speed to ship" },
      { id: "q2-b", label: "Visual polish" },
      { id: "q2-c", label: "Accessibility first" },
      { id: "q2-d", label: "Other...", isPlaceholder: true },
    ],
  },
  {
    id: "q3",
    prompt: "How do you like to test UI changes?",
    options: [
      { id: "q3-a", label: "Click around manually" },
      { id: "q3-b", label: "E2E (e.g. Playwright)" },
      { id: "q3-c", label: "Both, depending on the change" },
      { id: "q3-d", label: "Other...", isPlaceholder: true },
    ],
  },
];

const ACTIVE_QUESTION_INDEX = 0;
const BADGE_LETTERS = ["A", "B", "C", "D"] as const;

export function DemoPage() {
  const completedCount = TODO_ITEMS.filter((item) => item.status === "completed").length;

  return (
    <div className="workspace-area cursor-demo-workspace">
      <div className="workspace-content workspace-content--full cursor-demo-page">
        <header className="cursor-demo-page__header">
          <p className="cursor-demo-page__eyebrow">Component showcase</p>
          <h1>Inline tool surfaces</h1>
          <p className="cursor-demo-page__lede">
            Two reusable surfaces lifted from Cursor — a streamable todo list and a multi-step
            questions tray. Drop them inline anywhere the agent needs to share progress or collect
            structured input.
          </p>
        </header>

        <div className="cursor-demo-grid">
          <section className="cursor-demo-column">
            <p className="cursor-demo-column__label">Todo list</p>
            <div className="cursor-demo-card">
              <TodoListDemo items={TODO_ITEMS} completedCount={completedCount} />
            </div>
          </section>

          <section className="cursor-demo-column">
            <p className="cursor-demo-column__label">Questions</p>
            <div className="cursor-demo-card">
              <QuestionsDemo
                questions={QUESTIONS}
                activeIndex={ACTIVE_QUESTION_INDEX}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function TodoListDemo({
  items,
  completedCount,
}: {
  items: ReadonlyArray<TodoItem>;
  completedCount: number;
}) {
  return (
    <div className="todo-list-container">
      <div className="todo-list-header">
        <div className="todo-list-header-left-title">
          <span className="todo-list-icon" aria-hidden="true">
            <ListIcon />
          </span>
          <span className="todo-list-header-left-title-count">
            {completedCount} of {items.length} Done
          </span>
        </div>
      </div>
      <div className="todo-list-scroll-shell">
        <ul className="ui-todo-list">
          {items.map((item) => (
            <li key={item.id} className={`ui-todo-item ui-todo-item--${item.status}`}>
              <div className="ui-todo-item__label">
                <span className="ui-todo-item__indicator" aria-hidden="true">
                  <TodoStatusIcon status={item.status} />
                </span>
                <span className="ui-todo-item__content">{item.label}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function QuestionsDemo({
  questions,
  activeIndex,
}: {
  questions: ReadonlyArray<Question>;
  activeIndex: number;
}) {
  const total = questions.length;
  const stepNumber = activeIndex + 1;
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === total - 1;

  return (
    <div className="ui-tray" tabIndex={-1}>
      <div className="ui-tray-header">
        <span className="ui-tray-header__label">Questions</span>
        <div className="ui-tray-header__stepper">
          <button
            type="button"
            className="ui-icon-button ui-tray-header__nav-button"
            disabled={isFirst}
            aria-label="Previous question"
          >
            <ChevronIcon direction="left" />
          </button>
          <span className="ui-tray-header__counter">
            {stepNumber} of {total}
          </span>
          <button
            type="button"
            className="ui-icon-button ui-tray-header__nav-button"
            disabled={isLast}
            aria-label="Next question"
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
      </div>

      <div className="ui-scroll-area ui-tray__scroll-area">
        <div className="ui-scroll-area__viewport">
          <div className="ui-scroll-area__content">
            {questions.map((question, index) => (
              <QuestionStep
                key={question.id}
                question={question}
                isActive={index === activeIndex}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="ui-tray-actions">
        <button type="button" className="ui-button" data-variant="text">
          Skip
        </button>
        <button type="button" className="ui-button" data-variant="primary">
          <span>Next</span>
          <span className="ui-tray-actions__shortcut">⏎</span>
        </button>
      </div>
    </div>
  );
}

function QuestionStep({ question, isActive }: { question: Question; isActive: boolean }) {
  const tabIndex = isActive ? -1 : 0;
  const role = isActive ? "group" : "button";
  return (
    <div
      id={question.id}
      role={role}
      tabIndex={tabIndex}
      className="ui-tray-step"
      data-active={isActive ? "true" : "false"}
    >
      <div className="ui-tray-step__title">
        <p>{question.prompt}</p>
      </div>
      <div className="ui-tray-step__options">
        {question.options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className="ui-tray-option"
            data-text-input={option.isPlaceholder ? "true" : undefined}
            tabIndex={isActive ? 0 : -1}
          >
            <span className="ui-tray-option__badge">{BADGE_LETTERS[index]}</span>
            <span
              className="ui-tray-option__label"
              data-placeholder={option.isPlaceholder ? "true" : undefined}
            >
              {option.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="3.25" cy="4.25" r="1.25" fill="currentColor" />
      <circle cx="3.25" cy="11.75" r="1.25" fill="currentColor" />
      <path
        d="M6.75 4.25H13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M6.75 11.75H13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  if (status === "completed") {
    return (
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M5.4 8.2l1.9 1.9 3.5-3.7"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in-progress") {
    return (
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M5.6 8h4.4M8.4 6l2 2-2 2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle
        cx="8"
        cy="8"
        r="6.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeDasharray="1.6 2.2"
      />
    </svg>
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
