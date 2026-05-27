import { useEffect, useRef, useState } from "react";
import type { SelfModHmrState } from "../../../../runtime/contracts/index.js";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  MORPH_STEADY_STRENGTH,
  type MorphVisualTiming,
} from "../../shared/contracts/morph-timing";

/** Onboarding demo morph — stronger distortion + slower timing (see `flavor` IPC). */
const ONBOARDING_MORPH_STEADY_STRENGTH = 0.65;
const ONBOARDING_MORPH_COVER_RAMP_MS = 600;
const ONBOARDING_MORPH_HANDOFF_FADE_MS = 800;

/**
 * Glimm sweep timings — a colored gradient band passes across the screen as
 * the cover, then the second capture is revealed underneath when the band
 * continues after HMR/reload work finishes.
 */
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
  glimmCoverSweepMs: coerceTimingMs(
    timing?.glimmCoverSweepMs,
    DEFAULT_HMR_VISUAL_TIMING.glimmCoverSweepMs,
  ),
  glimmRevealSweepMs: coerceTimingMs(
    timing?.glimmRevealSweepMs,
    DEFAULT_HMR_VISUAL_TIMING.glimmRevealSweepMs,
  ),
  glimmOutroFadeMs: coerceTimingMs(
    timing?.glimmOutroFadeMs,
    DEFAULT_HMR_VISUAL_TIMING.glimmOutroFadeMs,
  ),
});

type MorphFlavor = "hmr" | "onboarding" | "glimm";

type MorphPhase = "idle" | "rippling" | "crossfading";

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

const FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_tex2;
uniform float u_mix;
uniform float u_strength;
uniform float u_alpha;
uniform float u_time;
uniform float u_aspect;
uniform vec2 u_center;
varying vec2 v_uv;

void main() {
  vec2 d = v_uv - u_center;
  d.x *= u_aspect;
  float dist = length(d);

  // Concentric rings expanding outward from center. The temporal coefficient
  // (u_time * N) controls ring expansion speed: higher = faster rings, more
  // motion per unit time. Tuned for ~300ms holds — at this speed a ring
  // takes ~2s to traverse the screen, so during a brief HMR cover the user
  // perceives a single deliberate ring rather than a blur of fast ones.
  float phase = dist * 28.0 - u_time * 2.5;
  float ripple = sin(phase);

  // Soft second harmonic for texture — same speed so rings stay concentric
  ripple += sin(phase * 2.0 + 0.5) * 0.3;

  // Damping: rings lose energy as they travel outward
  float damping = exp(-dist * 4.0);
  float envelope = smoothstep(0.0, 0.06, dist) * (1.0 - smoothstep(0.7, 1.0, dist));
  ripple *= envelope * damping;

  // Wave slope drives chromatic split direction
  float dRipple = cos(phase) * 28.0 + cos(phase * 2.0 + 0.5) * 0.3 * 56.0;
  dRipple *= envelope;

  // Gentle UV displacement
  float displaceAmp = u_strength * 0.002;
  vec2 radial = d / (dist + 0.0001);
  radial.x /= u_aspect;
  vec2 uv = v_uv + radial * ripple * displaceAmp;

  // Chromatic aberration — 3-way split along radial direction
  float chromAmt = u_strength * 0.011;
  float slopeNorm = sign(dRipple) * min(abs(dRipple) / 30.0, 1.0);
  float chromBase = chromAmt * (0.5 + 0.5 * abs(slopeNorm));

  vec2 rOff = radial * chromBase;
  vec2 bOff = radial * -chromBase;
  vec2 gOff = radial * chromBase * 0.3 * slopeNorm;

  float r1 = texture2D(u_tex,  clamp(uv + rOff, 0.0, 1.0)).r;
  float g1 = texture2D(u_tex,  clamp(uv + gOff, 0.0, 1.0)).g;
  float b1 = texture2D(u_tex,  clamp(uv + bOff, 0.0, 1.0)).b;

  float r2 = texture2D(u_tex2, clamp(uv + rOff, 0.0, 1.0)).r;
  float g2 = texture2D(u_tex2, clamp(uv + gOff, 0.0, 1.0)).g;
  float b2 = texture2D(u_tex2, clamp(uv + bOff, 0.0, 1.0)).b;

  vec3 col = mix(vec3(r1, g1, b1), vec3(r2, g2, b2), u_mix);

  gl_FragColor = vec4(col, u_alpha);
}`;

type RippleGLContext = {
  kind: "ripple";
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  buf: WebGLBuffer;
  tex: WebGLTexture;
  tex2: WebGLTexture;
  strengthLoc: WebGLUniformLocation | null;
  timeLoc: WebGLUniformLocation | null;
  mixLoc: WebGLUniformLocation | null;
  alphaLoc: WebGLUniformLocation | null;
};

type GlimmGLContext = {
  kind: "glimm";
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  buf: WebGLBuffer;
  texOld: WebGLTexture;
  texNew: WebGLTexture;
  progressLoc: WebGLUniformLocation | null;
  bandTightLoc: WebGLUniformLocation | null;
  alphaLoc: WebGLUniformLocation | null;
  swapLoc: WebGLUniformLocation | null;
};

type GLContext = RippleGLContext | GlimmGLContext;

/**
 * Glimm-style sweep shader. A soft Gaussian band of cosine-palette color
 * (the `prism` palette from glimm.dev) sweeps along an axis; on each side of
 * the band the screen samples a different texture — the old screenshot until
 * the band passes, then the new screenshot after. `u_swap` toggles which
 * texture is on which side so the cover sweep can stay covered with the old
 * screen and the reveal sweep can show the new screen behind the band.
 */
const GLIMM_FRAG = `
precision highp float;
uniform sampler2D u_tex_old;
uniform sampler2D u_tex_new;
uniform float u_alpha;
uniform float u_progress;
uniform float u_band_tight;
uniform float u_swap;
varying vec2 v_uv;

vec3 cosinePalette(float t) {
  // prism preset from glimm — a warm-to-cool spectrum sweep
  vec3 a = vec3(0.50, 0.50, 0.50);
  vec3 b = vec3(0.50, 0.50, 0.50);
  vec3 c = vec3(1.00, 1.00, 1.00);
  vec3 d = vec3(0.00, 0.33, 0.67);
  return clamp(a + b * cos(6.28318 * (c * t + d)), 0.0, 1.0);
}

void main() {
  // Sweep axis is left-to-right; v_uv.x runs 0 (left) → 1 (right).
  float axis = v_uv.x;

  // Texture choice: pre-sweep (axis < progress) is the "revealed" side;
  // post-sweep (axis > progress) is the "covered" side. Which screenshot
  // sits on each side depends on phase (cover vs handoff) via u_swap.
  vec3 colA = texture2D(u_tex_old, v_uv).rgb;
  vec3 colB = texture2D(u_tex_new, v_uv).rgb;
  float side = smoothstep(u_progress - 0.004, u_progress + 0.004, axis);
  // side ≈ 0 left of band, ≈ 1 right of band.
  vec3 base = mix(colA, colB, side);
  if (u_swap > 0.5) {
    base = mix(colB, colA, side);
  }

  // Gaussian band intensity centered on u_progress.
  float d = axis - u_progress;
  float intensity = exp(-u_band_tight * d * d);

  vec3 bandColor = cosinePalette(axis);

  vec3 col = mix(base, bandColor, intensity);
  gl_FragColor = vec4(col, u_alpha);
}`;

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

function uploadTexture(
  gl: WebGLRenderingContext,
  unit: number,
  img: ImageBitmap,
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

function initRippleGL(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
): RippleGLContext | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);

  const { prog, vs, fs } = compileProgram(gl, VERT, FRAG);

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

  gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex2"), 1);
  gl.uniform1f(gl.getUniformLocation(prog, "u_mix"), 0.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), 1.0);
  gl.uniform2f(gl.getUniformLocation(prog, "u_center"), 0.5, 0.5);
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), img.width / img.height);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    kind: "ripple",
    gl,
    prog,
    vs,
    fs,
    buf,
    tex,
    tex2,
    strengthLoc: gl.getUniformLocation(prog, "u_strength"),
    timeLoc: gl.getUniformLocation(prog, "u_time"),
    mixLoc: gl.getUniformLocation(prog, "u_mix"),
    alphaLoc: gl.getUniformLocation(prog, "u_alpha"),
  };
}

function initGlimmGL(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
): GlimmGLContext | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);

  const { prog, vs, fs } = compileProgram(gl, VERT, GLIMM_FRAG);

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

  // tex0 = old screenshot, tex1 = new screenshot (initially seeded with old).
  const texOld = uploadTexture(gl, gl.TEXTURE0, img);
  const texNew = uploadTexture(gl, gl.TEXTURE1, img);

  gl.uniform1i(gl.getUniformLocation(prog, "u_tex_old"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex_new"), 1);
  gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), 1.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_progress"), -0.2);
  gl.uniform1f(gl.getUniformLocation(prog, "u_band_tight"), 14.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_swap"), 0.0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    kind: "glimm",
    gl,
    prog,
    vs,
    fs,
    buf,
    texOld,
    texNew,
    progressLoc: gl.getUniformLocation(prog, "u_progress"),
    bandTightLoc: gl.getUniformLocation(prog, "u_band_tight"),
    alphaLoc: gl.getUniformLocation(prog, "u_alpha"),
    swapLoc: gl.getUniformLocation(prog, "u_swap"),
  };
}

function loadSecondTexture(ctx: GLContext, img: ImageBitmap) {
  if (ctx.kind === "ripple") {
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
    return;
  }
  const { gl, texNew } = ctx;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texNew);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  if (img.width !== gl.canvas.width || img.height !== gl.canvas.height) {
    (gl.canvas as HTMLCanvasElement).width = img.width;
    (gl.canvas as HTMLCanvasElement).height = img.height;
    gl.viewport(0, 0, img.width, img.height);
  }
  gl.activeTexture(gl.TEXTURE0);
}

function cleanupGL(ctx: GLContext) {
  const { gl, buf, prog, vs, fs } = ctx;
  if (ctx.kind === "ripple") {
    gl.deleteTexture(ctx.tex);
    gl.deleteTexture(ctx.tex2);
  } else {
    gl.deleteTexture(ctx.texOld);
    gl.deleteTexture(ctx.texNew);
  }
  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
}

function startRippleRenderLoop(
  ctx: RippleGLContext,
  strengthRef: { current: number },
  mixRef: { current: number },
  alphaRef: { current: number },
  activeTweensRef: { current: number },
  steadyStrengthRef: { current: number },
  timePhaseRef: { current: number },
  startTime: number,
  onFirstFrame?: () => void,
): () => void {
  let running = true;
  let firstFramePainted = false;
  // When no tween is in flight the visual is the steady ripple cover. The
  // ripple still advances via `u_time`, but humans don't notice a 30Hz cap on
  // continuous concentric rings — so we halve GPU load by skipping every
  // other frame. Tweens (cover ramp, handoff fade) snap back to 60Hz
  // because that's where motion smoothness actually matters.
  let skipNextFrame = false;
  let lastTimestamp = startTime;
  const { gl, strengthLoc, timeLoc, mixLoc, alphaLoc } = ctx;

  const frame = (now: number) => {
    if (!running) return;

    const dtSeconds = Math.max(0, (now - lastTimestamp) / 1000);
    lastTimestamp = now;
    // Ripple motion accelerates with strength on the way in and decelerates
    // back to zero on the way out, so rings ease into existence and slow to
    // a stop instead of popping in/out at constant cruise speed. We integrate
    // dt scaled by `strength / steadyStrength` (clamped to 1) so the phase
    // clock follows whatever envelope the strength tween produces.
    const steady = steadyStrengthRef.current;
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
    gl.uniform1f(mixLoc, mixRef.current);
    gl.uniform1f(alphaLoc, alphaRef.current);
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

function startGlimmRenderLoop(
  ctx: GlimmGLContext,
  progressRef: { current: number },
  bandTightRef: { current: number },
  alphaRef: { current: number },
  swapRef: { current: number },
  onFirstFrame?: () => void,
): () => void {
  let running = true;
  let firstFramePainted = false;
  const { gl, progressLoc, bandTightLoc, alphaLoc, swapLoc } = ctx;

  const frame = () => {
    if (!running) return;

    // Once the band is fully off-screen and faded out, nothing meaningful
    // is rendered — skip GPU work but keep the loop alive in case the
    // handoff phase wires up more tweens.
    if (firstFramePainted && alphaRef.current < 0.005) {
      requestAnimationFrame(frame);
      return;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(progressLoc, progressRef.current);
    gl.uniform1f(bandTightLoc, bandTightRef.current);
    gl.uniform1f(alphaLoc, alphaRef.current);
    gl.uniform1f(swapLoc, swapRef.current);
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

function tweenRef(
  ref: { current: number },
  to: number,
  duration: number,
  activeTweensRef?: { current: number },
): Promise<void> {
  return new Promise((resolve) => {
    const from = ref.current;
    const start = performance.now();
    if (activeTweensRef) activeTweensRef.current += 1;
    const step = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
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
  const [state, setState] = useState<MorphState>(IDLE_STATE);
  const [hmrState, setHmrState] = useState<SelfModHmrState>(IDLE_HMR_STATE);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCtxRef = useRef<GLContext | null>(null);
  const activeTransitionIdRef = useRef<string | null>(null);
  const strengthRef = useRef(0);
  const mixRef = useRef(0);
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
  // Glimm-only animation state. `swap=0` keeps the old screenshot on the
  // post-band side during cover; `swap=1` flips so the new screenshot sits
  // there once the handoff swaps textures.
  const glimmProgressRef = useRef(-0.2);
  const glimmBandTightRef = useRef(14);
  const glimmSwapRef = useRef(0);

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
          data.flavor === "onboarding"
            ? "onboarding"
            : data.flavor === "glimm"
              ? "glimm"
              : "hmr";
        activeMorphFlavorRef.current = flavor;
        activeVisualTimingRef.current = normalizeVisualTiming(data.timing);
        setHmrState(IDLE_HMR_STATE);
        setState({
          phase: "rippling",
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
        });

        if (flavor === "glimm") {
          alphaRef.current = 1;
          glimmProgressRef.current = -0.2;
          // Wide-ish band on the cover sweep so the underlying texture
          // gets visually disrupted as the band crosses, even before handoff
          // swaps the second texture in.
          glimmBandTightRef.current = 18;
          glimmSwapRef.current = 0;
          void loadImage(data.screenshotDataUrl).then((img) => {
            if (
              !canvasRef.current ||
              activeTransitionIdRef.current !== data.transitionId
            ) {
              return;
            }
            const ctx = initGlimmGL(canvasRef.current, img);
            if (!ctx) return;
            glCtxRef.current = ctx;
            stopLoopRef.current = startGlimmRenderLoop(
              ctx,
              glimmProgressRef,
              glimmBandTightRef,
              alphaRef,
              glimmSwapRef,
              () => signalMorphReady(data.transitionId),
            );
            // Sweep the band from off-screen-left to the midpoint and park
            // there until the second capture arrives — the wait is the
            // HMR/reload/restart work happening behind the cover.
            void tweenRef(
              glimmProgressRef,
              0.5,
              activeVisualTimingRef.current.glimmCoverSweepMs,
            );
          });
          return;
        }

        const steadyStrength =
          flavor === "onboarding"
            ? ONBOARDING_MORPH_STEADY_STRENGTH
            : MORPH_STEADY_STRENGTH;
        // Both HMR and onboarding start from a clean still frame, then ease
        // into ripple strength. HMR uses a shorter ramp so the whole cover
        // reads as one S-curve: calm → active → calm.
        strengthRef.current = 0;
        mixRef.current = 0;
        alphaRef.current = 1;
        steadyStrengthRef.current = steadyStrength;
        timePhaseRef.current = 0;

        void loadImage(data.screenshotDataUrl).then((img) => {
          if (
            !canvasRef.current ||
            activeTransitionIdRef.current !== data.transitionId
          ) {
            return;
          }
          const ctx = initRippleGL(canvasRef.current, img);
          if (!ctx) return;
          glCtxRef.current = ctx;

          loopStartTimeRef.current = performance.now();
          activeTweensRef.current = 0;
          stopLoopRef.current = startRippleRenderLoop(
            ctx,
            strengthRef,
            mixRef,
            alphaRef,
            activeTweensRef,
            steadyStrengthRef,
            timePhaseRef,
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
            : data.flavor === "glimm"
              ? "glimm"
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

            if (ctx.kind === "glimm") {
              loadSecondTexture(ctx, img);
              // The band has been parked at 0.5 covering the old content.
              // Swap so the new screenshot now sits on the *post-band* side,
              // then sweep the band through to 1.0 to reveal the new view.
              glimmSwapRef.current = 1;
              setState((prev) => ({ ...prev, phase: "crossfading" }));
              return tweenRef(
                glimmProgressRef,
                1.2,
                normalizeVisualTiming(data.timing).glimmRevealSweepMs,
              )
                .then(() =>
                  tweenRef(
                    alphaRef,
                    0,
                    normalizeVisualTiming(data.timing).glimmOutroFadeMs,
                  ),
                )
                .then(() => {
                  if (data.transitionId !== activeTransitionIdRef.current) {
                    return;
                  }
                  morphReadySentRef.current = false;
                  window.electronAPI?.overlay.morphDone(data.transitionId);
                  disposeMorph();
                  activeTransitionIdRef.current = null;
                  setState(IDLE_STATE);
                });
            }

            const handoffMs =
              flavor === "onboarding"
                ? ONBOARDING_MORPH_HANDOFF_FADE_MS
                : normalizeVisualTiming(data.timing).handoffFadeMs;
            loadSecondTexture(ctx, img);
            alphaRef.current = 1;
            setState((prev) => ({ ...prev, phase: "crossfading" }));

            return Promise.all([
              tweenRef(mixRef, 1.0, handoffMs, activeTweensRef),
              tweenRef(strengthRef, 0, handoffMs, activeTweensRef),
            ])
              .then(() => {
                if (data.transitionId !== activeTransitionIdRef.current) {
                  return;
                }
                morphReadySentRef.current = false;
                window.electronAPI?.overlay.morphDone(data.transitionId);
                disposeMorph();
                activeTransitionIdRef.current = null;
                setState(IDLE_STATE);
              });
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
