"use client";

import { toPng } from "html-to-image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
type Device = "iphone" | "ipad";
type ThemeId = keyof typeof THEMES;

type ExportSize = {
  label: string;
  w: number;
  h: number;
};

type CanvasSize = {
  w: number;
  h: number;
};

type ThemeTokens = {
  name: string;
  bg: string;
  bgAlt: string;
  bgDeep: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  accentForeground: string;
  decorative: string;
  success: string;
  warning: string;
  chip: string;
  card: string;
  cardBorder: string;
  shadow: string;
  screenBg: string;
  screenSurface: string;
  screenPanel: string;
  screenBorder: string;
  screenText: string;
  screenTextMuted: string;
  screenAccent: string;
  screenAccentSoft: string;
  screenAccentForeground: string;
  screenSuccess: string;
  screenDanger: string;
};

type SlideRenderContext = {
  canvas: CanvasSize;
  device: Device;
  theme: ThemeTokens;
};

type SlideDefinition = {
  slug: string;
  tabLabel: string;
  sectionLabel: string;
  headline: ReactNode;
  body: string;
  render: (context: SlideRenderContext) => ReactNode;
};

const IPHONE_CANVAS = { w: 1290, h: 2796 } as const;
const IPAD_CANVAS = { w: 2064, h: 2752 } as const;

const IPHONE_SIZES: readonly ExportSize[] = [
  { label: '6.7" (iPhone 15/16 Pro Max)', w: 1290, h: 2796 },
  { label: '6.5" (iPhone 11/XS Max)', w: 1242, h: 2688 },
  { label: '5.5" (iPhone 8 Plus)', w: 1242, h: 2208 },
];

const IPAD_SIZES: readonly ExportSize[] = [
  { label: '13" iPad', w: 2064, h: 2752 },
  { label: '12.9" iPad Pro', w: 2048, h: 2732 },
];

const MK_W = 1022;
const MK_H = 2082;
const SC_L = (52 / MK_W) * 100;
const SC_T = (46 / MK_H) * 100;
const SC_W = (918 / MK_W) * 100;
const SC_H = (1990 / MK_H) * 100;
const SC_RX = (126 / 918) * 100;
const SC_RY = (126 / 1990) * 100;

const IMAGE_PATHS = ["/mockup.png", "/app-icon.png", "/splash-icon.png", "/stella-logo.svg"] as const;
const imageCache: Record<string, string> = {};

/** Marketing chrome outside the device frame (badges, floating cards, pills). */
const MARKETING_FONT_SCALE = 1.22;
/** Text inside the phone / iPad mock screens only (captions on the slide stay unchanged). */
const SCREEN_MOCK_FONT_SCALE = 1.48;
const MOCK_PAD_SCALE = 1.06;

const THEMES = {
  carbon: {
    name: "Carbon",
    bg: "#edf3fb",
    bgAlt: "#dce7f6",
    bgDeep: "#cfe0f7",
    text: "#0f172a",
    muted: "#5c6778",
    accent: "#0f62fe",
    accentSoft: "#d9e6ff",
    accentForeground: "#ffffff",
    decorative: "#ee5396",
    success: "#42be65",
    warning: "#f1c21b",
    chip: "rgba(255,255,255,0.72)",
    card: "rgba(255,255,255,0.86)",
    cardBorder: "rgba(15, 98, 254, 0.10)",
    shadow: "0 32px 80px rgba(15, 23, 42, 0.18)",
    screenBg: "#f8fbff",
    screenSurface: "rgba(255,255,255,0.88)",
    screenPanel: "#e7eef7",
    screenBorder: "rgba(15, 23, 42, 0.08)",
    screenText: "#162130",
    screenTextMuted: "#66758a",
    screenAccent: "#0f62fe",
    screenAccentSoft: "#dce7ff",
    screenAccentForeground: "#ffffff",
    screenSuccess: "#42be65",
    screenDanger: "#d9485f",
  },
  midnight: {
    name: "Midnight",
    bg: "#08111f",
    bgAlt: "#0d1629",
    bgDeep: "#111d35",
    text: "#f8fbff",
    muted: "#a6b4cb",
    accent: "#78a9ff",
    accentSoft: "#1a2a49",
    accentForeground: "#08111f",
    decorative: "#ff7eb6",
    success: "#50d37b",
    warning: "#ffcc4d",
    chip: "rgba(16,25,44,0.72)",
    card: "rgba(12, 22, 40, 0.78)",
    cardBorder: "rgba(120, 169, 255, 0.16)",
    shadow: "0 34px 90px rgba(0, 0, 0, 0.48)",
    screenBg: "#0d1424",
    screenSurface: "rgba(20,29,50,0.9)",
    screenPanel: "#18223a",
    screenBorder: "rgba(255,255,255,0.08)",
    screenText: "#edf4ff",
    screenTextMuted: "#91a1bb",
    screenAccent: "#78a9ff",
    screenAccentSoft: "#162847",
    screenAccentForeground: "#08111f",
    screenSuccess: "#52d97d",
    screenDanger: "#ff8aa9",
  },
  editorial: {
    name: "Editorial",
    bg: "#f6efe8",
    bgAlt: "#edded2",
    bgDeep: "#e8d4c2",
    text: "#2a211c",
    muted: "#6d6057",
    accent: "#8b5cf6",
    accentSoft: "#efe4ff",
    accentForeground: "#ffffff",
    decorative: "#f59e0b",
    success: "#5cab65",
    warning: "#d2a33f",
    chip: "rgba(255, 251, 246, 0.74)",
    card: "rgba(255, 252, 248, 0.84)",
    cardBorder: "rgba(42, 33, 28, 0.08)",
    shadow: "0 28px 80px rgba(80, 52, 34, 0.14)",
    screenBg: "#fffaf4",
    screenSurface: "rgba(255,255,255,0.84)",
    screenPanel: "#f2e8dd",
    screenBorder: "rgba(42, 33, 28, 0.08)",
    screenText: "#2b1d17",
    screenTextMuted: "#7b675b",
    screenAccent: "#8b5cf6",
    screenAccentSoft: "#f0e9ff",
    screenAccentForeground: "#ffffff",
    screenSuccess: "#5cab65",
    screenDanger: "#d65d5d",
  },
} satisfies Record<string, ThemeTokens>;

function canvasFor(device: Device): CanvasSize {
  return device === "iphone" ? IPHONE_CANVAS : IPAD_CANVAS;
}

function sizesFor(device: Device): readonly ExportSize[] {
  return device === "iphone" ? IPHONE_SIZES : IPAD_SIZES;
}

function img(path: string): string {
  return imageCache[path] || path;
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

async function preloadAllImages() {
  await Promise.all(
    IMAGE_PATHS.map(async (path) => {
      if (imageCache[path]) {
        return;
      }

      const response = await fetch(path);
      const blob = await response.blob();
      imageCache[path] = await blobToDataUrl(blob);
    }),
  );
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function saveToDisk(dataUrl: string, filename: string) {
  const response = await fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, dataUrl }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save ${filename}`);
  }
}

async function flattenAndResize(dataUrl: string, width: number, height: number) {
  return await new Promise<string>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("Could not create canvas context."));
        return;
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Could not flatten exported image."));
    image.src = dataUrl;
  });
}

function useScaleToFit(canvas: CanvasSize, minHeight: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.18);

  useEffect(() => {
    const element = containerRef.current;

    if (!element) {
      return;
    }

    const measure = () => {
      const width = Math.max(element.clientWidth - 24, 1);
      const height = Math.max(element.clientHeight - 24, 1);
      setScale(Math.min(width / canvas.w, height / canvas.h));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [canvas.h, canvas.w]);

  return { containerRef, scale, minHeight };
}

function Badge({
  theme,
  children,
  style,
}: {
  theme: ThemeTokens;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "14px 20px",
        borderRadius: 999,
        background: theme.chip,
        border: `1px solid ${theme.cardBorder}`,
        color: theme.text,
        fontFamily: "var(--font-ibm-plex-mono)",
        fontSize: 18 * MARKETING_FONT_SCALE,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        boxShadow: theme.shadow,
        backdropFilter: "blur(18px)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Marker({
  color,
  size = 12,
}: {
  color: string;
  size?: number;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        display: "inline-block",
        borderRadius: "50%",
        background: color,
        boxShadow: `0 0 0 ${Math.max(size / 4, 2)}px ${color}22`,
      }}
    />
  );
}

function Caption({
  canvas,
  theme,
  label,
  headline,
  body,
  width,
  align = "left",
  style,
}: {
  canvas: CanvasSize;
  theme: ThemeTokens;
  label: string;
  headline: ReactNode;
  body: string;
  width: number;
  align?: "left" | "right";
  style?: CSSProperties;
}) {
  const labelSize = canvas.w * 0.023 * 1.05;
  const headlineSize =
    canvas.w * (canvas.w > 1500 ? 0.073 : 0.094) * 1.05;
  const bodySize =
    canvas.w * (canvas.w > 1500 ? 0.0205 : 0.0285) * 1.05;

  return (
    <div
      style={{
        position: "absolute",
        width,
        color: theme.text,
        textAlign: align,
        ...style,
      }}
    >
      <div
        style={{
          color: theme.muted,
          fontFamily: "var(--font-ibm-plex-mono)",
          fontSize: labelSize,
          letterSpacing: labelSize * 0.09,
          textTransform: "uppercase",
          marginBottom: canvas.w * 0.018,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-manrope)",
          fontWeight: 700,
          fontSize: headlineSize,
          lineHeight: 0.96,
          letterSpacing: -headlineSize * 0.055,
        }}
      >
        {headline}
      </div>
      <p
        style={{
          margin: `${canvas.w * 0.03}px 0 0`,
          color: theme.muted,
          fontSize: bodySize,
          lineHeight: 1.45,
          maxWidth: width,
        }}
      >
        {body}
      </p>
    </div>
  );
}

function SlideCanvas({
  canvas,
  theme,
  children,
  background,
}: {
  canvas: CanvasSize;
  theme: ThemeTokens;
  children: ReactNode;
  background?: string;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: canvas.w,
        height: canvas.h,
        overflow: "hidden",
        color: theme.text,
        background:
          background
          || `radial-gradient(circle at 18% 18%, ${theme.accentSoft} 0%, transparent 28%),
              radial-gradient(circle at 80% 12%, ${theme.decorative}22 0%, transparent 25%),
              linear-gradient(140deg, ${theme.bg} 0%, ${theme.bgAlt} 60%, ${theme.bgDeep} 100%)`,
        fontFamily: "var(--font-manrope)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: `${canvas.w * 0.045}px ${canvas.w * 0.045}px`,
          opacity: 0.22,
          maskImage:
            "linear-gradient(180deg, rgba(0,0,0,0.7), rgba(0,0,0,0.1) 40%, transparent 88%)",
        }}
      />
      {children}
    </div>
  );
}

function PhoneFrame({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        aspectRatio: `${MK_W}/${MK_H}`,
        ...style,
      }}
    >
      <img
        src={img("/mockup.png")}
        alt=""
        draggable={false}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      <div
        style={{
          position: "absolute",
          zIndex: 10,
          overflow: "hidden",
          left: `${SC_L}%`,
          top: `${SC_T}%`,
          width: `${SC_W}%`,
          height: `${SC_H}%`,
          borderRadius: `${SC_RX}% / ${SC_RY}%`,
          background: "#000000",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function IPadFrame({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        aspectRatio: "770 / 1000",
        ...style,
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "5% / 3.6%",
          background: "linear-gradient(180deg, #2c2c2e 0%, #1c1c1e 100%)",
          position: "relative",
          overflow: "hidden",
          boxShadow:
            "inset 0 0 0 1px rgba(255,255,255,0.1), 0 8px 40px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "1.2%",
            left: "50%",
            transform: "translateX(-50%)",
            width: "0.9%",
            height: "0.65%",
            borderRadius: "50%",
            background: "#111113",
            border: "1px solid rgba(255,255,255,0.08)",
            zIndex: 20,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "5% / 3.6%",
            border: "1px solid rgba(255,255,255,0.06)",
            pointerEvents: "none",
            zIndex: 15,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "4%",
            top: "2.8%",
            width: "92%",
            height: "94.4%",
            borderRadius: "2.2% / 1.6%",
            overflow: "hidden",
            background: "#000000",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function DeviceFrame({
  device,
  children,
  style,
}: {
  device: Device;
  children: ReactNode;
  style?: CSSProperties;
}) {
  if (device === "iphone") {
    return <PhoneFrame style={style}>{children}</PhoneFrame>;
  }

  return <IPadFrame style={style}>{children}</IPadFrame>;
}

function ScreenShell({
  theme,
  device,
  title,
  activeTab,
  children,
}: {
  theme: ThemeTokens;
  device: Device;
  title: string;
  activeTab: "chat" | "desktop" | "account";
  children: ReactNode;
}) {
  const padding =
    Math.round((device === "iphone" ? 34 : 46) * MOCK_PAD_SCALE);
  const textSize =
    (device === "iphone" ? 24 : 26) * SCREEN_MOCK_FONT_SCALE;
  const smallSize =
    (device === "iphone" ? 13 : 16) * SCREEN_MOCK_FONT_SCALE;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding,
        display: "flex",
        flexDirection: "column",
        gap: padding * 0.55,
        background: `linear-gradient(180deg, ${theme.screenBg} 0%, ${theme.screenPanel} 100%)`,
        color: theme.screenText,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontFamily: "var(--font-ibm-plex-mono)",
          fontSize: smallSize,
          color: theme.screenTextMuted,
          letterSpacing: 0.8,
        }}
      >
        <span>9:41</span>
        <span>LTE 100%</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <div
          style={{
            width: device === "iphone" ? 54 : 66,
            height: device === "iphone" ? 54 : 66,
            borderRadius: 18,
            background: theme.screenSurface,
            display: "grid",
            placeItems: "center",
            boxShadow: `0 12px 32px ${theme.screenBorder}`,
            border: `1px solid ${theme.screenBorder}`,
          }}
        >
          <img
            src={img("/splash-icon.png")}
            alt=""
            draggable={false}
            style={{ width: "72%", height: "72%" }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontFamily: "var(--font-ibm-plex-mono)",
              fontSize: smallSize * 0.88,
              letterSpacing: 1.2,
              color: theme.screenTextMuted,
            }}
          >
            STELLA
          </div>
          <div
            style={{
              fontSize: textSize,
              lineHeight: 1,
              letterSpacing: -0.8,
              fontWeight: 700,
            }}
          >
            {title}
          </div>
        </div>
        <Marker
          color={theme.screenSuccess}
          size={(device === "iphone" ? 12 : 14) * SCREEN_MOCK_FONT_SCALE}
        />
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: padding * 0.42 }}>
        {children}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 10,
          padding: 10,
          borderRadius: 999,
          background: theme.screenSurface,
          border: `1px solid ${theme.screenBorder}`,
          boxShadow: `0 16px 40px ${theme.screenBorder}`,
        }}
      >
        {[
          { key: "chat", label: "Chat" },
          { key: "desktop", label: "Desktop" },
          { key: "account", label: "Account" },
        ].map((tab) => {
          const active = tab.key === activeTab;
          return (
            <div
              key={tab.key}
              style={{
                padding: "12px 10px",
                textAlign: "center",
                borderRadius: 999,
                background: active ? theme.screenAccentSoft : "transparent",
                color: active ? theme.screenText : theme.screenTextMuted,
                fontWeight: active ? 700 : 600,
                fontSize:
                  (device === "iphone" ? 14 : 16) * SCREEN_MOCK_FONT_SCALE,
              }}
            >
              {tab.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Bubble({
  theme,
  device,
  align,
  children,
  accent = false,
}: {
  theme: ThemeTokens;
  device: Device;
  align: "left" | "right";
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        alignSelf: align === "right" ? "flex-end" : "flex-start",
        maxWidth: "78%",
        padding: device === "iphone" ? "17px 19px" : "19px 24px",
        borderRadius: 24,
        background: accent ? theme.screenAccentSoft : theme.screenSurface,
        color: accent ? theme.screenText : theme.screenText,
        border: `1px solid ${theme.screenBorder}`,
        fontSize:
          (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
        lineHeight: 1.4,
        boxShadow: `0 12px 30px ${theme.screenBorder}`,
      }}
    >
      {children}
    </div>
  );
}

function Composer({
  theme,
  device,
  placeholder,
  voiceActive = false,
}: {
  theme: ThemeTokens;
  device: Device;
  placeholder: string;
  voiceActive?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "48px 1fr 48px",
        gap: 11,
        alignItems: "center",
        padding: 11,
        borderRadius: 999,
        background: theme.screenSurface,
        border: `1px solid ${theme.screenBorder}`,
        boxShadow: `0 18px 40px ${theme.screenBorder}`,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          border: `1px dashed ${theme.screenBorder}`,
          display: "grid",
          placeItems: "center",
          color: theme.screenTextMuted,
          fontSize: 26 * SCREEN_MOCK_FONT_SCALE,
        }}
      >
        +
      </div>
      <div
        style={{
          color: voiceActive ? theme.screenAccent : theme.screenTextMuted,
          fontSize:
            (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
        }}
      >
        {placeholder}
      </div>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: voiceActive ? theme.screenAccentSoft : theme.screenAccent,
          color: voiceActive ? theme.screenAccent : theme.screenAccentForeground,
          fontWeight: 800,
          fontSize: 17 * SCREEN_MOCK_FONT_SCALE,
        }}
      >
        ^
      </div>
    </div>
  );
}

function ConnectHero({
  theme,
  device,
}: {
  theme: ThemeTokens;
  device: Device;
}) {
  const size = device === "iphone" ? 180 : 220;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        margin: "0 auto",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "12%",
          borderRadius: "50%",
          background: `radial-gradient(circle, ${theme.screenAccentSoft} 0%, transparent 72%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: "22%",
          borderRadius: "50%",
          background: theme.screenSurface,
          display: "grid",
          placeItems: "center",
          border: `1px solid ${theme.screenBorder}`,
        }}
      >
        <img
          src={img("/splash-icon.png")}
          alt=""
          draggable={false}
          style={{ width: "60%", height: "60%" }}
        />
      </div>
    </div>
  );
}

function HeroComputerScreen({
  theme,
  device,
}: {
  theme: ThemeTokens;
  device: Device;
}) {
  return (
    <ScreenShell theme={theme} device={device} title="Computer" activeTab="desktop">
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 18,
          textAlign: "center",
        }}
      >
        <ConnectHero theme={theme} device={device} />
        <div
          style={{
            fontFamily: "var(--font-cormorant)",
            fontStyle: "italic",
            fontSize:
              (device === "iphone" ? 38 : 44) * SCREEN_MOCK_FONT_SCALE,
            lineHeight: 1,
            letterSpacing: -1.4,
          }}
        >
          Your computer,
          <br />
          at your fingertips
        </div>
        <div
          style={{
            color: theme.screenTextMuted,
            fontSize:
              (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
            lineHeight: 1.45,
            paddingInline: "7%",
          }}
        >
          Browse the web, manage files, and run tasks from your phone.
        </div>
      </div>
      <Composer theme={theme} device={device} placeholder="Ask Stella to do something" />
    </ScreenShell>
  );
}

function ChatScreenMock({
  theme,
  device,
  voiceActive = false,
  attachments = false,
}: {
  theme: ThemeTokens;
  device: Device;
  voiceActive?: boolean;
  attachments?: boolean;
}) {
  return (
    <ScreenShell theme={theme} device={device} title="Chat" activeTab="chat">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Bubble theme={theme} device={device} align="left">
          I turned your notes into three next steps for Monday.
        </Bubble>
        <Bubble theme={theme} device={device} align="right" accent>
          Keep the quick wins first.
        </Bubble>
        <div
          style={{
            borderRadius: 28,
            background: theme.screenSurface,
            border: `1px solid ${theme.screenBorder}`,
            padding: device === "iphone" ? 18 : 22,
            boxShadow: `0 16px 36px ${theme.screenBorder}`,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-ibm-plex-mono)",
              fontSize:
                (device === "iphone" ? 12 : 14) * SCREEN_MOCK_FONT_SCALE,
              letterSpacing: 1.1,
              textTransform: "uppercase",
              color: theme.screenTextMuted,
              marginBottom: 10,
            }}
          >
            Today
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {["Draft the status update", "Review the launch notes", "Send the follow-up"].map((item) => (
              <div key={item} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <Marker color={theme.screenSuccess} />
                <span
                  style={{
                    fontSize:
                      (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
                  }}
                >
                  {item}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {attachments ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              style={{
                height: device === "iphone" ? 76 : 92,
                borderRadius: 20,
                background: `linear-gradient(135deg, ${theme.screenAccentSoft} 0%, ${theme.screenSurface} 100%)`,
                border: `1px solid ${theme.screenBorder}`,
              }}
            />
          ))}
        </div>
      ) : null}
      <Composer
        theme={theme}
        device={device}
        placeholder={voiceActive ? "Listening..." : "Message Stella"}
        voiceActive={voiceActive}
      />
    </ScreenShell>
  );
}

function ComputerTasksScreen({
  theme,
  device,
}: {
  theme: ThemeTokens;
  device: Device;
}) {
  return (
    <ScreenShell theme={theme} device={device} title="Computer" activeTab="desktop">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Bubble theme={theme} device={device} align="right" accent>
          Open the project brief and save a PDF summary.
        </Bubble>
        <Bubble theme={theme} device={device} align="left">
          On it. I opened the brief, pulled the main milestones, and saved a clean PDF.
        </Bubble>
        <div
          style={{
            borderRadius: 28,
            background: theme.screenSurface,
            border: `1px solid ${theme.screenBorder}`,
            padding: device === "iphone" ? 18 : 22,
            boxShadow: `0 16px 36px ${theme.screenBorder}`,
            display: "grid",
            gap: 12,
          }}
        >
          {[
            { label: "Open desktop app", color: theme.screenSuccess },
            { label: "Grab the latest brief", color: theme.screenSuccess },
            { label: "Save PDF summary", color: theme.screenAccent },
          ].map((step) => (
            <div key={step.label} style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Marker color={step.color} />
              <span
                style={{
                  fontSize:
                    (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
                }}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>
      <Composer theme={theme} device={device} placeholder="Ask Stella to do something" />
    </ScreenShell>
  );
}

function PairingScreenMock({
  theme,
  device,
}: {
  theme: ThemeTokens;
  device: Device;
}) {
  return (
    <ScreenShell theme={theme} device={device} title="Desktop" activeTab="desktop">
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 18,
        }}
      >
        <ConnectHero theme={theme} device={device} />
        <div
          style={{
            fontFamily: "var(--font-cormorant)",
            fontSize:
              (device === "iphone" ? 40 : 46) * SCREEN_MOCK_FONT_SCALE,
            lineHeight: 1,
            letterSpacing: -1.4,
            textAlign: "center",
          }}
        >
          Pair your phone
        </div>
        <div
          style={{
            color: theme.screenTextMuted,
            fontSize:
              (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
            lineHeight: 1.45,
            textAlign: "center",
            paddingInline: "7%",
          }}
        >
          Enter the code shown on your computer. After that, Stella reconnects automatically.
        </div>
        <div
          style={{
            borderRadius: 24,
            padding: device === "iphone" ? "18px 20px" : "20px 24px",
            background: theme.screenSurface,
            border: `1px solid ${theme.screenBorder}`,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-ibm-plex-mono)",
              textTransform: "uppercase",
              color: theme.screenTextMuted,
              fontSize:
                (device === "iphone" ? 12 : 14) * SCREEN_MOCK_FONT_SCALE,
              marginBottom: 10,
            }}
          >
            Code from your computer
          </div>
          <div
            style={{
              borderRadius: 18,
              padding: "16px 18px",
              background: theme.screenPanel,
              fontFamily: "var(--font-ibm-plex-mono)",
              fontSize:
                (device === "iphone" ? 28 : 34) * SCREEN_MOCK_FONT_SCALE,
              letterSpacing: 3,
            }}
          >
            ABCD-EFGH
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "Pair Phone", background: theme.screenAccent, color: theme.screenAccentForeground },
            { label: "Try again", background: theme.screenSurface, color: theme.screenText },
          ].map((button) => (
            <div
              key={button.label}
              style={{
                borderRadius: 999,
                padding: "16px 20px",
                textAlign: "center",
                background: button.background,
                color: button.color,
                fontWeight: 700,
                border: `1px solid ${theme.screenBorder}`,
                fontSize:
                  (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
              }}
            >
              {button.label}
            </div>
          ))}
        </div>
      </div>
    </ScreenShell>
  );
}

function AccountScreenMock({
  theme,
  device,
}: {
  theme: ThemeTokens;
  device: Device;
}) {
  const dotColors = [
    "#0f62fe",
    "#ee5396",
    "#8b5cf6",
    "#42be65",
    "#f59e0b",
    "#78a9ff",
    "#ff7eb6",
    "#c0caf5",
  ];

  return (
    <ScreenShell theme={theme} device={device} title="Account" activeTab="account">
      <div style={{ display: "grid", gap: 18 }}>
        <div>
          <div
            style={{
              fontFamily: "var(--font-cormorant)",
              fontSize:
                (device === "iphone" ? 42 : 50) * SCREEN_MOCK_FONT_SCALE,
              lineHeight: 1,
              letterSpacing: -1.4,
            }}
          >
            Stella
          </div>
          <div
            style={{
              color: theme.screenTextMuted,
              fontSize:
                (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
            }}
          >
            rahul@stella.sh
          </div>
        </div>

        <div
          style={{
            borderTop: `1px solid ${theme.screenBorder}`,
            paddingTop: 18,
          }}
        >
          <div
            style={{
              color: theme.screenTextMuted,
              fontFamily: "var(--font-ibm-plex-mono)",
              textTransform: "uppercase",
              fontSize:
                (device === "iphone" ? 12 : 14) * SCREEN_MOCK_FONT_SCALE,
              marginBottom: 12,
            }}
          >
            Mode
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 10,
            }}
          >
            {["System", "Light", "Dark"].map((item, index) => (
              <div
                key={item}
                style={{
                  borderRadius: 999,
                  padding: "12px 10px",
                  textAlign: "center",
                  background: index === 0 ? theme.screenAccentSoft : theme.screenSurface,
                  border: `1px solid ${theme.screenBorder}`,
                  fontWeight: index === 0 ? 700 : 600,
                  fontSize:
                    (device === "iphone" ? 15 : 17) * SCREEN_MOCK_FONT_SCALE,
                }}
              >
                {item}
              </div>
            ))}
          </div>
        </div>

        <div>
          <div
            style={{
              color: theme.screenTextMuted,
              fontFamily: "var(--font-ibm-plex-mono)",
              textTransform: "uppercase",
              fontSize:
                (device === "iphone" ? 12 : 14) * SCREEN_MOCK_FONT_SCALE,
              marginBottom: 12,
            }}
          >
            Theme
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 12,
            }}
          >
            {dotColors.map((color, index) => (
              <div
                key={color}
                style={{
                  height: device === "iphone" ? 54 : 64,
                  borderRadius: 999,
                  display: "grid",
                  placeItems: "center",
                  border: `1px solid ${index === 0 ? theme.screenAccent : theme.screenBorder}`,
                  background: theme.screenSurface,
                }}
              >
                <span
                  style={{
                    width: device === "iphone" ? 24 : 28,
                    height: device === "iphone" ? 24 : 28,
                    borderRadius: "50%",
                    background: color,
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 10,
            marginTop: "auto",
          }}
        >
          {["Terms of Service", "Privacy Policy", "Sign out"].map((row) => (
            <div
              key={row}
              style={{
                borderRadius: 20,
                padding: "16px 18px",
                background: theme.screenSurface,
                border: `1px solid ${theme.screenBorder}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize:
                  (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE,
              }}
            >
              <span>{row}</span>
              <span style={{ color: theme.screenTextMuted }}>&gt;</span>
            </div>
          ))}
        </div>
      </div>
    </ScreenShell>
  );
}

function FloatingCard({
  theme,
  title,
  body,
  style,
}: {
  theme: ThemeTokens;
  title: string;
  body: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: "absolute",
        padding: "22px 24px",
        borderRadius: 28,
        background: theme.card,
        border: `1px solid ${theme.cardBorder}`,
        boxShadow: theme.shadow,
        backdropFilter: "blur(20px)",
        maxWidth: 320,
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-ibm-plex-mono)",
          fontSize: 16 * MARKETING_FONT_SCALE,
          textTransform: "uppercase",
          letterSpacing: 1.2,
          color: theme.muted,
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 26 * MARKETING_FONT_SCALE,
          lineHeight: 1.2,
          color: theme.text,
        }}
      >
        {body}
      </div>
    </div>
  );
}

function FeatureListCard({
  theme,
  canvas,
  style,
}: {
  theme: ThemeTokens;
  canvas: CanvasSize;
  style?: CSSProperties;
}) {
  const items = [
    "Desktop mode",
    "Local-first privacy",
    "Photo attachments",
    "Offline chat",
    "Magic links",
    "17 themes",
  ];

  return (
    <div
      style={{
        position: "absolute",
        display: "flex",
        flexWrap: "wrap",
        gap: 14,
        maxWidth: canvas.w * 0.42,
        ...style,
      }}
    >
      {items.map((item, index) => (
        <div
          key={item}
          style={{
            padding: "16px 20px",
            borderRadius: 999,
            background: index % 2 === 0 ? theme.card : theme.chip,
            color: theme.text,
            border: `1px solid ${theme.cardBorder}`,
            fontSize:
              (canvas.w > 1500 ? 24 : 20) * MARKETING_FONT_SCALE,
            boxShadow: theme.shadow,
          }}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

function HeroSlide({ canvas, device, theme }: SlideRenderContext) {
  const logoSize = canvas.w * 0.82;
  const headlineSize = canvas.w * (device === "iphone" ? 0.13 : 0.1);
  const bodySize = canvas.w * (device === "iphone" ? 0.036 : 0.028);
  const subtleSize = bodySize * 0.84;
  const frameWidth = device === "iphone" ? "78%" : "64%";

  return (
    <SlideCanvas
      canvas={canvas}
      theme={theme}
      background={`radial-gradient(circle at 20% 16%, ${theme.accentSoft} 0%, transparent 30%),
        radial-gradient(circle at 24% 62%, ${theme.decorative}14 0%, transparent 20%),
        radial-gradient(circle at 78% 58%, ${theme.accent}10 0%, transparent 18%),
        linear-gradient(180deg, ${theme.bg} 0%, ${theme.bgAlt} 60%, ${theme.bgDeep} 100%)`}
    >
      {/* Large Stella logo — top left, bleeds off edge */}
      <img
        src={img("/stella-logo.svg")}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          left: canvas.w * -0.1,
          top: canvas.h * -0.02,
          width: logoSize,
          height: logoSize,
          objectFit: "contain",
          opacity: 0.6,
        }}
      />

      {/* Headline overlapping the logo */}
      <div
        style={{
          position: "absolute",
          left: canvas.w * 0.08,
          top: canvas.h * 0.07,
          width: canvas.w * 0.84,
          zIndex: 2,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-cormorant)",
            fontWeight: 300,
            fontSize: headlineSize,
            lineHeight: 0.9,
            letterSpacing: -headlineSize * 0.06,
            color: theme.text,
          }}
        >
          <span style={{ fontStyle: "italic" }}>Your Personal</span>
          <br />
          AI Assistant
        </div>
        <p
          style={{
            margin: `${canvas.h * 0.022}px 0 0`,
            fontSize: bodySize,
            lineHeight: 1.4,
            color: theme.text,
          }}
        >
          Stella lives on your devices to do anything you need.
        </p>
        <p
          style={{
            margin: `${canvas.h * 0.008}px 0 0`,
            fontSize: subtleSize,
            color: theme.muted,
          }}
        >
          Private by design. Control your computer from your phone.
        </p>
      </div>

      {/* Phone mock at bottom */}
      <DeviceFrame
        device={device}
        style={{
          width: frameWidth,
          left: "50%",
          bottom: device === "iphone" ? "-2%" : "1%",
          transform: "translateX(-50%)",
        }}
      >
        <HeroComputerScreen theme={theme} device={device} />
      </DeviceFrame>
    </SlideCanvas>
  );
}

function ChatSlide({ canvas, device, theme }: SlideRenderContext) {
  const background = `radial-gradient(circle at 75% 22%, ${theme.decorative}22 0%, transparent 24%), radial-gradient(circle at 18% 16%, ${theme.accentSoft} 0%, transparent 26%), linear-gradient(145deg, ${theme.bgDeep} 0%, ${theme.bg} 58%, ${theme.bgAlt} 100%)`;

  return (
    <SlideCanvas canvas={canvas} theme={theme} background={background}>
      <Caption
        canvas={canvas}
        theme={theme}
        label="Pocket assistant"
        headline={
          <>
            Ask Stella
            <br />
            anything.
          </>
        }
        body="The chat surface already sells a clear value: quick answers, tidy next steps, and a composer that supports voice."
        width={canvas.w * (device === "iphone" ? 0.46 : 0.36)}
        align="right"
        style={{
          right: canvas.w * 0.08,
          top: canvas.h * 0.09,
        }}
      />

      <DeviceFrame
        device={device}
        style={{
          width: device === "iphone" ? "58%" : "46%",
          left: device === "iphone" ? "-6%" : "3%",
          bottom: device === "iphone" ? "2%" : "5%",
          transform: "rotate(-6deg)",
          opacity: 0.82,
        }}
      >
        <ChatScreenMock theme={theme} device={device} voiceActive />
      </DeviceFrame>

      <DeviceFrame
        device={device}
        style={{
          width: device === "iphone" ? "72%" : "56%",
          left: device === "iphone" ? "16%" : "20%",
          bottom: device === "iphone" ? "-1%" : "1%",
          transform: "rotate(3deg)",
        }}
      >
        <ChatScreenMock theme={theme} device={device} />
      </DeviceFrame>
    </SlideCanvas>
  );
}

function TasksSlide({ canvas, device, theme }: SlideRenderContext) {
  return (
    <SlideCanvas
      canvas={canvas}
      theme={theme}
      background={`radial-gradient(circle at 16% 24%, ${theme.decorative}18 0%, transparent 18%), radial-gradient(circle at 84% 16%, ${theme.accentSoft} 0%, transparent 25%), linear-gradient(140deg, ${theme.bg} 0%, ${theme.bgAlt} 55%, ${theme.bgDeep} 100%)`}
    >
      <Caption
        canvas={canvas}
        theme={theme}
        label="Computer mode"
        headline={
          <>
            Run tasks
            <br />
            from your phone.
          </>
        }
        body="Repo copy in the mobile app already promises real actions on your computer. This slide turns that into a single concrete payoff."
        width={canvas.w * (device === "iphone" ? 0.42 : 0.3)}
        style={{
          left: canvas.w * 0.08,
          top: canvas.h * 0.11,
        }}
      />

      <FloatingCard
        theme={theme}
        title="Live status"
        body="Open the brief. Save the PDF."
        style={{
          left: canvas.w * 0.08,
          top: canvas.h * 0.44,
          transform: "rotate(-4deg)",
        }}
      />

      <FloatingCard
        theme={theme}
        title="Result"
        body="Done before you get back."
        style={{
          left: canvas.w * 0.16,
          bottom: canvas.h * 0.12,
          transform: "rotate(3deg)",
        }}
      />

      <DeviceFrame
        device={device}
        style={{
          width: device === "iphone" ? "64%" : "50%",
          right: device === "iphone" ? "4%" : "8%",
          bottom: device === "iphone" ? "3%" : "6%",
        }}
      >
        <ComputerTasksScreen theme={theme} device={device} />
      </DeviceFrame>
    </SlideCanvas>
  );
}

function PairingSlide({ canvas, device, theme }: SlideRenderContext) {
  return (
    <SlideCanvas
      canvas={canvas}
      theme={theme}
      background={`radial-gradient(circle at 84% 18%, ${theme.decorative}1f 0%, transparent 24%), radial-gradient(circle at 14% 16%, ${theme.accentSoft} 0%, transparent 26%), linear-gradient(180deg, ${theme.bg} 0%, ${theme.bgAlt} 100%)`}
    >
      <Caption
        canvas={canvas}
        theme={theme}
        label="Fast setup"
        headline={
          <>
            Pair once.
            <br />
            Reconnect fast.
          </>
        }
        body="Use the code from your desktop app to pair your phone. After that, Stella reconnects when you are back at your machine."
        width={canvas.w * (device === "iphone" ? 0.66 : 0.44)}
        style={{
          left: canvas.w * 0.08,
          top: canvas.h * 0.09,
        }}
      />

      <Badge
        theme={theme}
        style={{
          position: "absolute",
          right: canvas.w * 0.08,
          top: canvas.h * 0.12,
        }}
      >
        Code flow
        <span style={{ letterSpacing: 2.4 }}>ABCD-EFGH</span>
      </Badge>

      <DeviceFrame
        device={device}
        style={{
          width: device === "iphone" ? "74%" : "56%",
          left: "50%",
          bottom: device === "iphone" ? "-2%" : "2%",
          transform: "translateX(-50%)",
        }}
      >
        <PairingScreenMock theme={theme} device={device} />
      </DeviceFrame>
    </SlideCanvas>
  );
}

function PrivacyScreenMock({
  theme,
  device,
}: {
  theme: ThemeTokens;
  device: Device;
}) {
  const rowSize = (device === "iphone" ? 16 : 18) * SCREEN_MOCK_FONT_SCALE;

  return (
    <ScreenShell theme={theme} device={device} title="Privacy" activeTab="account">
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: device === "iphone" ? 16 : 20,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-cormorant)",
            fontSize: (device === "iphone" ? 38 : 44) * SCREEN_MOCK_FONT_SCALE,
            lineHeight: 1.05,
            letterSpacing: -1.2,
            textAlign: "center",
          }}
        >
          Your data stays
          <br />
          on your devices
        </div>
        <p
          style={{
            margin: 0,
            textAlign: "center",
            color: theme.screenTextMuted,
            fontSize: (device === "iphone" ? 15 : 17) * SCREEN_MOCK_FONT_SCALE,
            lineHeight: 1.45,
            paddingInline: "4%",
          }}
        >
          Chats and local context are stored on your phone and computer — not on Stella&apos;s servers.
        </p>
        <div
          style={{
            borderRadius: 28,
            background: theme.screenSurface,
            border: `1px solid ${theme.screenBorder}`,
            padding: device === "iphone" ? 18 : 22,
            boxShadow: `0 16px 36px ${theme.screenBorder}`,
            display: "grid",
            gap: 14,
          }}
        >
          {[
            "Messages are not uploaded for cloud storage",
            "Your conversations stay local by default",
            "You keep control of what stays on-device",
          ].map((line) => (
            <div
              key={line}
              style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
            >
              <Marker color={theme.screenSuccess} size={11 * SCREEN_MOCK_FONT_SCALE} />
              <span style={{ fontSize: rowSize, lineHeight: 1.35 }}>{line}</span>
            </div>
          ))}
        </div>
      </div>
    </ScreenShell>
  );
}

function PrivacySlide({ canvas, device, theme }: SlideRenderContext) {
  return (
    <SlideCanvas
      canvas={canvas}
      theme={theme}
      background={`radial-gradient(circle at 20% 30%, ${theme.accentSoft} 0%, transparent 22%), radial-gradient(circle at 82% 74%, ${theme.decorative}28 0%, transparent 18%), linear-gradient(145deg, ${theme.bgDeep} 0%, ${theme.bgAlt} 52%, ${theme.bg} 100%)`}
    >
      <Caption
        canvas={canvas}
        theme={theme}
        label="Privacy"
        headline={
          <>
            Local-first.
            <br />
            Not cloud-first.
          </>
        }
        body="Stella keeps chats and context on your devices instead of warehousing messages on company servers."
        width={canvas.w * (device === "iphone" ? 0.42 : 0.3)}
        align="right"
        style={{
          right: canvas.w * 0.08,
          top: canvas.h * 0.12,
        }}
      />

      <FloatingCard
        theme={theme}
        title="On your hardware"
        body="Phone and desktop hold the conversation."
        style={{
          left: canvas.w * 0.08,
          top: canvas.h * 0.18,
          transform: "rotate(-5deg)",
        }}
      />

      <FloatingCard
        theme={theme}
        title="No server inbox"
        body="We do not store your message history in the cloud."
        style={{
          left: canvas.w * 0.12,
          bottom: canvas.h * 0.15,
          transform: "rotate(4deg)",
          maxWidth: 380,
        }}
      />

      <DeviceFrame
        device={device}
        style={{
          width: device === "iphone" ? "66%" : "52%",
          right: device === "iphone" ? "4%" : "8%",
          bottom: device === "iphone" ? "1%" : "4%",
        }}
      >
        <PrivacyScreenMock theme={theme} device={device} />
      </DeviceFrame>
    </SlideCanvas>
  );
}

function AccountSlide({ canvas, device, theme }: SlideRenderContext) {
  return (
    <SlideCanvas
      canvas={canvas}
      theme={theme}
      background={`radial-gradient(circle at 74% 18%, ${theme.decorative}1a 0%, transparent 22%), radial-gradient(circle at 18% 14%, ${theme.accentSoft} 0%, transparent 24%), linear-gradient(135deg, ${theme.bgDeep} 0%, ${theme.bgAlt} 58%, ${theme.bg} 100%)`}
    >
      <Caption
        canvas={canvas}
        theme={theme}
        label="Craft and control"
        headline={
          <>
            Make Stella
            <br />
            yours.
          </>
        }
        body="The account tab shows polish beyond chat alone: mode controls, theme selection, legal links, and a more personal feel."
        width={canvas.w * (device === "iphone" ? 0.4 : 0.28)}
        style={{
          left: canvas.w * 0.56,
          top: canvas.h * 0.11,
        }}
      />

      <FeatureListCard
        theme={theme}
        canvas={canvas}
        style={{
          left: canvas.w * 0.56,
          top: canvas.h * 0.40,
        }}
      />

      <div
        style={{
          position: "absolute",
          left: canvas.w * 0.07,
          top: canvas.h * 0.08,
          width: canvas.w * 0.1,
          height: canvas.w * 0.1,
          borderRadius: "28%",
          overflow: "hidden",
          boxShadow: theme.shadow,
        }}
      >
        <img
          src={img("/app-icon.png")}
          alt="Stella icon"
          draggable={false}
          style={{ width: "100%", height: "100%" }}
        />
      </div>

      <DeviceFrame
        device={device}
        style={{
          width: device === "iphone" ? "48%" : "40%",
          left: device === "iphone" ? "8%" : "8%",
          bottom: device === "iphone" ? "4%" : "6%",
          transform: "rotate(-3deg)",
        }}
      >
        <AccountScreenMock theme={theme} device={device} />
      </DeviceFrame>
    </SlideCanvas>
  );
}

function ScreenshotPreview({
  canvas,
  minHeight,
  children,
}: {
  canvas: CanvasSize;
  minHeight: number;
  children: ReactNode;
}) {
  const { containerRef, scale } = useScaleToFit(canvas, minHeight);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        height: minHeight,
        overflow: "hidden",
        borderRadius: 26,
        background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: canvas.w,
          height: canvas.h,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function makeSlides(): SlideDefinition[] {
  return [
    {
      slug: "hero",
      tabLabel: "Hero",
      sectionLabel: "Meet Stella",
      headline: (
        <>
          Your personal
          <br />
          AI assistant.
        </>
      ),
      body: "Large icon, headline, and the three pillars: personal AI, private, desktop control.",
      render: HeroSlide,
    },
    {
      slug: "chat",
      tabLabel: "Chat",
      sectionLabel: "Pocket assistant",
      headline: (
        <>
          Ask Stella
          <br />
          anything.
        </>
      ),
      body: "Show the mobile chat experience as the everyday entry point.",
      render: ChatSlide,
    },
    {
      slug: "tasks",
      tabLabel: "Tasks",
      sectionLabel: "Computer mode",
      headline: (
        <>
          Run tasks
          <br />
          from your phone.
        </>
      ),
      body: "Turn the computer mode promise into a concrete work result.",
      render: TasksSlide,
    },
    {
      slug: "pairing",
      tabLabel: "Pairing",
      sectionLabel: "Fast setup",
      headline: (
        <>
          Pair once.
          <br />
          Reconnect fast.
        </>
      ),
      body: "Show the desktop pairing code flow: pair once, then automatic reconnects when you return.",
      render: PairingSlide,
    },
    {
      slug: "privacy",
      tabLabel: "Privacy",
      sectionLabel: "Privacy",
      headline: (
        <>
          Local-first.
          <br />
          Not cloud-first.
        </>
      ),
      body: "Spell out local storage and no cloud message warehousing — a clear trust story for the App Store.",
      render: PrivacySlide,
    },
    {
      slug: "account",
      tabLabel: "Themes",
      sectionLabel: "Craft and control",
      headline: (
        <>
          Make Stella
          <br />
          yours.
        </>
      ),
      body: "Finish with trust, personalization, and polish.",
      render: AccountSlide,
    },
  ];
}

export default function ScreenshotsPage() {
  const slides = useMemo(() => makeSlides(), []);
  const [ready, setReady] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>("carbon");
  const [device, setDevice] = useState<Device>("iphone");
  const [sizeLabel, setSizeLabel] = useState(sizesFor("iphone")[0].label);
  const [activeSlide, setActiveSlide] = useState(0);
  const [status, setStatus] = useState("Ready to export.");
  const [busy, setBusy] = useState(false);
  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);

  const theme = THEMES[themeId];
  const canvas = canvasFor(device);
  const sizes = sizesFor(device);
  const selectedSize = sizes.find((size) => size.label === sizeLabel) ?? sizes[0];

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedTheme = params.get("theme");
    const requestedDevice = params.get("device");

    if (requestedTheme && requestedTheme in THEMES) {
      setThemeId(requestedTheme as ThemeId);
    }

    if (requestedDevice === "iphone" || requestedDevice === "ipad") {
      setDevice(requestedDevice);
    }
  }, []);

  useEffect(() => {
    setSizeLabel((current) => {
      const available = sizesFor(device);
      return available.some((size) => size.label === current)
        ? current
        : available[0].label;
    });
  }, [device]);

  useEffect(() => {
    let cancelled = false;

    void preloadAllImages()
      .then(() => {
        if (!cancelled) {
          setReady(true);
        }
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) {
          setStatus("Could not preload assets.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const captureSlide = useCallback(async (index: number) => {
    const node = slideRefs.current[index];

    if (!node) {
      throw new Error("Slide is not mounted for export.");
    }

    node.style.left = "0px";
    node.style.opacity = "1";
    node.style.zIndex = "-1";

    try {
      const options = {
        width: canvas.w,
        height: canvas.h,
        pixelRatio: 1,
        cacheBust: true,
      };

      await wait(80);
      await toPng(node, options);
      const dataUrl = await toPng(node, options);
      const resized = await flattenAndResize(dataUrl, selectedSize.w, selectedSize.h);

      return resized;
    } finally {
      node.style.left = "-9999px";
      node.style.opacity = "0";
      node.style.zIndex = "";
    }
  }, [canvas.h, canvas.w, selectedSize.h, selectedSize.w]);

  const slideFilename = useCallback((index: number) => {
    const folder = `${device}/${selectedSize.w}x${selectedSize.h}`;
    return `${folder}/${index + 1}-${slides[index].slug}.png`;
  }, [device, selectedSize.h, selectedSize.w, slides]);

  const exportOne = useCallback(async (index: number) => {
    setBusy(true);
    const name = slideFilename(index);
    setStatus(`Saving ${name}...`);

    try {
      const dataUrl = await captureSlide(index);
      await saveToDisk(dataUrl, name);
      setStatus(`Saved out/${name}`);
    } catch (error) {
      console.error(error);
      setStatus("Export failed.");
    } finally {
      setBusy(false);
    }
  }, [captureSlide, slideFilename]);

  const exportAll = useCallback(async () => {
    setBusy(true);
    setStatus("Exporting all slides...");

    try {
      for (const [index, slide] of slides.entries()) {
        const name = slideFilename(index);
        setStatus(`Saving ${name}...`);
        const dataUrl = await captureSlide(index);
        await saveToDisk(dataUrl, name);
        setStatus(`Saved out/${name}`);
        await wait(300);
      }
      setStatus(`All slides saved to out/${device}/${selectedSize.w}x${selectedSize.h}/`);
    } catch (error) {
      console.error(error);
      setStatus("Bulk export failed.");
    } finally {
      setBusy(false);
    }
  }, [captureSlide, device, selectedSize.h, selectedSize.w, slideFilename, slides]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-center">
        <div className="max-w-md rounded-[28px] border border-white/10 bg-white/5 px-8 py-10 shadow-2xl backdrop-blur-xl">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/60">Stella</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">Loading assets...</h1>
          <p className="mt-4 text-sm leading-7 text-white/70">
            Preparing the mockup, app icon, and export pipeline.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-5 py-6 text-white md:px-8 md:py-8">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
        <section className="rounded-[32px] border border-white/10 bg-white/6 p-6 shadow-2xl backdrop-blur-xl md:p-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/60">
                Stella App Store Screenshots
              </p>
              <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">
                Export-ready marketing slides from the mobile app itself.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-white/72 md:text-lg">
                Built from `mobile/` because no raw screenshot set was present. The copy, iconography,
                pairing story, chat surface, computer mode, and theme treatment all come from the
                existing Stella mobile app.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="rounded-full border border-white/15 bg-white/10 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void exportOne(activeSlide)}
                disabled={busy}
              >
                Export current
              </button>
              <button
                type="button"
                className="rounded-full bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void exportAll()}
                disabled={busy}
              >
                Export all
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-[1.25fr,1fr]">
            <div className="rounded-[24px] border border-white/10 bg-slate-950/30 p-4">
              <div className="text-xs uppercase tracking-[0.25em] text-white/45">Narrative arc</div>
              <p className="mt-3 text-sm leading-7 text-white/70">
                Hero desktop control, everyday chat, real task execution, device pairing, local privacy,
                and polished personalization. Slides two and five intentionally use more visual contrast so the
                set does not feel templated.
              </p>
            </div>

            <div className="rounded-[24px] border border-white/10 bg-slate-950/30 p-4">
              <div className="text-xs uppercase tracking-[0.25em] text-white/45">Current status</div>
              <p className="mt-3 text-sm leading-7 text-white/70">{status}</p>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {Object.entries(THEMES).map(([id, tokens]) => {
                const active = id === themeId;

                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setThemeId(id as ThemeId)}
                    className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                      active
                        ? "border-transparent bg-white text-slate-950"
                        : "border-white/15 bg-white/8 text-white hover:bg-white/14"
                    }`}
                  >
                    {tokens.name}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {(["iphone", "ipad"] as const).map((item) => {
                const active = item === device;

                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setDevice(item)}
                    className={`rounded-full border px-4 py-2 text-sm font-medium capitalize transition ${
                      active
                        ? "border-transparent bg-white text-slate-950"
                        : "border-white/15 bg-white/8 text-white hover:bg-white/14"
                    }`}
                  >
                    {item}
                  </button>
                );
              })}

              <label className="ml-auto flex items-center gap-3 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm text-white/85">
                <span>Export size</span>
                <select
                  value={selectedSize.label}
                  onChange={(event) => setSizeLabel(event.target.value)}
                  className="rounded-full bg-slate-950/60 px-3 py-1 text-sm text-white outline-none"
                >
                  {sizes.map((size) => (
                    <option key={size.label} value={size.label}>
                      {size.label} ({size.w}x{size.h})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {slides.map((slide, index) => {
            const isActive = activeSlide === index;
            const rendered = slide.render({ canvas, device, theme });

            return (
              <article
                key={slide.slug}
                className={`overflow-hidden rounded-[28px] border transition ${
                  isActive
                    ? "border-white/30 bg-white/10 shadow-[0_20px_80px_rgba(0,0,0,0.28)]"
                    : "border-white/10 bg-white/5"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActiveSlide(index)}
                  className="block w-full text-left"
                >
                  <div className="flex items-center justify-between px-5 pt-5 text-xs uppercase tracking-[0.25em] text-white/50">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <span>{slide.tabLabel}</span>
                  </div>
                  <div className="px-5 pb-3 pt-4">
                    <h2 className="text-2xl font-semibold tracking-tight text-white">{slide.sectionLabel}</h2>
                    <p className="mt-2 text-sm leading-6 text-white/65">{slide.body}</p>
                  </div>
                  <div className="px-4 pb-4">
                    <ScreenshotPreview
                      canvas={canvas}
                      minHeight={device === "iphone" ? 560 : 430}
                    >
                      {rendered}
                    </ScreenshotPreview>
                  </div>
                </button>
                <div className="flex items-center justify-between border-t border-white/10 px-5 py-4">
                  <div className="text-sm text-white/55">
                    {selectedSize.w}x{selectedSize.h}
                  </div>
                  <button
                    type="button"
                    onClick={() => void exportOne(index)}
                    disabled={busy}
                    className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Export PNG
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      </div>

      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: -9999,
          top: 0,
          pointerEvents: "none",
        }}
      >
        {slides.map((slide, index) => (
          <div
            key={`${slide.slug}-${device}-${themeId}`}
            ref={(node) => {
              slideRefs.current[index] = node;
            }}
            style={{
              position: "absolute",
              left: -9999,
              top: 0,
              width: canvas.w,
              height: canvas.h,
              opacity: 0,
              fontFamily: "var(--font-manrope)",
            }}
          >
            {slide.render({ canvas, device, theme })}
          </div>
        ))}
      </div>
    </main>
  );
}
