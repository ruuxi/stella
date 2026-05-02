import { useEffect, useRef, useState } from "react";
import type { SelfModHmrState } from "../../shared/contracts/boundary";
import {
  MORPH_FORWARD_RAMP_MS,
  MORPH_REVERSE_CROSSFADE_MS,
  MORPH_STEADY_STRENGTH,
} from "../../shared/contracts/morph-timing";

/** Onboarding demo morph — stronger distortion + slower timing (see `flavor` IPC). */
const ONBOARDING_MORPH_STEADY_STRENGTH = 0.65;
const ONBOARDING_MORPH_COVER_RAMP_MS = 600;
const ONBOARDING_MORPH_REVERSE_MS = 800;

type MorphFlavor = "hmr" | "onboarding";

type MorphPhase = "idle" | "rippling" | "crossfading" | "calming";

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

type GLContext = {
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

function initGL(canvas: HTMLCanvasElement, img: ImageBitmap): GLContext | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);

  const createShader = (type: number, src: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  };

  const vs = createShader(gl.VERTEX_SHADER, VERT);
  const fs = createShader(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

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

  const setupTexture = (unit: number) => {
    const texture = gl.createTexture()!;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  };

  const tex = setupTexture(gl.TEXTURE0);
  const tex2 = setupTexture(gl.TEXTURE1);

  gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex2"), 1);
  gl.uniform1f(gl.getUniformLocation(prog, "u_mix"), 0.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), 1.0);
  gl.uniform2f(gl.getUniformLocation(prog, "u_center"), 0.5, 0.5);
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
    strengthLoc: gl.getUniformLocation(prog, "u_strength"),
    timeLoc: gl.getUniformLocation(prog, "u_time"),
    mixLoc: gl.getUniformLocation(prog, "u_mix"),
    alphaLoc: gl.getUniformLocation(prog, "u_alpha"),
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
    gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), img.width / img.height);
  }
  gl.activeTexture(gl.TEXTURE0);
}

function cleanupGL(ctx: GLContext) {
  const { gl, tex, tex2, buf, prog, vs, fs } = ctx;
  gl.deleteTexture(tex);
  gl.deleteTexture(tex2);
  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
}

function startRenderLoop(
  ctx: GLContext,
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
  // other frame. Tweens (forward ramp, reverse crossfade) snap back to 60Hz
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
  const activeTweensRef = useRef(0);
  const steadyStrengthRef = useRef(MORPH_STEADY_STRENGTH);
  const timePhaseRef = useRef(0);

  useEffect(() => {
    const api = window.electronAPI?.overlay;
    if (!api) return;

    if (
      typeof api.onMorphForward !== "function" ||
      typeof api.onMorphBounds !== "function" ||
      typeof api.onMorphReverse !== "function" ||
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
        setHmrState(IDLE_HMR_STATE);
        setState({
          phase: "rippling",
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
        });

        void loadImage(data.screenshotDataUrl).then((img) => {
          if (
            !canvasRef.current ||
            activeTransitionIdRef.current !== data.transitionId
          ) {
            return;
          }
          const ctx = initGL(canvasRef.current, img);
          if (!ctx) return;
          glCtxRef.current = ctx;

          loopStartTimeRef.current = performance.now();
          activeTweensRef.current = 0;
          stopLoopRef.current = startRenderLoop(
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
              : MORPH_FORWARD_RAMP_MS,
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
      api.onMorphReverse((data) => {
        if (data.transitionId !== activeTransitionIdRef.current) {
          return;
        }
        const flavor: MorphFlavor =
          data.flavor === "onboarding"
            ? "onboarding"
            : data.flavor === "hmr"
              ? "hmr"
              : activeMorphFlavorRef.current;
        const reverseMs =
          flavor === "onboarding"
            ? ONBOARDING_MORPH_REVERSE_MS
            : MORPH_REVERSE_CROSSFADE_MS;
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

            loadSecondTexture(ctx, img);
            alphaRef.current = 1;
            setState((prev) => ({ ...prev, phase: "crossfading" }));

            return Promise.all([
              tweenRef(mixRef, 1.0, reverseMs, activeTweensRef),
              tweenRef(strengthRef, 0, reverseMs, activeTweensRef),
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
