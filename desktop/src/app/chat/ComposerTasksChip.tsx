/**
 * ComposerTasksChip — a running-agents chip that lives in the composer's
 * context-chip row (left of the auto-detected suggestion chips).
 *
 * While one or more agents ("tasks") are running it shows a spinner, the
 * live count ("1 task" / "3 tasks"), and a chevron; clicking it opens a
 * menu listing each running task's description. When the count drops to
 * zero the chip animates out and the surrounding chips slide back to
 * their resting position.
 *
 * The chip owns its own enter/leave animation: the shell's `max-width`
 * animates between 0 and the measured content width, so the parent row
 * can render it unconditionally — it collapses to zero width (and clips
 * its trailing gap) when idle, pushing/releasing the suggestion chips
 * smoothly. We measure rather than rely on the CSS grid `0fr→1fr` trick
 * because the shell is a flex item (intrinsic sizing makes `fr` snap
 * instead of interpolate).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "@/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  getTaskDisplayText,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import { getAgentLabel } from "@/features/chat/agent-labels";
import "./composer-tasks-chip.css";

type ComposerTasksChipProps = {
  tasks: TaskItem[];
};

export function ComposerTasksChip({ tasks }: ComposerTasksChipProps) {
  const active = tasks.length > 0;

  // Keep the last non-empty snapshot so the chip's label and menu stay
  // populated through the collapse animation after the final task ends.
  const [displayTasks, setDisplayTasks] = useState<TaskItem[]>(tasks);
  useEffect(() => {
    if (active) setDisplayTasks(tasks);
  }, [active, tasks]);
  const renderTasks = active ? tasks : displayTasks;
  const count = renderTasks.length;

  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!active) setMenuOpen(false);
  }, [active]);

  // Measure the chip's natural width so the shell can animate max-width
  // 0 ↔ width. The trailing gap lives inside the measured element, so it
  // collapses with the chip.
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => setWidth(inner.offsetWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const countLabel = `${count} ${count === 1 ? "task" : "tasks"}`;

  return (
    <div
      className="composer-tasks-chip-shell"
      data-active={active || undefined}
      style={{ maxWidth: active ? width : 0, opacity: active ? 1 : 0 }}
    >
      <div ref={innerRef} className="composer-tasks-chip-inner">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="composer-tasks-chip"
              aria-label={`${countLabel} running`}
            >
              <span className="composer-tasks-chip__spinner" aria-hidden="true" />
              <span className="composer-tasks-chip__label">{countLabel}</span>
              <ChevronDown
                className="composer-tasks-chip__chevron"
                size={16}
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            sideOffset={6}
            className="composer-tasks-menu"
          >
            <DropdownMenuLabel>
              {count === 1 ? "Active task" : "Active tasks"}
            </DropdownMenuLabel>
            {renderTasks.map((task) => (
              <DropdownMenuItem
                key={task.id}
                className="composer-tasks-menu__item"
                // Read-only list — keep the menu open on click.
                onSelect={(event) => event.preventDefault()}
              >
                <span className="composer-tasks-menu__dot" aria-hidden="true" />
                <span className="composer-tasks-menu__text">
                  {getTaskDisplayText(task) || getAgentLabel(task.agentType)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
