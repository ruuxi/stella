import { DOT_COUNT } from "./glyph-atlas";
import { createProgram, getFragmentShader } from "./shader";

export type GlRenderer = {
  render: (time: number, birth: number, flashValue: number) => void;
  setColors: (next: Float32Array) => void;
  destroy: () => void;
};

export const VERTEX_SOURCE = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

export const initRenderer = (
  targetCanvas: HTMLCanvasElement,
  glyphAtlas: HTMLCanvasElement,
  width: number,
  height: number,
  colors: Float32Array,
  birthValue: number,
  flashValue: number,
): GlRenderer | null => {
  const gl =
    (targetCanvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null) ||
    (targetCanvas.getContext("experimental-webgl") as
      | WebGLRenderingContext
      | null);
  if (!gl) return null;

  const fragmentSource = getFragmentShader();
  const program = createProgram(gl, VERTEX_SOURCE, fragmentSource);
  if (!program) return null;

  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) return null;

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
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
    glyphAtlas,
  );

  const uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
  const uGridSize = gl.getUniformLocation(program, "u_gridSize");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uCharCount = gl.getUniformLocation(program, "u_charCount");
  const uBirth = gl.getUniformLocation(program, "u_birth");
  const uFlash = gl.getUniformLocation(program, "u_flash");
  const uGlyph = gl.getUniformLocation(program, "u_glyph");
  const uColors = gl.getUniformLocation(program, "u_colors[0]");

  if (
    !uCanvasSize ||
    !uGridSize ||
    !uTime ||
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
  gl.uniform1f(uCharCount, DOT_COUNT);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform1i(uGlyph, 0);
  gl.uniform3fv(uColors, colors);

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const render = (time: number, birth: number, flash: number) => {
    gl.useProgram(program);
    gl.viewport(0, 0, targetCanvas.width, targetCanvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
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
