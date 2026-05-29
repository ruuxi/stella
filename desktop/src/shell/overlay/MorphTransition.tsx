import { useEffect, useRef, useState } from "react";
import type { SelfModHmrState } from "../../../../runtime/contracts/index.js";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  MORPH_STEADY_STRENGTH,
  type MorphVisualTiming,
} from "../../shared/contracts/morph-timing";
import { useTheme } from "@/context/theme-context";

/** Onboarding demo morph — stronger distortion + slower timing (see `flavor` IPC). */
const ONBOARDING_MORPH_STEADY_STRENGTH = 0.65;
const ONBOARDING_MORPH_COVER_RAMP_MS = 600;
const ONBOARDING_MORPH_HANDOFF_FADE_MS = 800;

const DEFAULT_HMR_VISUAL_TIMING: MorphVisualTiming =
  DEFAULT_MORPH_TIMING_SETTINGS.hmr;

const coerceTimingMs = (
  value: unknown,
  fallback: number,
  min = 0,
  max = 10_000,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const normalizeVisualTiming = (
  timing: MorphVisualTiming | null | undefined,
): MorphVisualTiming => ({
  coverRampMs: coerceTimingMs(
    timing?.coverRampMs,
    DEFAULT_HMR_VISUAL_TIMING.coverRampMs,
  ),
  handoffFadeMs: coerceTimingMs(
    timing?.handoffFadeMs,
    DEFAULT_HMR_VISUAL_TIMING.handoffFadeMs,
  ),
});

type MorphFlavor = "hmr" | "onboarding";

type MorphPhase = "idle" | "covering" | "crossfading";

type MorphState = {
  phase: MorphPhase;
  x: number;
  y: number;
  width: number;
  height: number;
};

const IDLE_STATE: MorphState = {
  phase: "idle",
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
};

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Calm "blur + glimm band sweep". The old screenshot frosts (golden-angle
 * disk blur) as `u_strength` ramps up and holds during the HMR/reload work.
 * Then `u_reveal` drives a left→right band; the sharp new screenshot is
 * revealed behind the band as it travels, frosted old ahead of it.
 *
 * The band reproduces glimm's flat-band look (https://glimm.dev) — gaussian
 * band profile (`bandTight` 14), edge wave, and the synthesized-normal
 * Fresnel/spec "swell" that reads as iOS name-drop iridescence. Rather than
 * painting a color, the band acts as a saturation lens: it pushes the
 * underlying content's own colors more vivid as the sweep passes over it.
 */
const BLUR_FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_tex2;
uniform float u_strength;
uniform float u_reveal;
uniform float u_time;
uniform float u_alpha;
uniform float u_aspect;
// "Stella is changing..." label, pre-rendered to a transparent canvas.
uniform sampler2D u_label;
uniform float u_has_label;
varying vec2 v_uv;

const int BLUR_TAPS = 48;
const float TWO_PI = 6.28318530718;
const float PI = 3.14159265359;
const float GOLDEN_ANGLE = 2.39996323;

// Band width as an intuitive thickness knob — higher = thicker. Converted to
// the gaussian's internal tightness (which is inverse) below.
const float BAND_WIDTH = 16.0;
const float WAVE_AMOUNT = 1.0;
const float SWELL_AMOUNT = 0.8;
// Vibrance multiplier for the saturation-lens band: 1.0 = unchanged, higher
// pushes the content's own colors more vivid as the sweep passes over it.
const float SAT_BOOST = 1.8;

// Interleaved gradient noise — a cheap, well-distributed per-pixel value.
// We use it to rotate each pixel's sampling spiral by a unique angle so
// undersampling shows up as fine film grain instead of visible rings/banding.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

vec3 frostedSample(sampler2D tex, vec2 uv, float radius, float rot) {
  if (radius < 0.0006) {
    return texture2D(tex, uv).rgb;
  }
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < BLUR_TAPS; i++) {
    float fi = float(i) + 0.5;
    float t = fi / float(BLUR_TAPS);
    // sqrt() distributes samples evenly across the disk area.
    float r = sqrt(t) * radius;
    float a = fi * GOLDEN_ANGLE + rot;
    vec2 off = vec2(cos(a) / u_aspect, sin(a)) * r;
    // Gaussian-ish radial falloff so the kernel is soft, not a hard disk.
    float w = exp(-2.2 * t);
    acc += texture2D(tex, clamp(uv + off, 0.0, 1.0)).rgb * w;
    wsum += w;
  }
  return acc / wsum;
}

void main() {
  float rot = ign(gl_FragCoord.xy) * TWO_PI;
  vec3 frostedOld = frostedSample(u_tex, v_uv, u_strength * 0.04, rot);
  vec3 sharpNew = texture2D(u_tex2, v_uv).rgb;

  // glimm ltr sweep travels from -0.2 to 1.2; the reveal boundary rides the
  // band centre so the band masks the old→new seam as it passes.
  float axis = v_uv.x;
  float crossAxis = v_uv.y;
  float pos = mix(-0.2, 1.2, u_reveal);

  float feather = 0.05;
  float revealed = 1.0 - smoothstep(pos - feather, pos + feather, axis);
  vec3 base = mix(frostedOld, sharpNew, revealed);

  // Updating label baked onto the cover: sharp text over the frosted-old side,
  // fading in with the frost (u_strength) and swept away with the reveal band
  // (the 1.0 - revealed mask).
  if (u_has_label > 0.5) {
    vec4 lbl = texture2D(u_label, v_uv);
    float labelFade = (1.0 - revealed) * smoothstep(0.0, 0.35, u_strength);
    base = mix(base, lbl.rgb, lbl.a * labelFade);
  }

  // ——— glimm flat-band look ———
  float tw = u_time;
  float waveX =
      sin(crossAxis * 6.0 + tw * 1.3) * 0.020
    + sin(crossAxis * 13.0 - tw * 0.9 + 1.4) * 0.012
    + sin(crossAxis * 21.0 + tw * 1.7 + 2.6) * 0.006;
  waveX *= WAVE_AMOUNT;

  // Higher BAND_WIDTH → smaller tightness → wider/thicker band.
  float bandTight = 140.0 / BAND_WIDTH;
  float d = (axis - pos) - waveX;
  float band = exp(-d * d * bandTight);

  // Synthesized surface normal from the band's analytic slope → the basis for
  // the iridescent hue shift + specular crest (glimm's name-drop trick).
  float dhDaxis = -2.0 * d * bandTight * band;
  vec3 N = normalize(vec3(-dhDaxis * 0.18, 0.0, 1.0));

  float trail = clamp(0.5 - d * 1.3, 0.0, 1.0);
  trail = pow(trail, 2.5) * 0.24;
  // Flatten the gaussian falloff for the saturation lens so the band's sides
  // carry more strength (the sharp specular crest still uses raw band).
  float lensBand = pow(band, 0.7);
  float intensity = max(lensBand * 0.55, trail);

  float vfade =
    smoothstep(0.0, 0.015, crossAxis) * smoothstep(1.0, 0.985, crossAxis);

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(0.35, 0.55, 0.9));
  vec3 H = normalize(L + V);
  float NdotH = clamp(dot(N, H), 0.0, 1.0);
  float NdotV = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = pow(1.0 - NdotV, 3.0);
  float spec = pow(NdotH, 80.0);

  // Soften the band's entry/exit, and gate it fully off during the cover hold
  // (u_reveal == 0) and at the very end so no band residue lingers.
  float entryFade = mix(0.2, 1.0, 4.0 * u_reveal * (1.0 - u_reveal));
  float gate = smoothstep(0.0, 0.04, u_reveal) * smoothstep(1.0, 0.96, u_reveal);

  // Saturation lens: the sweep pushes the content's own colors more vivid (with
  // a slight contrast/brightness lift toward the crest) instead of painting a
  // theme tint, so the band reads as a pulse of the user's actual UI.
  float lensMix = clamp(intensity * vfade * entryFade * gate, 0.0, 1.0);
  float luma = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 vivid = clamp(mix(vec3(luma), base, SAT_BOOST), 0.0, 1.0);
  vivid = clamp((vivid - 0.5) * 1.06 + 0.5, 0.0, 1.0);
  vivid *= (1.0 + 0.05 * intensity);
  vec3 outRGB = mix(base, vivid, lensMix);

  // Glassy specular crest rides the band centre — a content-agnostic white
  // sheen plus a faint fresnel of the vivid content keeps it feeling alive.
  float highMask = band * vfade * entryFade * gate * SWELL_AMOUNT;
  outRGB += (vec3(spec) * 0.9 + vivid * fresnel * 0.25) * highMask;
  outRGB = clamp(outRGB, 0.0, 1.0);

  gl_FragColor = vec4(outRGB, u_alpha);
}`;

type ShaderGLContext = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  buf: WebGLBuffer;
  tex: WebGLTexture;
  tex2: WebGLTexture;
  labelTex: WebGLTexture | null;
  strengthLoc: WebGLUniformLocation | null;
  timeLoc: WebGLUniformLocation | null;
  alphaLoc: WebGLUniformLocation | null;
  revealLoc: WebGLUniformLocation | null;
};

type GLContext = ShaderGLContext;

/**
 * Decode a screenshot data URL to an `ImageBitmap`. Image decode runs off
 * the renderer main thread (`createImageBitmap` uses an internal worker),
 * which is meaningfully faster than the older `<img>` path on big captures.
 *
 * We can't `fetch(dataUrl)` here — the overlay window's CSP allows
 * `data:` under `img-src` but not under `connect-src`, so the fetch is
 * blocked with no visible error. Inline the base64 decode instead.
 */
async function loadImage(src: string): Promise<ImageBitmap> {
  const commaIdx = src.indexOf(",");
  if (commaIdx < 0) {
    throw new Error("loadImage: invalid data URL");
  }
  const header = src.slice(0, commaIdx);
  const mimeMatch = /^data:([^;,]+)/.exec(header);
  const mime = mimeMatch?.[1]?.trim().toLowerCase() || "image/png";
  const base64 = src.slice(commaIdx + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return createImageBitmap(new Blob([bytes], { type: mime }));
}

function compileProgram(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string,
): { prog: WebGLProgram; vs: WebGLShader; fs: WebGLShader } {
  const createShader = (type: number, src: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  };
  const vs = createShader(gl.VERTEX_SHADER, vertSrc);
  const fs = createShader(gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  return { prog, vs, fs };
}

/**
 * Resolve the app's display serif (Cormorant Garamond) from the overlay's
 * theme CSS vars, falling back to the literal stack.
 */
function getDisplayFontFamily(): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-family-display")
      .trim();
    if (v) return v;
  } catch {
    // overlay may not have computed styles yet; fall through
  }
  return "'Cormorant Garamond', Georgia, serif";
}

/**
 * Render the "Stella is changing..." label centered on a transparent canvas at
 * the morph's pixel size, so it can be uploaded as a texture and composited
 * onto the frosted cover.
 */
function createUpdatingLabelCanvas(
  width: number,
  height: number,
  fillColor: string,
  fontFamily: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const fontPx = Math.round(height * 0.036);
  ctx.font = `italic 400 ${fontPx}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const text = "Stella is changing...";
  const cx = width / 2;
  const cy = height / 2;

  ctx.fillStyle = fillColor;
  ctx.fillText(text, cx, cy);
  return canvas;
}

function uploadTexture(
  gl: WebGLRenderingContext,
  unit: number,
  img: TexImageSource,
): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.activeTexture(unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

function initShaderGL(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
  label?: HTMLCanvasElement | null,
): ShaderGLContext | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);

  const { prog, vs, fs } = compileProgram(gl, VERT, BLUR_FRAG);

  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const pos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const tex = uploadTexture(gl, gl.TEXTURE0, img);
  const tex2 = uploadTexture(gl, gl.TEXTURE1, img);

  // Optional "Stella is changing..." label, uploaded on TEXTURE2 when present.
  let labelTex: WebGLTexture | null = null;
  if (label) {
    labelTex = uploadTexture(gl, gl.TEXTURE2, label);
    gl.activeTexture(gl.TEXTURE0);
  }

  gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex2"), 1);
  gl.uniform1i(gl.getUniformLocation(prog, "u_label"), 2);
  gl.uniform1f(gl.getUniformLocation(prog, "u_has_label"), labelTex ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), 1.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_reveal"), 0.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), img.width / img.height);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    gl,
    prog,
    vs,
    fs,
    buf,
    tex,
    tex2,
    labelTex,
    strengthLoc: gl.getUniformLocation(prog, "u_strength"),
    timeLoc: gl.getUniformLocation(prog, "u_time"),
    alphaLoc: gl.getUniformLocation(prog, "u_alpha"),
    revealLoc: gl.getUniformLocation(prog, "u_reveal"),
  };
}

function loadSecondTexture(ctx: GLContext, img: ImageBitmap) {
  const { gl, tex2, prog } = ctx;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  if (img.width !== gl.canvas.width || img.height !== gl.canvas.height) {
    (gl.canvas as HTMLCanvasElement).width = img.width;
    (gl.canvas as HTMLCanvasElement).height = img.height;
    gl.viewport(0, 0, img.width, img.height);
    gl.uniform1f(
      gl.getUniformLocation(prog, "u_aspect"),
      img.width / img.height,
    );
  }
  gl.activeTexture(gl.TEXTURE0);
}

function cleanupGL(ctx: GLContext) {
  const { gl, buf, prog, vs, fs } = ctx;
  gl.deleteTexture(ctx.tex);
  gl.deleteTexture(ctx.tex2);
  if (ctx.labelTex) gl.deleteTexture(ctx.labelTex);
  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
}

function startCoverRenderLoop(
  ctx: ShaderGLContext,
  strengthRef: { current: number },
  alphaRef: { current: number },
  activeTweensRef: { current: number },
  steadyStrengthRef: { current: number },
  timePhaseRef: { current: number },
  revealRef: { current: number },
  startTime: number,
  onFirstFrame?: () => void,
): () => void {
  let running = true;
  let firstFramePainted = false;
  // When no tween is in flight the cover holds steady. The band's edge wave
  // still advances via `u_time`, but humans don't notice a 30Hz cap on it —
  // so we halve GPU load by skipping every other frame. Tweens (cover ramp,
  // handoff sweep) snap back to 60Hz because that's where motion smoothness
  // actually matters.
  let skipNextFrame = false;
  let lastTimestamp = startTime;
  const { gl, strengthLoc, timeLoc, alphaLoc, revealLoc } = ctx;

  const frame = (now: number) => {
    if (!running) return;

    const dtSeconds = Math.max(0, (now - lastTimestamp) / 1000);
    lastTimestamp = now;
    const steady = steadyStrengthRef.current;
    // The band's edge wave eases in/out with cover strength so it stays calm
    // while the frost is still building and decays as the cover lifts.
    const speedScale =
      steady > 0 ? Math.min(1, Math.max(0, strengthRef.current / steady)) : 0;
    timePhaseRef.current += dtSeconds * speedScale;

    // Nothing visible — no point spending GPU cycles. Still need to paint the
    // very first frame so `onFirstFrame` (= overlay:morphReady) fires.
    if (firstFramePainted && alphaRef.current < 0.005) {
      requestAnimationFrame(frame);
      return;
    }

    if (activeTweensRef.current === 0 && firstFramePainted) {
      if (skipNextFrame) {
        skipNextFrame = false;
        requestAnimationFrame(frame);
        return;
      }
      skipNextFrame = true;
    } else {
      skipNextFrame = false;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(strengthLoc, strengthRef.current);
    gl.uniform1f(timeLoc, timePhaseRef.current);
    gl.uniform1f(alphaLoc, alphaRef.current);
    gl.uniform1f(revealLoc, revealRef.current);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!firstFramePainted) {
      firstFramePainted = true;
      onFirstFrame?.();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return () => {
    running = false;
  };
}

type EaseFn = (t: number) => number;

// Symmetric cosine ease-in-out — the default for cover/crossfade tweens.
const easeInOutCosine: EaseFn = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

// Cubic ease-out — fast at the start, decelerating into the target. Used for
// the blur cover ramp so the frost rushes in then settles (clearly non-linear).
const easeOutCubic: EaseFn = (t) => 1 - Math.pow(1 - t, 3);

// CSS-style cubic-bezier(P1,P2) timing function, solved with Newton's method
// on x to recover the curve parameter (matches glimm's implementation).
const cubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EaseFn => {
  const bezX = (t: number) =>
    3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const bezY = (t: number) =>
    3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  const bezXd = (t: number) =>
    3 * (1 - 4 * t + 3 * t * t) * x1 + 3 * (2 * t - 3 * t * t) * x2 + 3 * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = bezX(t) - x;
      if (Math.abs(dx) < 1e-6) break;
      const d = bezXd(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return bezY(t);
  };
};

// glimm's "snap" sweep curve — cubic-bezier(1, 0, 0.35, 0.95): holds at the
// start, then whips forward.
const bandSweepEase: EaseFn = cubicBezier(1, 0, 0.35, 0.95);

function tweenRef(
  ref: { current: number },
  to: number,
  duration: number,
  activeTweensRef?: { current: number },
  ease: EaseFn = easeInOutCosine,
): Promise<void> {
  return new Promise((resolve) => {
    const from = ref.current;
    const start = performance.now();
    if (activeTweensRef) activeTweensRef.current += 1;
    const step = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      const eased = ease(t);
      ref.current = from + (to - from) * eased;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        if (activeTweensRef) activeTweensRef.current -= 1;
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

export function MorphTransition() {
  const { colors } = useTheme();
  const [state, setState] = useState<MorphState>(IDLE_STATE);
  const [hmrState, setHmrState] = useState<SelfModHmrState>(IDLE_HMR_STATE);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCtxRef = useRef<GLContext | null>(null);
  const activeTransitionIdRef = useRef<string | null>(null);
  const strengthRef = useRef(0);
  const alphaRef = useRef(1);
  const stopLoopRef = useRef<(() => void) | null>(null);
  const loopStartTimeRef = useRef(0);
  const morphReadySentRef = useRef(false);
  const activeMorphFlavorRef = useRef<MorphFlavor>("hmr");
  const activeVisualTimingRef = useRef<MorphVisualTiming>(
    DEFAULT_HMR_VISUAL_TIMING,
  );
  const activeTweensRef = useRef(0);
  const steadyStrengthRef = useRef(MORPH_STEADY_STRENGTH);
  const timePhaseRef = useRef(0);
  // Blur-only: 0 during cover, tweened 0→1 on handoff to drive the band sweep.
  const revealRef = useRef(0);
  // Label fill/font, refreshed with the theme and read at morph start.
  const labelStyleRef = useRef<{
    fill: string;
    font: string;
  }>({
    fill: colors.foreground,
    font: "'Cormorant Garamond', Georgia, serif",
  });
  useEffect(() => {
    labelStyleRef.current = {
      fill: colors.foreground,
      font: getDisplayFontFamily(),
    };
  }, [colors]);

  // Warm Cormorant once so the baked label never falls back to a generic serif
  // on the first morph.
  useEffect(() => {
    void document.fonts?.load("italic 400 80px 'Cormorant Garamond'");
  }, []);

  useEffect(() => {
    const api = window.electronAPI?.overlay;
    if (!api) return;

    if (
      typeof api.onMorphForward !== "function" ||
      typeof api.onMorphBounds !== "function" ||
      typeof api.onMorphHandoff !== "function" ||
      typeof api.onMorphEnd !== "function" ||
      typeof api.onMorphState !== "function"
    ) {
      return;
    }

    const disposeMorph = () => {
      stopLoopRef.current?.();
      stopLoopRef.current = null;
      if (glCtxRef.current) {
        cleanupGL(glCtxRef.current);
        glCtxRef.current = null;
      }
    };

    const signalMorphReady = (transitionId: string) => {
      if (
        morphReadySentRef.current ||
        activeTransitionIdRef.current !== transitionId
      ) {
        return;
      }
      morphReadySentRef.current = true;
      window.electronAPI?.overlay.morphReady(transitionId);
    };

    const unsubs: Array<() => void> = [];

    unsubs.push(
      api.onMorphForward((data) => {
        disposeMorph();
        activeTransitionIdRef.current = data.transitionId;
        morphReadySentRef.current = false;
        const flavor: MorphFlavor =
          data.flavor === "onboarding" ? "onboarding" : "hmr";
        activeMorphFlavorRef.current = flavor;
        activeVisualTimingRef.current = normalizeVisualTiming(data.timing);
        setHmrState(IDLE_HMR_STATE);
        setState({
          phase: "covering",
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
        });

        const steadyStrength =
          flavor === "onboarding"
            ? ONBOARDING_MORPH_STEADY_STRENGTH
            : MORPH_STEADY_STRENGTH;
        // Start from a clean still frame, then ease into cover strength (the
        // frost radius) so the cover reads as one S-curve: calm → active → calm.
        strengthRef.current = 0;
        alphaRef.current = 1;
        steadyStrengthRef.current = steadyStrength;
        timePhaseRef.current = 0;
        revealRef.current = 0;

        void loadImage(data.screenshotDataUrl).then((img) => {
          if (
            !canvasRef.current ||
            activeTransitionIdRef.current !== data.transitionId
          ) {
            return;
          }
          // The "Stella is changing..." label rides the production self-mod
          // cover; the onboarding demo morph stays unlabeled.
          const label =
            flavor === "hmr"
              ? createUpdatingLabelCanvas(
                  img.width,
                  img.height,
                  labelStyleRef.current.fill,
                  labelStyleRef.current.font,
                )
              : null;
          const ctx = initShaderGL(canvasRef.current, img, label);
          if (!ctx) return;
          glCtxRef.current = ctx;

          loopStartTimeRef.current = performance.now();
          activeTweensRef.current = 0;
          stopLoopRef.current = startCoverRenderLoop(
            ctx,
            strengthRef,
            alphaRef,
            activeTweensRef,
            steadyStrengthRef,
            timePhaseRef,
            revealRef,
            loopStartTimeRef.current,
            () => signalMorphReady(data.transitionId),
          );

          void tweenRef(
            strengthRef,
            steadyStrength,
            flavor === "onboarding"
              ? ONBOARDING_MORPH_COVER_RAMP_MS
              : activeVisualTimingRef.current.coverRampMs,
            activeTweensRef,
            // Frost rushes in then eases to steady (non-linear).
            easeOutCubic,
          );
        });
      }),
    );

    unsubs.push(
      api.onMorphBounds((data) => {
        if (data.transitionId !== activeTransitionIdRef.current) {
          return;
        }
        setState((prev) =>
          prev.phase === "idle"
            ? prev
            : {
                ...prev,
                x: data.x,
                y: data.y,
                width: data.width,
                height: data.height,
              },
        );
      }),
    );

    unsubs.push(
      api.onMorphHandoff((data) => {
        if (data.transitionId !== activeTransitionIdRef.current) {
          return;
        }
        const flavor: MorphFlavor =
          data.flavor === "onboarding"
            ? "onboarding"
            : data.flavor === "hmr"
              ? "hmr"
              : activeMorphFlavorRef.current;
        void loadImage(data.screenshotDataUrl)
          .then((img) => {
            if (data.transitionId !== activeTransitionIdRef.current) {
              return;
            }
            const ctx = glCtxRef.current;
            if (!ctx) {
              morphReadySentRef.current = false;
              window.electronAPI?.overlay.morphDone(data.transitionId);
              activeTransitionIdRef.current = null;
              setState(IDLE_STATE);
              return;
            }

            const handoffMs =
              flavor === "onboarding"
                ? ONBOARDING_MORPH_HANDOFF_FADE_MS
                : normalizeVisualTiming(data.timing).handoffFadeMs;
            loadSecondTexture(ctx, img);
            alphaRef.current = 1;
            setState((prev) => ({ ...prev, phase: "crossfading" }));

            const finalize = () => {
              if (data.transitionId !== activeTransitionIdRef.current) {
                return;
              }
              morphReadySentRef.current = false;
              window.electronAPI?.overlay.morphDone(data.transitionId);
              disposeMorph();
              activeTransitionIdRef.current = null;
              setState(IDLE_STATE);
            };

            // Reveal the new state behind a left→right band sweep (`u_reveal`
            // drives the band position; the band acts as a saturation lens).
            revealRef.current = 0;
            return tweenRef(
              revealRef,
              1.0,
              handoffMs,
              activeTweensRef,
              bandSweepEase,
            ).then(finalize);
          })
          .catch(() => {
            if (data.transitionId !== activeTransitionIdRef.current) {
              return;
            }
            morphReadySentRef.current = false;
            window.electronAPI?.overlay.morphDone(data.transitionId);
            disposeMorph();
            activeTransitionIdRef.current = null;
            setState(IDLE_STATE);
          });
      }),
    );

    unsubs.push(
      api.onMorphState((payload) => {
        if (payload.transitionId !== activeTransitionIdRef.current) {
          return;
        }
        setHmrState(payload.state);
      }),
    );

    unsubs.push(
      api.onMorphEnd((payload) => {
        if (payload.transitionId !== activeTransitionIdRef.current) {
          return;
        }
        morphReadySentRef.current = false;
        disposeMorph();
        activeTransitionIdRef.current = null;
        setHmrState(IDLE_HMR_STATE);
        setState(IDLE_STATE);
      }),
    );

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  if (state.phase === "idle") return null;

  return (
    <canvas
      ref={canvasRef}
      data-selfmod-hmr-phase={hmrState.phase}
      data-selfmod-full-reload={hmrState.requiresFullReload || undefined}
      style={{
        position: "fixed",
        left: state.x,
        top: state.y,
        width: state.width,
        height: state.height,
        zIndex: 99999,
        pointerEvents: "none",
      }}
    />
  );
}
