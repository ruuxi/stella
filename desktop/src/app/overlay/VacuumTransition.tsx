import { useEffect, useRef, useState } from "react";
import { runVacuumEffect } from "./region-capture-vacuum";

type VacuumPhase = "idle" | "forward" | "hold" | "reverse";

type VacuumState = {
  phase: VacuumPhase;
  x: number;
  y: number;
  width: number;
  height: number;
  screenshotDataUrl: string;
};

const IDLE_STATE: VacuumState = {
  phase: "idle",
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  screenshotDataUrl: "",
};

/**
 * Runs the reverse vacuum effect: strength goes from 1 → 0.
 * Adapted from runVacuumEffect but plays in reverse.
 */
async function runReverseVacuumEffect(
  canvas: HTMLCanvasElement,
  thumbnailUrl: string,
  centerX: number,
  centerY: number,
  duration: number,
): Promise<void> {
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
uniform vec2 u_center;
uniform float u_strength;
uniform float u_aspect;
varying vec2 v_uv;

void main() {
  vec2 d = v_uv - u_center;
  d.x *= u_aspect;
  float dist = length(d);
  float n = dist / 2.0;
  float nc = clamp(n, 0.0, 1.0);

  float angle = u_strength * 0.8 * (1.0 - nc);
  float sn = sin(angle);
  float cs = cos(angle);
  d = vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);

  float exp = 1.0 / (1.0 + u_strength * 4.0);
  d *= min(pow(max(n, 0.001), exp - 1.0), 20.0);
  d.x /= u_aspect;

  vec2 uv = u_center + d;
  float inB = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 col = texture2D(u_tex, clamp(uv, 0.0, 1.0));
  col *= inB;

  float fadeR = max(1.0 - u_strength * u_strength * 3.0, 0.02);
  col.a *= 1.0 - smoothstep(fadeR * 0.5, fadeR, nc);

  col.rgb *= max(1.0 - u_strength * u_strength * (1.0 - nc), 0.0);

  gl_FragColor = col;
}`;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = thumbnailUrl;
  });

  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) return;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);

  const createShader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };

  const vs = createShader(gl.VERTEX_SHADER, VERT);
  const fs = createShader(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.uniform2f(gl.getUniformLocation(prog, "u_center"), centerX, centerY);
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), img.width / img.height);
  const strengthLoc = gl.getUniformLocation(prog, "u_strength");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return new Promise<void>((resolve) => {
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // Ease-out cubic: 1 → 0
      const eased = 1 - (1 - (1 - t)) * (1 - (1 - t)) * (1 - (1 - t));
      const strength = 1 - eased;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(strengthLoc, strength);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        gl.deleteTexture(tex);
        gl.deleteBuffer(buf);
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

export function VacuumTransition() {
  const [state, setState] = useState<VacuumState>(IDLE_STATE);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reverseDataUrlRef = useRef<string>("");

  useEffect(() => {
    const api = window.electronAPI?.overlay;
    if (!api) return;

    // Guard against older Electron builds or non-Electron contexts where
    // vacuum IPC handlers may not be present, preventing a TypeError crash.
    if (
      typeof api.onVacuumForward !== "function" ||
      typeof api.onVacuumReverse !== "function" ||
      typeof api.onVacuumEnd !== "function"
    ) {
      return;
    }

    const unsubs: Array<() => void> = [];

    unsubs.push(
      api.onVacuumForward((data) => {
        setState({
          phase: "forward",
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
          screenshotDataUrl: data.screenshotDataUrl,
        });
      }),
    );

    unsubs.push(
      api.onVacuumReverse((data) => {
        reverseDataUrlRef.current = data.screenshotDataUrl;
        setState((prev) => ({ ...prev, phase: "reverse" }));
      }),
    );

    unsubs.push(
      api.onVacuumEnd(() => {
        setState(IDLE_STATE);
      }),
    );

    return () => unsubs.forEach((u) => u());
  }, []);

  // Run forward vacuum
  useEffect(() => {
    if (state.phase !== "forward" || !canvasRef.current) return;

    const canvas = canvasRef.current;
    void runVacuumEffect(canvas, state.screenshotDataUrl, 0.5, 0.5).then(() => {
      setState((prev) =>
        prev.phase === "forward" ? { ...prev, phase: "hold" } : prev,
      );
    });
  }, [state.phase, state.screenshotDataUrl]);

  // Run reverse vacuum
  useEffect(() => {
    if (state.phase !== "reverse" || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const dataUrl = reverseDataUrlRef.current;

    void runReverseVacuumEffect(canvas, dataUrl, 0.5, 0.5, 700).then(() => {
      window.electronAPI?.overlay.vacuumDone();
      setState(IDLE_STATE);
    });
  }, [state.phase]);

  if (state.phase === "idle") return null;

  return (
    <canvas
      ref={canvasRef}
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
