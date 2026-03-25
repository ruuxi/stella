import { useEffect, useRef, useState } from "react";
import { cssToVec3 } from "@/shared/lib/color";
import type { SelfModHmrState } from "../../shared/contracts/boundary";
import {
  MORPH_COVER_RAMP_UP_MS,
  MORPH_REVERSE_CROSSFADE_MS,
  MORPH_STEADY_STRENGTH,
} from "../../shared/contracts/morph-timing";

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
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;
uniform vec3 u_color4;
varying vec2 v_uv;

vec4 sampleWithChroma(sampler2D tex, vec2 uv, vec2 chromDir, float chromatic) {
  float r = texture2D(tex, clamp(uv + chromDir * chromatic, 0.0, 1.0)).r;
  float g = texture2D(tex, clamp(uv, 0.0, 1.0)).g;
  float b = texture2D(tex, clamp(uv - chromDir * chromatic, 0.0, 1.0)).b;
  float a = texture2D(tex, clamp(uv, 0.0, 1.0)).a;
  return vec4(r, g, b, a);
}

void main() {
  vec2 d = v_uv - u_center;
  d.x *= u_aspect;
  float dist = length(d);

  // Clean ripple expanding outward from center
  float wave = sin(dist * 2.5 - u_time * 2.5);
  float ripple = wave * u_strength * 0.008;
  ripple *= exp(-dist * 1.8);
  ripple *= smoothstep(0.0, 0.12, dist);

  vec2 offset = normalize(d + vec2(0.001)) * ripple;
  offset.x /= u_aspect;
  vec2 uv = v_uv + offset;

  // Subtle chromatic aberration — light refraction
  float chromatic = u_strength * 0.0015;
  vec2 chromDir = normalize(d + vec2(0.001));
  chromDir.x /= u_aspect;

  vec4 col1 = sampleWithChroma(u_tex, uv, chromDir, chromatic);
  vec4 col2 = sampleWithChroma(u_tex2, uv, chromDir, chromatic);
  vec4 col = mix(col1, col2, u_mix);

  // Caustic brightness — light focusing through water
  float caustic = 1.0 + cos(dist * 2.5 - u_time * 2.5) * u_strength * 0.035 * exp(-dist * 1.8);
  col.rgb *= caustic;

  gl_FragColor = vec4(col.rgb, col.a * u_alpha);
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

function resolveThemeColor(
  varName: string,
  fallback: string,
): [number, number, number] {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return cssToVec3(raw || fallback);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function initGL(canvas: HTMLCanvasElement, img: HTMLImageElement): GLContext | null {
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

  const color1 = resolveThemeColor("--spinner-color-1", "#7aa2f7");
  const color2 = resolveThemeColor("--spinner-color-2", "#bb9af7");
  const color3 = resolveThemeColor("--spinner-color-3", "#7dcfff");
  const color4 = resolveThemeColor("--spinner-color-4", "#9ece6a");
  gl.uniform3f(
    gl.getUniformLocation(prog, "u_color1"),
    color1[0],
    color1[1],
    color1[2],
  );
  gl.uniform3f(
    gl.getUniformLocation(prog, "u_color2"),
    color2[0],
    color2[1],
    color2[2],
  );
  gl.uniform3f(
    gl.getUniformLocation(prog, "u_color3"),
    color3[0],
    color3[1],
    color3[2],
  );
  gl.uniform3f(
    gl.getUniformLocation(prog, "u_color4"),
    color4[0],
    color4[1],
    color4[2],
  );

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

function loadSecondTexture(ctx: GLContext, img: HTMLImageElement) {
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
  startTime: number,
  onFirstFrame?: () => void,
): () => void {
  let running = true;
  let firstFramePainted = false;
  const { gl, strengthLoc, timeLoc, mixLoc, alphaLoc } = ctx;

  const frame = (now: number) => {
    if (!running) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(strengthLoc, strengthRef.current);
    gl.uniform1f(timeLoc, (now - startTime) / 1000);
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
): Promise<void> {
  return new Promise((resolve) => {
    const from = ref.current;
    const start = performance.now();
    const step = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
      ref.current = from + (to - from) * eased;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
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
        strengthRef.current = 0;
        mixRef.current = 0;
        alphaRef.current = 1;
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
          stopLoopRef.current = startRenderLoop(
            ctx,
            strengthRef,
            mixRef,
            alphaRef,
            loopStartTimeRef.current,
            () => signalMorphReady(data.transitionId),
          );

          // Reach a stable covered state quickly, then hold there until reveal.
          void tweenRef(strengthRef, MORPH_STEADY_STRENGTH, MORPH_COVER_RAMP_UP_MS);
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
              tweenRef(mixRef, 1.0, MORPH_REVERSE_CROSSFADE_MS),
              tweenRef(strengthRef, 0, MORPH_REVERSE_CROSSFADE_MS),
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
