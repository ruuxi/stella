/**
 * Per-kind viewer components used by the Display sidebar's tab manager.
 *
 * Each component is a thin wrapper that delegates to the existing card UI
 * (MediaPreviewCard sub-renderers, OfficePreviewCard, PdfViewerCard,
 * morphdom HTML application). The wrappers exist so the tab spec's
 * `render()` function can be a single `createElement(Component, props)`
 * call — no per-call branching, no `kind` discriminator inside the render
 * path.
 */

import { useEffect, useRef } from "react";
import type { OfficePreviewRef } from "@/shared/contracts/office-preview";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { PdfViewerCard } from "@/app/chat/PdfViewerCard";
import {
  MediaPreviewCard,
} from "@/shell/MediaPreviewCard";
import { applyMorphdomHtml } from "@/shell/apply-morphdom-html";

type WithMediaMeta = {
  prompt?: string;
  capability?: string;
};

export const HtmlTabContent = ({ html }: { html: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    applyMorphdomHtml(el, "display-sidebar__content", html, {
      executeScripts: true,
    });
  }, [html]);

  // The legacy DisplaySidebar handled action delegation (`data-action="send-
  // message"`) at the container level. Preserve it here so the same HTML
  // payloads keep working.
  return (
    <div
      ref={ref}
      className="display-sidebar__content"
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest(
          "[data-action]",
        ) as HTMLElement | null;
        if (!el) return;
        if (el.getAttribute("data-action") === "send-message") {
          const prompt = el.getAttribute("data-prompt");
          if (prompt) {
            window.dispatchEvent(
              new CustomEvent("stella:send-message", { detail: { text: prompt } }),
            );
          }
        }
      }}
    />
  );
};

export const OfficeTabContent = ({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) => (
  <div className="display-sidebar__rich">
    <OfficePreviewCard previewRef={previewRef} />
  </div>
);

export const PdfTabContent = ({
  filePath,
  title,
}: {
  filePath: string;
  title?: string;
}) => (
  <div className="display-sidebar__rich display-sidebar__rich--pdf">
    <PdfViewerCard filePath={filePath} {...(title ? { title } : {})} />
  </div>
);

export const ImageTabContent = ({
  filePaths,
  prompt,
  capability,
}: { filePaths: string[] } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "image", filePaths }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const VideoTabContent = ({
  filePath,
  prompt,
  capability,
}: { filePath: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "video", filePath }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const AudioTabContent = ({
  filePath,
  prompt,
  capability,
}: { filePath: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "audio", filePath }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const Model3dTabContent = ({
  filePath,
  label,
  prompt,
  capability,
}: { filePath: string; label?: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "model3d", filePath, ...(label ? { label } : {}) }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const DownloadTabContent = ({
  filePath,
  label,
  prompt,
  capability,
}: { filePath: string; label: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "download", filePath, label }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);

export const TextTabContent = ({
  text,
  prompt,
  capability,
}: { text: string } & WithMediaMeta) => (
  <div className="display-sidebar__rich display-sidebar__rich--media">
    <MediaPreviewCard
      asset={{ kind: "text", text }}
      {...(prompt ? { prompt } : {})}
      {...(capability ? { capability } : {})}
    />
  </div>
);
