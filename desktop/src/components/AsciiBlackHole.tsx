import React, { useEffect, useImperativeHandle, useRef } from "react";
import "./AsciiBlackHole.css";

const CHARS = " .:-=+*#%@"; // Ordered by apparent brightness
const ASPECT = 0.55;
const BIRTH_DURATION = 12000;
const FLASH_DURATION = 1200;

export interface AsciiBlackHoleHandle {
  triggerFlash: () => void;
  startBirth: () => void;
  reset: (value?: number) => void;
}

interface AsciiBlackHoleProps {
  width?: number;
  height?: number;
  initialBirthProgress?: number; // 0 = not born yet, 1 = fully emerged
  paused?: boolean;
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

const getFragmentShader = (): string => {
  const baseHeader = `
    precision mediump float;
    uniform vec2 u_canvasSize;
    uniform vec2 u_gridSize;
    uniform float u_time;
    uniform float u_aspect;
    uniform float u_charCount;
    uniform float u_birth;
    uniform float u_flash;
    uniform sampler2D u_glyph;
    uniform vec3 u_colors[5];
  `;

  const baseColorLogic = `
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
    
    // Expanding flash wave from center outward
    // u_flash: 1 = just triggered (wave at center), 0 = done (wave expanded)
    float waveRadius = (1.0 - u_flash) * 1.8;
    float waveWidth = 0.3;
    
    // Distance from the wave front - intensity peaks at wave front
    float waveDist = abs(dist - waveRadius);
    float waveIntensity = smoothstep(waveWidth, 0.0, waveDist) * u_flash;
    
    // Boost existing color brightness (no white shift)
    color *= 1.0 + waveIntensity * 2.0;
    
    gl_FragColor = vec4(color, glyphAlpha);
  `;

  // Evolving - Morphing between Black Hole, Neural, and Becoming
  return `${baseHeader}
    void main() {
      vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);
      vec2 cell = floor(uv * u_gridSize);
      float cx = u_gridSize.x * 0.5;
      float cy = u_gridSize.y * 0.5;
      float dx = (cell.x - cx) / cx;
      float dy = (cell.y - cy) / cy;
      float dist = sqrt(dx * dx + (dy * dy) / (u_aspect * u_aspect));
      float angle = atan(dy, dx);

      float cycle = u_time * 0.15;
      float phase = mod(cycle, 3.0);
      
      float w1 = max(0.0, 1.0 - abs(phase - 0.0)) + max(0.0, 1.0 - abs(phase - 3.0));
      float w2 = max(0.0, 1.0 - abs(phase - 1.0));
      float w3 = max(0.0, 1.0 - abs(phase - 2.0));
      float total = w1 + w2 + w3;
      w1 /= total; w2 /= total; w3 /= total;
      
      float i1 = 0.0;
      if (dist >= 0.15) {
        float spiralOffset = 1.0 / (dist + 0.05);
        float wave1 = sin(angle * 3.0 + spiralOffset * 2.0 - u_time * 3.0);
        float wave2 = cos(angle * 5.0 - spiralOffset * 3.0 + u_time * 2.0);
        float falloff = max(0.0, 1.0 - (dist - 0.15) * 1.5);
        float disk = exp(-pow((dist - 0.3) * 10.0, 2.0)) * 0.8;
        i1 = ((wave1 + wave2) * 0.5 + 0.5) * falloff + disk;
      }
      
      float time1 = u_time * 2.0;
      float p1 = sin(time1) * 0.5 + 0.5;
      float p2 = sin(time1 + 2.094) * 0.5 + 0.5;
      float p3 = sin(time1 + 4.188) * 0.5 + 0.5;
      float s1 = exp(-abs(mod(angle + 0.0, 6.283) - 3.14) * 1.5) * p1;
      float s2 = exp(-abs(mod(angle + 2.094, 6.283) - 3.14) * 1.5) * p2;
      float s3 = exp(-abs(mod(angle + 4.188, 6.283) - 3.14) * 1.5) * p3;
      float radialWave = sin(dist * 10.0 - u_time * 3.0) * 0.3 + 0.7;
      float rays = max(max(s1, s2), s3) * radialWave;
      float core2 = exp(-dist * 4.0) * 0.8;
      float falloff2 = max(0.0, 1.0 - dist * 0.8);
      float i2 = rays * falloff2 + core2;
      
      float breathe = sin(u_time * 0.4) * 0.5 + 0.5;
      float potential = sin(angle * 7.0 + dist * 8.0 + u_time * 0.5) * 0.5 + 0.5;
      potential *= exp(-dist * 1.0);
      float form = sin(angle * 3.0 - u_time * 0.3) * 0.5 + 0.5;
      form *= sin(dist * 12.0 - u_time * 1.2) * 0.5 + 0.5;
      form *= exp(-dist * 1.5);
      float self = exp(-dist * 3.5) * (0.7 + breathe * 0.3);
      float i3 = self + mix(potential, form, breathe) * 0.5;
      
      float intensity = i1 * w1 + i2 * w2 + i3 * w3;
      intensity = min(intensity, 1.0);
      
      // Small creatures stay bright and alive with stronger pulsing
      float birthRadius = u_birth * 1.5;
      float birthEdge = smoothstep(birthRadius, birthRadius - 0.3, dist);
      
      // Faster, more organic pulse at small sizes (neural network "thinking")
      // At u_birth=1.0, this reduces to the original: pulseStrength=0, birthPulse=1.0
      float smallness = 1.0 - u_birth;
      float pulseSpeed = 5.0 + smallness * 2.0;
      float pulseStrength = smallness * 0.5;
      float birthPulse = 1.0 + sin(dist * 25.0 - u_time * pulseSpeed) * pulseStrength;
      float breathe2 = 1.0 + sin(u_time * 1.5) * 0.15 * smallness;
      
      intensity *= birthEdge * birthPulse * breathe2;
      // Use sqrt curve so small creatures stay bright, but at u_birth=1.0 this is still 1.0
      intensity *= sqrt(u_birth);
      
      float charIndex = floor(intensity * (u_charCount - 1.0));

      vec2 cellLocal = fract(uv * u_gridSize);
      vec2 glyphUV = vec2((cellLocal.x + charIndex) / u_charCount, cellLocal.y);
      float glyphAlpha = texture2D(u_glyph, glyphUV).a;
      ${baseColorLogic}
    }
  `;
};

export const AsciiBlackHole = React.forwardRef<
  AsciiBlackHoleHandle,
  AsciiBlackHoleProps
>(({ width = 80, height = 40, initialBirthProgress = 1, paused = false }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const darkRef = useRef<HTMLSpanElement>(null);
  const mediumDarkRef = useRef<HTMLSpanElement>(null);
  const mediumRef = useRef<HTMLSpanElement>(null);
  const brightRef = useRef<HTMLSpanElement>(null);
  const brightestRef = useRef<HTMLSpanElement>(null);
  const requestRef = useRef<number | undefined>(undefined);
  const animateRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  const timeRef = useRef<number>(0);
  const birthRef = useRef<number>(initialBirthProgress);
  const flashRef = useRef<number>(0);
  const birthAnimationRef = useRef<{
    startTime: number;
    startValue: number;
    duration: number;
  } | null>(null);
  const flashAnimationRef = useRef<{
    startTime: number;
    duration: number;
  } | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      triggerFlash: () => {
        flashAnimationRef.current = {
          startTime: performance.now(),
          duration: FLASH_DURATION,
        };
        flashRef.current = 1;
      },
      startBirth: () => {
        if (birthRef.current >= 1) return;
        birthAnimationRef.current = {
          startTime: performance.now(),
          startValue: birthRef.current,
          duration: BIRTH_DURATION,
        };
      },
      reset: (value = initialBirthProgress) => {
        birthRef.current = value;
        birthAnimationRef.current = null;
        flashRef.current = 0;
        flashAnimationRef.current = null;
      },
    }),
    [initialBirthProgress],
  );

  useEffect(() => {
    if (!birthAnimationRef.current) {
      birthRef.current = initialBirthProgress;
    }
  }, [initialBirthProgress]);

  useEffect(() => {
    pausedRef.current = paused;
    // Resume the loop if we were paused and are now active again.
    if (!paused && !requestRef.current && animateRef.current) {
      requestRef.current = requestAnimationFrame(animateRef.current);
    }
  }, [paused]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

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

    const fragmentSource = getFragmentShader();

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
      const uBirth = gl.getUniformLocation(program, "u_birth");
      const uFlash = gl.getUniformLocation(program, "u_flash");
      const uGlyph = gl.getUniformLocation(program, "u_glyph");
      const uColors = gl.getUniformLocation(program, "u_colors[0]");

      if (
        !uCanvasSize ||
        !uGridSize ||
        !uTime ||
        !uAspect ||
        !uCharCount ||
        !uBirth ||
        !uFlash ||
        !uGlyph ||
        !uColors
      ) {
        return null;
      }

      gl.uniform2f(uCanvasSize, targetCanvas.width, targetCanvas.height);
      gl.uniform2f(uGridSize, width, height);
      gl.uniform1f(uAspect, ASPECT);
      gl.uniform1f(uCharCount, CHARS.length);
      gl.uniform1f(uBirth, birthRef.current);
      gl.uniform1f(uFlash, flashRef.current);
      gl.uniform1i(uGlyph, 0);
      gl.uniform3fv(uColors, colors);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const render = (time: number, birth: number, flashValue: number) => {
        gl.useProgram(program);
        gl.viewport(0, 0, targetCanvas.width, targetCanvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uTime, time);
        gl.uniform1f(uBirth, birth);
        gl.uniform1f(uFlash, flashValue);
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

    const mainRenderer = initRenderer(canvas, readColors());
    if (!mainRenderer) return;

      const animate = () => {
        // When paused, stop scheduling frames (keeps the GL resources alive but saves CPU/GPU).
        if (pausedRef.current) {
          requestRef.current = undefined;
          return;
        }
        timeRef.current += 0.015;
        const now = performance.now();

        const birthAnimation = birthAnimationRef.current;
        if (birthAnimation) {
          const elapsed = now - birthAnimation.startTime;
          const t = Math.min(elapsed / birthAnimation.duration, 1);
          const eased = 1 - Math.pow(1 - t, 3);
          birthRef.current =
            birthAnimation.startValue +
            (1 - birthAnimation.startValue) * eased;
          if (t >= 1) {
            birthAnimationRef.current = null;
          }
        }

        const flashAnimation = flashAnimationRef.current;
        if (flashAnimation) {
          const elapsed = now - flashAnimation.startTime;
          const t = Math.min(elapsed / flashAnimation.duration, 1);
          flashRef.current = 1 - t;
          if (t >= 1) {
            flashRef.current = 0;
            flashAnimationRef.current = null;
          }
        }

        mainRenderer.render(timeRef.current, birthRef.current, flashRef.current);
        requestRef.current = requestAnimationFrame(animate);
      };

    animateRef.current = animate;
    if (!pausedRef.current) {
      requestRef.current = requestAnimationFrame(animate);
    }

    const observer = new MutationObserver(() => {
      mainRenderer.setColors(readColors());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      animateRef.current = null;
      observer.disconnect();
      mainRenderer.destroy();
    };
  }, [width, height]);

  return (
    <div ref={containerRef} className="ascii-black-hole-container">
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
    </div>
  );
});
AsciiBlackHole.displayName = "AsciiBlackHole";
