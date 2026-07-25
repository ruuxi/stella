/**
 * Defers a display surface's first render by two animation frames.
 *
 * The panel's open transition and a viewer's first paint used to compete for
 * the same frame — heavy viewers (canvas iframes, PDFs, media) would stall the
 * slide. Waiting two frames lets the transition start cleanly first.
 *
 * Extracted from `RightSidebar` so the four sidebar sections can share it.
 */

import { useEffect, useState, type ReactNode } from "react";

export const DeferredDisplayContent = ({
  render,
}: {
  render: () => ReactNode;
}) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return ready ? render() : null;
};
