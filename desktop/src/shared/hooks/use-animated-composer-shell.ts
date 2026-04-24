import { useEffect, useRef, type RefObject } from "react";
import { animate } from "motion";

type AnimatedComposerShellOptions = {
  active?: boolean;
  shellRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  formRef: RefObject<HTMLElement | null>;
  syncOnNextFrame?: boolean;
};

const expandedRadiusPx = 20;

const getContentHeight = (content: HTMLElement) =>
  content.getBoundingClientRect().height;

const getTargetRadius = (
  form: HTMLElement,
  content: HTMLElement,
  height: number,
) => {
  const expanded = form.classList.contains("expanded");
  const hasChips = Boolean(content.querySelector(".composer-attached-strip"));
  return expanded || hasChips ? expandedRadiusPx : Math.min(999, height);
};

export function updateComposerTextareaExpansion(
  textarea: HTMLTextAreaElement | null,
  setExpanded: (expanded: boolean) => void,
) {
  if (!textarea) return;
  const form = textarea.closest("form") as HTMLElement | null;
  if (!form) return;
  const isExpanded = form.classList.contains("expanded");

  if (!isExpanded) {
    if (textarea.scrollHeight > 44) setExpanded(true);
    return;
  }

  form.classList.remove("expanded");
  const pillScrollHeight = textarea.scrollHeight;
  form.classList.add("expanded");
  if (pillScrollHeight <= 44) setExpanded(false);
}

export function useAnimatedComposerShell({
  active = true,
  shellRef,
  contentRef,
  formRef,
  syncOnNextFrame = false,
}: AnimatedComposerShellOptions) {
  const heightAnimationRef = useRef<ReturnType<typeof animate> | null>(null);
  const lastHeightRef = useRef(0);

  useEffect(() => {
    if (!active) return;

    const content = contentRef.current;
    const form = formRef.current;
    const shell = shellRef.current;
    if (!content || !form || !shell || typeof ResizeObserver === "undefined") {
      return;
    }

    const syncShellToContent = () => {
      lastHeightRef.current = getContentHeight(content);
      shell.style.height = `${lastHeightRef.current}px`;
      shell.style.borderRadius = `${getTargetRadius(
        form,
        content,
        lastHeightRef.current,
      )}px`;
    };

    syncShellToContent();

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextHeight =
        entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (Math.abs(nextHeight - lastHeightRef.current) < 1) return;

      lastHeightRef.current = nextHeight;
      const targetRadius = getTargetRadius(form, content, nextHeight);

      heightAnimationRef.current?.stop();
      heightAnimationRef.current = animate(
        shell,
        { height: `${nextHeight}px`, borderRadius: `${targetRadius}px` },
        {
          type: "spring",
          duration: 0.35,
          bounce: 0,
        },
      );
    });

    observer.observe(content);

    const frameId = syncOnNextFrame
      ? requestAnimationFrame(syncShellToContent)
      : null;

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
      heightAnimationRef.current?.stop();
    };
  }, [active, contentRef, formRef, shellRef, syncOnNextFrame]);
}
