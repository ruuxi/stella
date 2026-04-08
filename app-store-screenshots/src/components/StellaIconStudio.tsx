"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  StellaAnimationCanvas,
  type StellaAnimationCanvasHandle,
  type VoiceMode,
} from "./stella-animation/StellaAnimationCanvas";

type SurfaceId = "app-icon" | "soft-square" | "transparent-mark";
type BackgroundId = "aurora" | "midnight" | "daylight";
type Palette = [string, string, string, string, string];

type BackgroundPreset = {
  label: string;
  palette: Palette;
  fillTop: string;
  fillBottom: string;
  glowA: string;
  glowB: string;
  border: string;
  pageTint: string;
};

type SurfacePreset = {
  label: string;
  radiusRatio: number;
  transparent: boolean;
  scale: number;
  shadow: string;
  note: string;
};

const BACKGROUNDS: Record<BackgroundId, BackgroundPreset> = {
  aurora: {
    label: "Aurora",
    palette: ["#b8ff5a", "#3dffd4", "#5cb3ff", "#c97fff", "#e0e8ff"],
    fillTop: "#090d18",
    fillBottom: "#161d31",
    glowA: "rgba(94, 175, 255, 0.32)",
    glowB: "rgba(181, 110, 255, 0.26)",
    border: "rgba(255,255,255,0.10)",
    pageTint: "rgba(120, 169, 255, 0.14)",
  },
  midnight: {
    label: "Midnight",
    palette: ["#a3ff6a", "#2ee8ff", "#4d87ff", "#9b6fff", "#dde5ff"],
    fillTop: "#050812",
    fillBottom: "#0d1324",
    glowA: "rgba(82, 140, 255, 0.28)",
    glowB: "rgba(122, 90, 255, 0.22)",
    border: "rgba(255,255,255,0.08)",
    pageTint: "rgba(88, 120, 255, 0.12)",
  },
  daylight: {
    label: "Daylight",
    palette: ["#52c41a", "#13c2c2", "#2f6fef", "#722ed1", "#8b9cf5"],
    fillTop: "#f6f9ff",
    fillBottom: "#dee8f7",
    glowA: "rgba(79, 141, 255, 0.18)",
    glowB: "rgba(166, 113, 255, 0.15)",
    border: "rgba(15, 23, 42, 0.10)",
    pageTint: "rgba(255,255,255,0.45)",
  },
};

const SURFACES: Record<SurfaceId, SurfacePreset> = {
  "app-icon": {
    label: "App Icon",
    radiusRatio: 0.28,
    transparent: false,
    scale: 1.2,
    shadow: "0 40px 110px rgba(0, 0, 0, 0.32)",
    note: "Closest to a final product icon tile.",
  },
  "soft-square": {
    label: "Soft Square",
    radiusRatio: 0.2,
    transparent: false,
    scale: 0.92,
    shadow: "0 28px 90px rgba(0, 0, 0, 0.24)",
    note: "A tighter crop for experiments and marketing tiles.",
  },
  "transparent-mark": {
    label: "Transparent Mark",
    radiusRatio: 0,
    transparent: true,
    scale: 1.02,
    shadow: "none",
    note: "Exports only the animated mark on transparency.",
  },
};

const EXPORT_SIZES = [256, 512, 1024] as const;
const PREVIEW_SIZE = 420;
const ANIMATION_GRID = { width: 84, height: 42 } as const;
const MARK_SOURCE_CROP = 0.76;
const PALETTE_LABELS = [
  "Outer",
  "Cool",
  "Core",
  "Glow",
  "Face",
] as const;

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function triggerDownload(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

function drawIconTile(
  context: CanvasRenderingContext2D,
  size: number,
  sourceCanvas: HTMLCanvasElement | null,
  background: BackgroundPreset,
  backgroundId: BackgroundId,
  surface: SurfacePreset,
) {
  context.clearRect(0, 0, size, size);

  const radius = surface.transparent ? 0 : size * surface.radiusRatio;

  if (!surface.transparent) {
    roundedRectPath(context, 0, 0, size, size, radius);
    context.save();
    context.clip();

    const fill = context.createLinearGradient(0, 0, 0, size);
    fill.addColorStop(0, background.fillTop);
    fill.addColorStop(1, background.fillBottom);
    context.fillStyle = fill;
    context.fillRect(0, 0, size, size);

    const glowOne = context.createRadialGradient(
      size * 0.18,
      size * 0.16,
      0,
      size * 0.18,
      size * 0.16,
      size * 0.36,
    );
    glowOne.addColorStop(0, background.glowA);
    glowOne.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = glowOne;
    context.fillRect(0, 0, size, size);

    const glowTwo = context.createRadialGradient(
      size * 0.76,
      size * 0.82,
      0,
      size * 0.76,
      size * 0.82,
      size * 0.34,
    );
    glowTwo.addColorStop(0, background.glowB);
    glowTwo.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = glowTwo;
    context.fillRect(0, 0, size, size);

    const highlight = context.createLinearGradient(0, 0, size, size);
    highlight.addColorStop(0, "rgba(255,255,255,0.06)");
    highlight.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = highlight;
    context.fillRect(0, 0, size, size);

    context.restore();

    context.save();
    roundedRectPath(context, 0.5, 0.5, size - 1, size - 1, radius);
    context.strokeStyle = background.border;
    context.lineWidth = Math.max(1, size / 256);
    context.stroke();
    context.restore();
  }

  if (!sourceCanvas) {
    return;
  }

  const cropSize = sourceCanvas.height * MARK_SOURCE_CROP;
  const cropX = (sourceCanvas.width - cropSize) / 2;
  const cropY = (sourceCanvas.height - cropSize) / 2;
  const targetSize = size * surface.scale;
  const targetX = (size - targetSize) / 2;
  const targetY = (size - targetSize) / 2;

  context.save();
  context.imageSmoothingEnabled = false;

  if (!surface.transparent) {
    context.shadowColor =
      backgroundId === "daylight"
        ? "rgba(39, 55, 90, 0.18)"
        : "rgba(0, 0, 0, 0.28)";
    context.shadowBlur = size * 0.055;
    context.shadowOffsetY = size * 0.025;
  }

  context.drawImage(
    sourceCanvas,
    cropX,
    cropY,
    cropSize,
    cropSize,
    targetX,
    targetY,
    targetSize,
    targetSize,
  );
  context.restore();
}

function ControlButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
        active
          ? "border-transparent bg-white text-slate-950"
          : "border-white/15 bg-white/8 text-white hover:bg-white/14"
      }`}
    >
      {children}
    </button>
  );
}

function TinyPreview({
  label,
  background,
  backgroundId,
  surface,
  getSourceCanvas,
}: {
  label: string;
  background: BackgroundPreset;
  backgroundId: BackgroundId;
  surface: SurfacePreset;
  getSourceCanvas: () => HTMLCanvasElement | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const previewSize = 96;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const pixelSize = Math.floor(previewSize * dpr);

    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawIconTile(
      context,
      previewSize,
      getSourceCanvas(),
      background,
      backgroundId,
      surface,
    );
  }, [background, backgroundId, getSourceCanvas, previewSize, surface]);

  useEffect(() => {
    let frameId = 0;

    const tick = () => {
      redraw();
      frameId = window.requestAnimationFrame(tick);
    };

    tick();

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [redraw]);

  return (
    <div className="rounded-[20px] border border-white/10 bg-slate-950/35 p-4">
      <div className="text-xs uppercase tracking-[0.25em] text-white/45">
        {label}
      </div>
      <div className="mt-4 flex justify-center">
        <canvas
          ref={canvasRef}
          style={{
            width: previewSize,
            height: previewSize,
            display: "block",
            imageRendering: "pixelated",
          }}
        />
      </div>
    </div>
  );
}

export function StellaIconStudio() {
  const animationRef = useRef<StellaAnimationCanvasHandle | null>(null);
  const [surfaceId, setSurfaceId] = useState<SurfaceId>("app-icon");
  const [backgroundId, setBackgroundId] = useState<BackgroundId>("aurora");
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("idle");
  const [previewTime, setPreviewTime] = useState(7.2);
  const [exportSize, setExportSize] = useState<number>(1024);
  const [status, setStatus] = useState(
    "Scrub to a frame you like, then export PNGs.",
  );

  const surface = SURFACES[surfaceId];
  const background = BACKGROUNDS[backgroundId];
  const [palette, setPalette] = useState<Palette>(background.palette);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const getSourceCanvas = useCallback(
    () => animationRef.current?.getCanvas() ?? null,
    [],
  );

  useEffect(() => {
    setPalette(background.palette);
  }, [background]);

  const updatePaletteColor = useCallback((index: number, value: string) => {
    setPalette((current) => {
      const next = [...current] as Palette;
      next[index] = value;
      return next;
    });
  }, []);

  const renderExportDataUrl = useCallback(
    (size: number) => {
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = size;
      exportCanvas.height = size;

      const context = exportCanvas.getContext("2d");

      if (!context) {
        throw new Error("Could not create export canvas.");
      }

      drawIconTile(
        context,
        size,
        getSourceCanvas(),
        background,
        backgroundId,
        surface,
      );

      return exportCanvas.toDataURL("image/png");
    },
    [background, backgroundId, getSourceCanvas, surface],
  );

  const exportOne = useCallback(
    (size: number) => {
      try {
        const dataUrl = renderExportDataUrl(size);
        triggerDownload(
          dataUrl,
          `stella-${surfaceId}-${backgroundId}-${voiceMode}-${size}.png`,
        );
        setStatus(`Exported ${size}x${size} PNG.`);
      } catch (error) {
        console.error(error);
        setStatus("Export failed. Let the animation finish loading, then try again.");
      }
    },
    [backgroundId, renderExportDataUrl, surfaceId, voiceMode],
  );

  const exportAllSizes = useCallback(() => {
    for (const size of EXPORT_SIZES) {
      exportOne(size);
    }
  }, [exportOne]);

  const quickNotes = useMemo(() => {
    if (surface.transparent) {
      return "Best for overlays, docs, and transparent brand marks.";
    }

    if (surfaceId === "app-icon") {
      return "Most likely the right preset if you want a desktop icon direction based on the live Stella form.";
    }

    return "Useful when you want a tighter crop before deciding on a final icon treatment.";
  }, [surface.transparent, surfaceId]);

  useEffect(() => {
    let frameId = 0;

    const draw = () => {
      const canvas = previewCanvasRef.current;

      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const pixelSize = Math.floor(PREVIEW_SIZE * dpr);

        if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
          canvas.width = pixelSize;
          canvas.height = pixelSize;
        }

        const context = canvas.getContext("2d");

        if (context) {
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawIconTile(
            context,
            PREVIEW_SIZE,
            getSourceCanvas(),
            background,
            backgroundId,
            surface,
          );
        }
      }

      frameId = window.requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [background, backgroundId, getSourceCanvas, surface]);

  return (
    <section className="rounded-[32px] border border-white/10 bg-white/6 p-6 shadow-2xl backdrop-blur-xl md:p-8">
      <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/60">
            Stella Asset Studio
          </p>
          <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">
            Export product icon concepts from the live Stella animation.
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-white/72 md:text-lg">
            This is an HTML-based preview surface for the same Stella creature idea, tuned for static PNG exports.
            Scrub a frame, try a few backgrounds, and compare square icon directions without leaving the browser.
          </p>
        </div>

        <div className="rounded-[24px] border border-white/10 bg-slate-950/30 px-5 py-4">
          <div className="text-xs uppercase tracking-[0.25em] text-white/45">
            Current status
          </div>
          <p className="mt-3 max-w-sm text-sm leading-7 text-white/70">
            {status}
          </p>
        </div>
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <div className="rounded-[28px] border border-white/10 bg-slate-950/30 p-5">
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-white/45">
              Live Preview
            </div>
            <p className="mt-2 text-sm leading-7 text-white/65">
              {quickNotes}
            </p>
          </div>

          <div className="mt-6 overflow-hidden rounded-[28px] border border-white/10 bg-slate-950/40 p-4">
            <canvas
              ref={previewCanvasRef}
              style={{
                width: PREVIEW_SIZE,
                height: PREVIEW_SIZE,
                margin: "0 auto",
                display: "block",
                imageRendering: "pixelated",
              }}
            />
          </div>

          <div className="mt-5 rounded-[24px] border border-white/10 bg-slate-950/30 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.25em] text-white/45">
                  Time
                </div>
                <p className="mt-2 text-sm leading-7 text-white/65">
                  Drag to choose the exact frame used by the preview and exports.
                </p>
              </div>
              <div className="font-mono text-sm uppercase tracking-[0.2em] text-white/60">
                {previewTime.toFixed(2)}
              </div>
            </div>
            <input
              type="range"
              min="0"
              max="18"
              step="0.01"
              value={previewTime}
              onChange={(event) =>
                setPreviewTime(Number(event.target.value))
              }
              className="mt-4 w-full accent-white"
            />
          </div>

          <div className="mt-5 rounded-[24px] border border-white/10 bg-slate-950/30 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.25em] text-white/45">
                  Animation Colors
                </div>
                <p className="mt-2 text-sm leading-7 text-white/65">
                  Adjust Stella&apos;s five gradient stops directly. Changing the background preset resets these to the preset colors.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPalette(background.palette)}
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                Reset
              </button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {palette.map((color, index) => (
                <label
                  key={PALETTE_LABELS[index]}
                  className="flex items-center gap-3 rounded-[18px] border border-white/10 bg-white/4 px-3 py-3"
                >
                  <input
                    type="color"
                    value={color}
                    onChange={(event) =>
                      updatePaletteColor(index, event.target.value)
                    }
                    className="h-10 w-10 cursor-pointer rounded-full border-0 bg-transparent p-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-white">
                      {PALETTE_LABELS[index]}
                    </div>
                    <div className="font-mono text-xs uppercase tracking-[0.2em] text-white/45">
                      {color}
                    </div>
                  </div>
                  <div
                    className="h-8 w-8 rounded-full border border-white/10"
                    style={{ background: color }}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <TinyPreview
              label="64 px feel"
              background={background}
              backgroundId={backgroundId}
              surface={surface}
              getSourceCanvas={getSourceCanvas}
            />
            <TinyPreview
              label="128 px feel"
              background={background}
              backgroundId={backgroundId}
              surface={surface}
              getSourceCanvas={getSourceCanvas}
            />
            <TinyPreview
              label="256 px feel"
              background={background}
              backgroundId={backgroundId}
              surface={surface}
              getSourceCanvas={getSourceCanvas}
            />
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-[28px] border border-white/10 bg-slate-950/30 p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-white/45">
              Surface
            </div>
            <p className="mt-2 text-sm leading-7 text-white/65">
              Pick the general icon container before deciding on a final exported frame.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {(Object.entries(SURFACES) as Array<[SurfaceId, SurfacePreset]>).map(
                ([id, preset]) => (
                  <ControlButton
                    key={id}
                    active={id === surfaceId}
                    onClick={() => setSurfaceId(id)}
                  >
                    {preset.label}
                  </ControlButton>
                ),
              )}
            </div>
            <p className="mt-4 text-sm leading-7 text-white/55">
              {surface.note}
            </p>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-slate-950/30 p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-white/45">
              Background
            </div>
            <p className="mt-2 text-sm leading-7 text-white/65">
              These presets keep the live mark close to Stella&apos;s current gradient feel while giving you clearer tile options.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {(
                Object.entries(BACKGROUNDS) as Array<
                  [BackgroundId, BackgroundPreset]
                >
              ).map(([id, preset]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setBackgroundId(id)}
                  className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                    id === backgroundId
                      ? "border-transparent bg-white text-slate-950"
                      : "border-white/15 bg-white/8 text-white hover:bg-white/14"
                  }`}
                  style={{
                    boxShadow:
                      id === backgroundId
                        ? `0 0 0 1px ${preset.pageTint}`
                        : undefined,
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-slate-950/30 p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-white/45">
              Animation State
            </div>
            <p className="mt-2 text-sm leading-7 text-white/65">
              A frozen speaking or listening frame may look more like the live Stella character than a perfectly neutral idle state.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {(["idle", "listening", "speaking"] as const).map((state) => (
                <ControlButton
                  key={state}
                  active={state === voiceMode}
                  onClick={() => setVoiceMode(state)}
                >
                  {state}
                </ControlButton>
              ))}
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-slate-950/30 p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-white/45">
              Export
            </div>
            <p className="mt-2 text-sm leading-7 text-white/65">
              Export one size or all common icon sizes in sequence.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-3 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm text-white/85">
                <span>Size</span>
                <select
                  value={exportSize}
                  onChange={(event) =>
                    setExportSize(Number(event.target.value))
                  }
                  className="rounded-full bg-slate-950/60 px-3 py-1 text-sm text-white outline-none"
                >
                  {EXPORT_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} x {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => exportOne(exportSize)}
                className="rounded-full bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
              >
                Export PNG
              </button>
              <button
                type="button"
                onClick={exportAllSizes}
                className="rounded-full border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                Export 256 / 512 / 1024
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: -9999,
          top: 0,
          width: 1,
          height: 1,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <div style={{ width: 1, height: 1 }}>
          <StellaAnimationCanvas
            ref={animationRef}
            width={ANIMATION_GRID.width}
            height={ANIMATION_GRID.height}
            manualTime={previewTime}
            voiceMode={voiceMode}
            maxDpr={2}
            colors={palette}
          />
        </div>
      </div>
    </section>
  );
}
