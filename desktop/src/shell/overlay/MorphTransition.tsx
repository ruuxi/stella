import { useEffect, useRef, useState } from "react";
import { cssToVec3 } from "@/shared/lib/color";
import type { SelfModHmrState } from "../../../packages/stella-boundary-contracts/src/index.js";

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

const COVER_RAMP_UP_MS = 220;
const HMR_CROSSFADE_MS = 260;
const HMR_CALM_DOWN_MS = 180;
const RELOAD_CROSSFADE_MS = 520;
const RELOAD_CALM_DOWN_MS = 280;
const STEADY_STRENGTH = 0.65;

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

  float rippleFreq = 6.0;
  float rippleAmp = u_strength * 0.012;
  float ripple = sin(dist * rippleFreq - u_time * 4.0) * rippleAmp;
  ripple *= smoothstep(0.0, 0.35, dist);
  ripple *= (1.0 - smoothstep(0.6, 1.0, dist));

  float warpAmp = u_strength * 0.02;
  float warp = sin(dist * 3.0 + u_time * 2.0) * warpAmp * smoothstep(0.0, 0.3, dist);

  vec2 offset = normalize(d + vec2(0.001)) * (ripple + warp);
  offset.x /= u_aspect;
  vec2 uv = v_uv + offset;

  float chromatic = u_strength * 0.003;
  vec2 chromDir = normalize(d + vec2(0.001));
  chromDir.x /= u_aspect;

  vec4 col1 = sampleWithChroma(u_tex, uv, chromDir, chromatic);
  vec4 col2 = sampleWithChroma(u_tex2, uv, chromDir, chromatic);
  vec4 col = mix(col1, col2, u_mix);

  // Chromatic aberration color appears only on stronger image edges.
  float dx = 0.002 * u_strength;
  float lumCenter = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  vec2 uvR = clamp(uv + vec2(dx, 0.0), 0.0, 1.0);
  float lumRight = dot(mix(texture2D(u_tex, uvR), texture2D(u_tex2, uvR), u_mix).rgb, vec3(0.299, 0.587, 0.114));
  vec2 uvU = clamp(uv + vec2(0.0, dx), 0.0, 1.0);
  float lumUp = dot(mix(texture2D(u_tex, uvU), texture2D(u_tex2, uvU), u_mix).rgb, vec3(0.299, 0.587, 0.114));
  float edge = length(vec2(lumRight - lumCenter, lumUp - lumCenter));

  float angle = atan(d.y, d.x);
  float colorPhase = fract(angle / 6.2832 + u_time * 0.3) * 4.0;

  vec3 tint = mix(u_color1, u_color2, smoothstep(0.0, 1.0, colorPhase));
  tint = mix(tint, u_color3, smoothstep(1.0, 2.0, colorPhase));
  tint = mix(tint, u_color4, smoothstep(2.0, 3.0, colorPhase));
  tint = mix(tint, u_color1, smoothstep(3.0, 4.0, colorPhase));

  float colorMask = smoothstep(0.02, 0.08, edge) * u_strength * 0.35;
  col.rgb = mix(col.rgb, tint, colorMask);

  gl_FragColor = col;
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
  startTime: number,
  onFirstFrame?: () => void,
): () => void {
  let running = true;
  let firstFramePainted = false;
  const { gl, strengthLoc, timeLoc, mixLoc } = ctx;

  const frame = (now: number) => {
    if (!running) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(strengthLoc, strengthRef.current);
    gl.uniform1f(timeLoc, (now - startTime) / 1000);
    gl.uniform1f(mixLoc, mixRef.current);
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
  const strengthRef = useRef(0);
  const mixRef = useRef(0);
  const stopLoopRef = useRef<(() => void) | null>(null);
  const loopStartTimeRef = useRef(0);
  const morphReadySentRef = useRef(false);

  useEffect(() => {
    const api = window.electronAPI?.overlay;
    if (!api) return;

    if (
      typeof api.onMorphForward !== "function" ||
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

    const signalMorphReady = () => {
      if (morphReadySentRef.current) return;
      morphReadySentRef.current = true;
      window.electronAPI?.overlay.morphReady();
    };

    const unsubs: Array<() => void> = [];

    unsubs.push(
      api.onMorphForward((data) => {
        disposeMorph();
        morphReadySentRef.current = false;
        strengthRef.current = 0;
        mixRef.current = 0;
        setState({
          phase: "rippling",
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
        });

        void loadImage(data.screenshotDataUrl).then((img) => {
          if (!canvasRef.current) return;
          const ctx = initGL(canvasRef.current, img);
          if (!ctx) return;
          glCtxRef.current = ctx;

          loopStartTimeRef.current = performance.now();
          stopLoopRef.current = startRenderLoop(
            ctx,
            strengthRef,
            mixRef,
            loopStartTimeRef.current,
            signalMorphReady,
          );

          // Reach a stable covered state quickly, then hold there until reveal.
          void tweenRef(strengthRef, STEADY_STRENGTH, COVER_RAMP_UP_MS);
        });
      }),
    );

    unsubs.push(
      api.onMorphReverse((data) => {
        const crossfadeMs = data.requiresFullReload
          ? RELOAD_CROSSFADE_MS
          : HMR_CROSSFADE_MS;
        const calmDownMs = data.requiresFullReload
          ? RELOAD_CALM_DOWN_MS
          : HMR_CALM_DOWN_MS;

        void loadImage(data.screenshotDataUrl)
          .then((img) => {
            const ctx = glCtxRef.current;
            if (!ctx) {
              window.electronAPI?.overlay.morphDone();
              return;
            }

            loadSecondTexture(ctx, img);
            setState((prev) => ({ ...prev, phase: "crossfading" }));

            return tweenRef(mixRef, 1.0, crossfadeMs)
              .then(() => {
                setState((prev) => ({ ...prev, phase: "calming" }));
                return tweenRef(strengthRef, 0, calmDownMs);
              })
              .then(() => {
                morphReadySentRef.current = false;
                window.electronAPI?.overlay.morphDone();
                disposeMorph();
                setState(IDLE_STATE);
              });
          })
          .catch(() => {
            morphReadySentRef.current = false;
            window.electronAPI?.overlay.morphDone();
            disposeMorph();
            setState(IDLE_STATE);
          });
      }),
    );

    unsubs.push(
      api.onMorphState((nextState) => {
        setHmrState(nextState);
      }),
    );

    unsubs.push(
      api.onMorphEnd(() => {
        morphReadySentRef.current = false;
        disposeMorph();
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
