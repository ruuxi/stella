import React, { useEffect, useRef } from "react";
import "./AsciiBlackHole.css";

const CHARS = " .:-=+*#%@"; // Ordered by apparent brightness
const ASPECT = 0.55;

interface AsciiBlackHoleProps {
  width?: number;
  height?: number;
}

const parseColor = (value: string): [number, number, number] => {
  const match = value
    .trim()
    .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
  if (!match) return [1, 1, 1];
  return [
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
  ];
};

const getCssNumber = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const buildGlyphAtlas = (
  fontFamily: string,
  fontSize: number,
  glyphWidth: number,
  glyphHeight: number
) => {
  const canvas = document.createElement("canvas");
  canvas.width = glyphWidth * CHARS.length;
  canvas.height = glyphHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.imageSmoothingEnabled = false;
  ctx.font = `${fontSize}px ${fontFamily}`;

  for (let i = 0; i < CHARS.length; i++) {
    ctx.fillText(CHARS[i], i * glyphWidth, 0);
  }

  return canvas;
};

const compileShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string
) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

const createProgram = (gl: WebGLRenderingContext, vs: string, fs: string) => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vs);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  if (!vertexShader || !fragmentShader) return null;

  const program = gl.createProgram();
  if (!program) return null;

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  return program;
};

export const AsciiBlackHole: React.FC<AsciiBlackHoleProps> = ({
  width = 80,
  height = 40,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
  const darkRef = useRef<HTMLSpanElement>(null);
  const mediumDarkRef = useRef<HTMLSpanElement>(null);
  const mediumRef = useRef<HTMLSpanElement>(null);
  const brightRef = useRef<HTMLSpanElement>(null);
  const brightestRef = useRef<HTMLSpanElement>(null);
  const glowColorRef = useRef<HTMLSpanElement>(null);
  const requestRef = useRef<number | undefined>(undefined);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const glowCanvas = glowCanvasRef.current;
    if (!container || !canvas || !glowCanvas) return;

    const styles = getComputedStyle(container);
    const fontSize = getCssNumber(
      styles.getPropertyValue("--ascii-font-size"),
      11
    );
    const lineHeight = getCssNumber(
      styles.getPropertyValue("--ascii-line-height"),
      fontSize
    );
    const fontFamily =
      styles.getPropertyValue("--ascii-font-family").trim() ||
      '"SF Mono", "Menlo", "Monaco", "Courier New", monospace';

    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) return;
    measureCtx.font = `${fontSize}px ${fontFamily}`;
    const metrics = measureCtx.measureText("M");
    const glyphWidth = Math.max(1, Math.ceil(metrics.width));
    const glyphHeight = Math.max(1, Math.ceil(lineHeight));

    const cssWidth = Math.max(1, Math.floor(width * glyphWidth));
    const cssHeight = Math.max(1, Math.floor(height * glyphHeight));
    const dpr = window.devicePixelRatio || 1;

    const applyCanvasSize = (target: HTMLCanvasElement) => {
      target.style.width = `${cssWidth}px`;
      target.style.height = `${cssHeight}px`;
      target.width = Math.floor(cssWidth * dpr);
      target.height = Math.floor(cssHeight * dpr);
    };

    applyCanvasSize(canvas);
    applyCanvasSize(glowCanvas);

    const glyphAtlas = buildGlyphAtlas(
      fontFamily,
      fontSize,
      glyphWidth,
      glyphHeight
    );
    if (!glyphAtlas) return;

    const vertexSource = `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;

      uniform vec2 u_canvasSize;
      uniform vec2 u_gridSize;
      uniform float u_time;
      uniform float u_aspect;
      uniform float u_charCount;
      uniform sampler2D u_glyph;
      uniform vec3 u_colors[5];

      void main() {
        vec2 uv = vec2(
          gl_FragCoord.x / u_canvasSize.x,
          1.0 - gl_FragCoord.y / u_canvasSize.y
        );

        vec2 cell = floor(uv * u_gridSize);
        float cx = u_gridSize.x * 0.5;
        float cy = u_gridSize.y * 0.5;
        float dx = (cell.x - cx) / cx;
        float dy = (cell.y - cy) / cy;
        float dist = sqrt(dx * dx + (dy * dy) / (u_aspect * u_aspect));

        float charIndex = 0.0;
        if (dist >= 0.15) {
          float angle = atan(dy, dx);
          float spiralOffset = 1.0 / (dist + 0.05);
          float wave1 = sin(angle * 3.0 + spiralOffset * 2.0 - u_time * 3.0);
          float wave2 = cos(angle * 5.0 - spiralOffset * 3.0 + u_time * 2.0);
          float intensity = (wave1 + wave2) * 0.5 + 0.5;
          float falloff = max(0.0, 1.0 - (dist - 0.15) * 1.5);
          float disk = exp(-pow((dist - 0.3) * 10.0, 2.0)) * 0.8;
          float finalVal = intensity * falloff + disk;
          charIndex = floor(min(finalVal, 1.0) * (u_charCount - 1.0));
        }

        vec2 cellLocal = fract(uv * u_gridSize);
        vec2 glyphUV = vec2((cellLocal.x + charIndex) / u_charCount, cellLocal.y);
        float glyphAlpha = texture2D(u_glyph, glyphUV).a;

        vec3 color;
        if (charIndex <= 2.0) {
          color = u_colors[0];
        } else if (charIndex <= 4.0) {
          color = u_colors[1];
        } else if (charIndex <= 6.0) {
          color = u_colors[2];
        } else if (charIndex <= 7.0) {
          color = u_colors[3];
        } else {
          color = u_colors[4];
        }

        gl_FragColor = vec4(color, glyphAlpha);
      }
    `;

    const initRenderer = (
      targetCanvas: HTMLCanvasElement,
      colors: Float32Array
    ) => {
      const gl =
        (targetCanvas.getContext("webgl", {
          alpha: true,
          premultipliedAlpha: false,
        }) as WebGLRenderingContext | null) ||
        (targetCanvas.getContext("experimental-webgl") as
          | WebGLRenderingContext
          | null);
      if (!gl) return null;

      const program = createProgram(gl, vertexSource, fragmentSource);
      if (!program) return null;

      const positionBuffer = gl.createBuffer();
      if (!positionBuffer) return null;

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      gl.useProgram(program);

      const aPosition = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

      const glyphTexture = gl.createTexture();
      if (!glyphTexture) return null;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        glyphAtlas
      );

      const uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
      const uGridSize = gl.getUniformLocation(program, "u_gridSize");
      const uTime = gl.getUniformLocation(program, "u_time");
      const uAspect = gl.getUniformLocation(program, "u_aspect");
      const uCharCount = gl.getUniformLocation(program, "u_charCount");
      const uGlyph = gl.getUniformLocation(program, "u_glyph");
      const uColors = gl.getUniformLocation(program, "u_colors[0]");

      if (
        !uCanvasSize ||
        !uGridSize ||
        !uTime ||
        !uAspect ||
        !uCharCount ||
        !uGlyph ||
        !uColors
      ) {
        return null;
      }

      gl.uniform2f(uCanvasSize, targetCanvas.width, targetCanvas.height);
      gl.uniform2f(uGridSize, width, height);
      gl.uniform1f(uAspect, ASPECT);
      gl.uniform1f(uCharCount, CHARS.length);
      gl.uniform1i(uGlyph, 0);
      gl.uniform3fv(uColors, colors);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const render = (time: number) => {
        gl.useProgram(program);
        gl.viewport(0, 0, targetCanvas.width, targetCanvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uTime, time);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      };

      const setColors = (next: Float32Array) => {
        gl.useProgram(program);
        gl.uniform3fv(uColors, next);
      };

      const destroy = () => {
        gl.deleteTexture(glyphTexture);
        gl.deleteBuffer(positionBuffer);
        gl.deleteProgram(program);
      };

      return { render, setColors, destroy };
    };

    const readColors = () => {
      const swatches = [
        darkRef.current,
        mediumDarkRef.current,
        mediumRef.current,
        brightRef.current,
        brightestRef.current,
      ];
      const parsed = swatches.map((el) =>
        parseColor(getComputedStyle(el || container).color)
      );
      return new Float32Array(parsed.flat());
    };

    const readGlowColor = () => {
      const glowColor = parseColor(
        getComputedStyle(glowColorRef.current || container).color
      );
      return new Float32Array([
        ...glowColor,
        ...glowColor,
        ...glowColor,
        ...glowColor,
        ...glowColor,
      ]);
    };

    const mainRenderer = initRenderer(canvas, readColors());
    const glowRenderer = initRenderer(glowCanvas, readGlowColor());
    if (!mainRenderer || !glowRenderer) return;

    const animate = () => {
      timeRef.current += 0.015;
      const t = timeRef.current;
      mainRenderer.render(t);
      glowRenderer.render(t);
      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);

    const observer = new MutationObserver(() => {
      mainRenderer.setColors(readColors());
      glowRenderer.setColors(readGlowColor());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      observer.disconnect();
      mainRenderer.destroy();
      glowRenderer.destroy();
    };
  }, [width, height]);

  return (
    <div ref={containerRef} className="ascii-black-hole-container">
      <canvas
        ref={glowCanvasRef}
        className="ascii-canvas ascii-canvas-glow"
        aria-hidden="true"
      />
      <canvas ref={canvasRef} className="ascii-canvas" />
      <span
        ref={darkRef}
        className="ascii-color-swatch char-dark"
        aria-hidden="true"
      />
      <span
        ref={mediumDarkRef}
        className="ascii-color-swatch char-medium-dark"
        aria-hidden="true"
      />
      <span
        ref={mediumRef}
        className="ascii-color-swatch char-medium"
        aria-hidden="true"
      />
      <span
        ref={brightRef}
        className="ascii-color-swatch char-bright"
        aria-hidden="true"
      />
      <span
        ref={brightestRef}
        className="ascii-color-swatch char-brightest"
        aria-hidden="true"
      />
      <span
        ref={glowColorRef}
        className="ascii-color-swatch ascii-glow-color"
        aria-hidden="true"
      />
    </div>
  );
};
