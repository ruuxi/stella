import { useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { AgentModelPicker } from "@/global/settings/AgentModelPicker";
import {
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import "./ModelsPicker.css";

type ModelsPickerTriggerProps = {
  style?: CSSProperties;
  tabIndex?: number;
  "aria-hidden"?: boolean;
  "data-slot"?: string;
};

interface ModelsPickerProps {
  /** Custom trigger (e.g. icon button). Required. */
  trigger: ReactElement;
  /** Which side of the trigger the popover opens on. Defaults to `top`. */
  side?: "top" | "bottom" | "left" | "right";
  /** Alignment of the popover relative to the trigger. Defaults to `start`. */
  align?: "start" | "center" | "end";
  /** Make the popover controlled by the caller. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Visually hide the trigger but keep it in the DOM so Radix can
   *  still anchor the popover to it. Used when the picker is opened
   *  from another control (e.g. a sibling dropdown menu). */
  hideTrigger?: boolean;
}

/**
 * Sidebar entry-point for the model picker. The popover renders a single
 * `AgentModelPicker` directly — no nested dropdowns — with the agent toggle
 * sitting at the top of the picker itself.
 */
export function ModelsPicker({
  trigger,
  side = "top",
  align = "start",
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  hideTrigger = false,
}: ModelsPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;
  const navigate = useNavigate();

  const handleOpenSettings = useCallback(() => {
    setOpen(false);
    void navigate({ to: "/settings", search: { tab: "models" } });
  }, [navigate, setOpen]);

  const triggerElement =
    trigger && isValidElement<ModelsPickerTriggerProps>(trigger)
      ? cloneElement(trigger, {
          "data-slot": "models-picker-trigger",
          ...(hideTrigger
            ? {
                style: {
                  ...(typeof trigger.props.style === "object" &&
                  trigger.props.style !== null
                    ? trigger.props.style
                    : {}),
                  opacity: 0,
                  pointerEvents: "none",
                  position: "absolute",
                },
                tabIndex: -1,
                "aria-hidden": true,
              }
            : null),
        })
      : trigger;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        collisionPadding={8}
        data-models-picker="true"
      >
        <PopoverBody>
          <AgentModelPicker />
          <button
            type="button"
            className="models-picker-more"
            onClick={handleOpenSettings}
          >
            <span>More options</span>
            <ChevronRight size={14} strokeWidth={1.75} />
          </button>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
