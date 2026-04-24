import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { useFilePreviewActions } from "./hooks/use-file-preview-actions";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "./pdf-viewer-card.css";

// The pdf-worker-asset Vite plugin (see vite.config.ts) copies the pdfjs
// worker into `public/vendor/pdfjs/` so we can serve it as a static asset.
// `BASE_URL` is `./` for our build, so the resolved URL works under both
// the dev server and the packaged Electron renderer.
const PDF_WORKER_URL = `${import.meta.env.BASE_URL}vendor/pdfjs/pdf.worker.min.mjs`;

if (pdfjs.GlobalWorkerOptions.workerSrc !== PDF_WORKER_URL) {
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
}

type PdfViewerCardProps = {
  filePath: string;
  title?: string;
};

type LoadStatus = "loading" | "ready" | "error";

const RESIZE_DEBOUNCE_MS = 100;

export function PdfViewerCard({ filePath, title }: PdfViewerCardProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { bytes, error: fileError } = useDisplayFileBytes(
    filePath,
    "PDF viewer requires the Electron host runtime.",
  );
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const lastWidthRef = useRef<number | null>(null);

  useEffect(() => {
    setStatus("loading");
    setErrorMessage(null);
    setNumPages(0);
    setCurrentPage(1);
  }, [filePath]);

  useEffect(() => {
    if (fileError) {
      setStatus("error");
      setErrorMessage(fileError);
    }
  }, [fileError]);

  // Track container width so PDF pages render at the right resolution.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const applyWidth = () => {
      const next = Math.floor(container.getBoundingClientRect().width);
      if (next > 0 && next !== lastWidthRef.current) {
        lastWidthRef.current = next;
        setPageWidth(next);
      }
    };

    applyWidth();

    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        applyWidth();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
  }, []);

  const handleLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(Math.max(numPages, 1));
    setStatus("ready");
  }, []);

  const handleLoadError = useCallback((error: Error) => {
    setStatus("error");
    setErrorMessage(error.message || "Failed to load PDF.");
  }, []);

  const documentFile = useMemo(
    () => (bytes ? { data: bytes } : null),
    [bytes],
  );

  // Track which page is currently in view by intersection with [data-pdf-page].
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages <= 0 || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        let bestPage = currentPage;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.intersectionRatio <= bestRatio) continue;
          const pageAttr = (entry.target as HTMLElement).dataset.pdfPage;
          const pageNumber = pageAttr ? Number.parseInt(pageAttr, 10) : NaN;
          if (Number.isFinite(pageNumber)) {
            bestRatio = entry.intersectionRatio;
            bestPage = pageNumber;
          }
        }
        setCurrentPage(bestPage);
      },
      {
        root: container,
        threshold: [0.1, 0.5, 0.9],
      },
    );

    const pageEls = container.querySelectorAll("[data-pdf-page]");
    pageEls.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [numPages, currentPage]);

  const headerTitle =
    title?.replace(/\.pdf$/i, "") ??
    filePath.split("/").pop()?.replace(/\.pdf$/i, "") ??
    "PDF";
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: filePath,
    suggestedName: filePath.split(/[\\/]/).pop() ?? title ?? "document.pdf",
  });

  return (
    <section className="pdf-viewer-card">
      <header className="pdf-viewer-card__header">
        <div className="pdf-viewer-card__title-group">
          <span className="pdf-viewer-card__eyebrow">PDF</span>
          <div className="pdf-viewer-card__title" title={filePath}>
            {headerTitle}
          </div>
        </div>
        {status === "ready" && numPages > 0 && (
          <span className="pdf-viewer-card__page-counter">
            {currentPage} / {numPages}
          </span>
        )}
        <div className="pdf-viewer-card__actions">
          <button
            type="button"
            className="pdf-viewer-card__action"
            onClick={handleSave}
          >
            Save
          </button>
          <button
            type="button"
            className="pdf-viewer-card__action"
            onClick={handleCopy}
          >
            Copy
          </button>
          {actionStatus && (
            <span className="pdf-viewer-card__action-status">
              {actionStatus}
            </span>
          )}
        </div>
      </header>

      {status === "error" ? (
        <div className="pdf-viewer-card__placeholder pdf-viewer-card__placeholder--error">
          {errorMessage ?? "Failed to load PDF."}
        </div>
      ) : (
        <div ref={containerRef} className="pdf-viewer-card__scroll">
          {documentFile ? (
            <Document
              file={documentFile}
              loading={null}
              noData={null}
              onLoadSuccess={handleLoadSuccess}
              onLoadError={handleLoadError}
              className="pdf-viewer-card__document"
            >
              {Array.from({ length: numPages }, (_, index) => {
                const pageNumber = index + 1;
                return (
                  <div
                    key={pageNumber}
                    className="pdf-viewer-card__page-wrap"
                    data-pdf-page={pageNumber}
                  >
                    <Page
                      pageNumber={pageNumber}
                      width={pageWidth ?? undefined}
                      renderAnnotationLayer={false}
                      renderTextLayer={false}
                      className="pdf-viewer-card__page"
                    />
                  </div>
                );
              })}
            </Document>
          ) : (
            <div className="pdf-viewer-card__placeholder">
              Loading PDF…
            </div>
          )}
        </div>
      )}
    </section>
  );
}
