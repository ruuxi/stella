import { DOT_COUNT } from "./glyph-atlas";
import {
  createProgram,
  getFragmentShader,
  getInstancedFragmentShader,
  getInstancedVertexShader,
} from "./shader";

export type GlRenderer = {
  render: (
    time: number,
    birth: number,
    flashValue: number,
    listening?: number,
    speaking?: number,
    voiceEnergy?: number,
  ) => void;
  setColors: (next: Float32Array) => void;
  setVisibility: (showEyes: boolean, showMouth: boolean) => void;
  destroy: () => void;
};

export const VERTEX_SOURCE = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const INSTANCED_EXT = "ANGLE_instanced_arrays";

const fract = (x: number) => x - Math.floor(x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep01 = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const configureGlyphTexture = (
  gl: WebGLRenderingContext,
  glyphAtlas: HTMLCanvasElement,
) => {
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

  return glyphTexture;
};

const configureCommonState = (
  gl: WebGLRenderingContext,
  canvasW: number,
  canvasH: number,
) => {
  gl.viewport(0, 0, canvasW, canvasH);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
};

const createCellBuffer = (gridW: number, gridH: number, aspect: number) => {
  const cells: number[] = [];
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const uvX = (x + 0.5) / gridW;
      const uvY = (y + 0.5) / gridH;
      const cx = (uvX - 0.5) * 1.2 * aspect;
      const cy = (uvY - 0.5) * 1.2;
      const dist = Math.sqrt(cx * cx + cy * cy) * 2;
      if (dist <= 2) {
        cells.push(x, y);
      }
    }
  }
  return new Float32Array(cells);
};

const createAnimationUniforms = (
  width: number,
  height: number,
  time: number,
) => {
  const cycle = time * 0.15;
  const phase = cycle - Math.floor(cycle / 3) * 3;
  let w1 =
    Math.max(0, 1 - Math.abs(phase)) + Math.max(0, 1 - Math.abs(phase - 3));
  let w2 = Math.max(0, 1 - Math.abs(phase - 1));
  let w3 = Math.max(0, 1 - Math.abs(phase - 2));
  const total = w1 + w2 + w3 || 1;
  w1 /= total;
  w2 /= total;
  w3 /= total;

  const eyeAngle = -time * 2.5;
  const drift1x = Math.cos(eyeAngle) * 1.1;
  const drift1y = Math.sin(eyeAngle) * 1.1;
  const et = time * 2.0;
  const ep1 = Math.sin(et) * 0.5 + 0.5;
  const ep2 = Math.sin(et + 2.094) * 0.5 + 0.5;
  const ep3 = Math.sin(et + 4.188) * 0.5 + 0.5;
  const epSum = ep1 + ep2 + ep3 || 1;
  const drift2x = ((1 * ep1 + -0.5 * ep2 + -0.5 * ep3) / epSum) * 1.8;
  const drift2y = ((0 * ep1 + 0.866 * ep2 + -0.866 * ep3) / epSum) * 1.8;
  const drift3y = -Math.sin(time * 0.4) * 0.9;
  const eyeDriftX = drift1x * w1 + drift2x * w2;
  const eyeDriftY = drift1y * w1 + drift2y * w2 + drift3y * w3;

  const blinkSlot = Math.floor(time / 0.8);
  const blinkLocal = fract(time / 0.8);
  const blinkHash = fract(Math.sin(blinkSlot * 91.7) * 43758.5453);
  const doBlink = blinkHash >= 0.65 ? 1 : 0;
  const bt = clamp01(blinkLocal / 0.1);
  const blinkCurve = smoothstep01(0, 1, Math.abs(bt * 2 - 1));
  let blink = 1 + (blinkCurve - 1) * doBlink;
  const dblHash = fract(Math.sin(blinkSlot * 73.3) * 28461.7);
  const doDouble = (dblHash >= 0.8 ? 1 : 0) * doBlink;
  const bt2 = clamp01((blinkLocal - 0.15) / 0.1);
  const dblCurve = smoothstep01(0, 1, Math.abs(bt2 * 2 - 1));
  blink *= 1 + (dblCurve - 1) * doDouble;

  const mouthSlot = Math.floor(time / 2.5);
  const mouthLocal = fract(time / 2.5);
  const mouthHash = fract(Math.sin(mouthSlot * 47.3) * 31718.9);
  const shapeHash = fract(Math.sin(mouthSlot * 113.1) * 18734.3);
  const doOpen = mouthHash >= 0.7 ? 1 : 0;
  const openUp = smoothstep01(0, 0.08, mouthLocal);
  const closeDown = 1 - smoothstep01(0.6, 0.8, mouthLocal);
  const mouthAnim = openUp * closeDown * doOpen;
  let mouthShapeIdx;
  if (shapeHash < 0.2) mouthShapeIdx = 0;
  else if (shapeHash < 0.4) mouthShapeIdx = 1;
  else if (shapeHash < 0.6) mouthShapeIdx = 2;
  else if (shapeHash < 0.8) mouthShapeIdx = 3;
  else mouthShapeIdx = 4;

  const eyeUp = 2.5 / height;
  const mouthYOffset = 3.5 / height;
  const eyeOriginX = 0.5 + eyeDriftX / width;
  const eyeOriginY = 0.5 - eyeUp + eyeDriftY / height;

  return {
    w1,
    w2,
    w3,
    eyeOriginX,
    eyeOriginY,
    blink,
    mouthPosX: eyeOriginX,
    mouthPosY: eyeOriginY + mouthYOffset,
    mouthShapeIdx,
    mouthAnim,
  };
};

const initInstancedRenderer = (
  gl: WebGLRenderingContext,
  targetCanvas: HTMLCanvasElement,
  glyphAtlas: HTMLCanvasElement,
  width: number,
  height: number,
  colors: Float32Array,
  birthValue: number,
  flashValue: number,
  initialVisibility: { showEyes: boolean; showMouth: boolean },
): GlRenderer | null => {
  const instanced = gl.getExtension(INSTANCED_EXT);
  if (!instanced) return null;

  const program = createProgram(
    gl,
    getInstancedVertexShader(),
    getInstancedFragmentShader(),
  );
  if (!program) return null;

  const cornerBuffer = gl.createBuffer();
  const cellBuffer = gl.createBuffer();
  if (!cornerBuffer || !cellBuffer) {
    gl.deleteProgram(program);
    return null;
  }

  const glyphTexture = configureGlyphTexture(gl, glyphAtlas);
  if (!glyphTexture) {
    gl.deleteBuffer(cornerBuffer);
    gl.deleteBuffer(cellBuffer);
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);

  const canvasW = targetCanvas.width;
  const canvasH = targetCanvas.height;
  const aspect = canvasH > 0 ? canvasW / canvasH : 1;
  const gridW = Math.max(1, Math.round(width));
  const gridH = Math.max(1, Math.round(height));
  const cellData = createCellBuffer(gridW, gridH, aspect);
  const cellCount = cellData.length / 2;

  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aCorner = gl.getAttribLocation(program, "a_corner");
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, cellBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, cellData, gl.STATIC_DRAW);
  const aCell = gl.getAttribLocation(program, "a_cell");
  gl.enableVertexAttribArray(aCell);
  gl.vertexAttribPointer(aCell, 2, gl.FLOAT, false, 0, 0);
  instanced.vertexAttribDivisorANGLE(aCell, 1);

  const uGridSize = gl.getUniformLocation(program, "u_gridSize");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uCharCount = gl.getUniformLocation(program, "u_charCount");
  const uBirth = gl.getUniformLocation(program, "u_birth");
  const uFlash = gl.getUniformLocation(program, "u_flash");
  const uGlyph = gl.getUniformLocation(program, "u_glyph");
  const uColors = gl.getUniformLocation(program, "u_colors[0]");
  const uListening = gl.getUniformLocation(program, "u_listening");
  const uSpeaking = gl.getUniformLocation(program, "u_speaking");
  const uVoiceEnergy = gl.getUniformLocation(program, "u_voiceEnergy");
  const uAspect = gl.getUniformLocation(program, "u_aspect");
  const uPhases = gl.getUniformLocation(program, "u_phases");
  const uEyeOrigin = gl.getUniformLocation(program, "u_eyeOrigin");
  const uEyeBlink = gl.getUniformLocation(program, "u_eyeBlink");
  const uMouthPos = gl.getUniformLocation(program, "u_mouthPos");
  const uMouthShape = gl.getUniformLocation(program, "u_mouthShape");
  const uMouthAnim = gl.getUniformLocation(program, "u_mouthAnim");
  const uShowEyes = gl.getUniformLocation(program, "u_showEyes");
  const uShowMouth = gl.getUniformLocation(program, "u_showMouth");

  if (
    !uGridSize ||
    !uTime ||
    !uCharCount ||
    !uBirth ||
    !uFlash ||
    !uGlyph ||
    !uColors
  ) {
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(cornerBuffer);
    gl.deleteBuffer(cellBuffer);
    gl.deleteProgram(program);
    return null;
  }

  gl.uniform2f(uGridSize, gridW, gridH);
  gl.uniform1f(uCharCount, DOT_COUNT);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform1i(uGlyph, 0);
  gl.uniform3fv(uColors, colors);
  if (uListening) gl.uniform1f(uListening, 0);
  if (uSpeaking) gl.uniform1f(uSpeaking, 0);
  if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, 0);
  if (uAspect) gl.uniform1f(uAspect, aspect);
  if (uShowEyes) gl.uniform1f(uShowEyes, initialVisibility.showEyes ? 1 : 0);
  if (uShowMouth) gl.uniform1f(uShowMouth, initialVisibility.showMouth ? 1 : 0);

  configureCommonState(gl, canvasW, canvasH);
  const phasesArr = new Float32Array(3);

  const render = (
    time: number,
    birth: number,
    flash: number,
    listening = 0,
    speaking = 0,
    voiceEnergy = 0,
  ) => {
    const uniforms = createAnimationUniforms(gridW, gridH, time);

    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
    if (uListening) gl.uniform1f(uListening, listening);
    if (uSpeaking) gl.uniform1f(uSpeaking, speaking);
    if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, voiceEnergy);
    if (uPhases) {
      phasesArr[0] = uniforms.w1;
      phasesArr[1] = uniforms.w2;
      phasesArr[2] = uniforms.w3;
      gl.uniform3fv(uPhases, phasesArr);
    }
    if (uEyeOrigin)
      gl.uniform2f(uEyeOrigin, uniforms.eyeOriginX, uniforms.eyeOriginY);
    if (uEyeBlink) gl.uniform1f(uEyeBlink, uniforms.blink);
    if (uMouthPos)
      gl.uniform2f(uMouthPos, uniforms.mouthPosX, uniforms.mouthPosY);
    if (uMouthShape) gl.uniform1f(uMouthShape, uniforms.mouthShapeIdx);
    if (uMouthAnim) gl.uniform1f(uMouthAnim, uniforms.mouthAnim);

    gl.clear(gl.COLOR_BUFFER_BIT);
    instanced.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, cellCount);
  };

  const setColors = (next: Float32Array) => {
    gl.uniform3fv(uColors, next);
  };

  const setVisibility = (showEyes: boolean, showMouth: boolean) => {
    if (uShowEyes) gl.uniform1f(uShowEyes, showEyes ? 1 : 0);
    if (uShowMouth) gl.uniform1f(uShowMouth, showMouth ? 1 : 0);
  };

  const destroy = () => {
    instanced.vertexAttribDivisorANGLE(aCell, 0);
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(cornerBuffer);
    gl.deleteBuffer(cellBuffer);
    gl.deleteProgram(program);
  };

  return { render, setColors, setVisibility, destroy };
};

const initFullCanvasRenderer = (
  gl: WebGLRenderingContext,
  targetCanvas: HTMLCanvasElement,
  glyphAtlas: HTMLCanvasElement,
  width: number,
  height: number,
  colors: Float32Array,
  birthValue: number,
  flashValue: number,
  initialVisibility: { showEyes: boolean; showMouth: boolean },
): GlRenderer | null => {
  const program = createProgram(gl, VERTEX_SOURCE, getFragmentShader());
  if (!program) return null;

  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) {
    gl.deleteProgram(program);
    return null;
  }

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

  const glyphTexture = configureGlyphTexture(gl, glyphAtlas);
  if (!glyphTexture) {
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }

  const uCanvasSize = gl.getUniformLocation(program, "u_canvasSize");
  const uGridSize = gl.getUniformLocation(program, "u_gridSize");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uCharCount = gl.getUniformLocation(program, "u_charCount");
  const uBirth = gl.getUniformLocation(program, "u_birth");
  const uFlash = gl.getUniformLocation(program, "u_flash");
  const uGlyph = gl.getUniformLocation(program, "u_glyph");
  const uColors = gl.getUniformLocation(program, "u_colors[0]");
  const uListening = gl.getUniformLocation(program, "u_listening");
  const uSpeaking = gl.getUniformLocation(program, "u_speaking");
  const uVoiceEnergy = gl.getUniformLocation(program, "u_voiceEnergy");
  const uAspect = gl.getUniformLocation(program, "u_aspect");
  const uPhases = gl.getUniformLocation(program, "u_phases");
  const uEyeOrigin = gl.getUniformLocation(program, "u_eyeOrigin");
  const uEyeBlink = gl.getUniformLocation(program, "u_eyeBlink");
  const uMouthPos = gl.getUniformLocation(program, "u_mouthPos");
  const uMouthShape = gl.getUniformLocation(program, "u_mouthShape");
  const uMouthAnim = gl.getUniformLocation(program, "u_mouthAnim");
  const uShowEyes = gl.getUniformLocation(program, "u_showEyes");
  const uShowMouth = gl.getUniformLocation(program, "u_showMouth");

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
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    return null;
  }

  const canvasW = targetCanvas.width;
  const canvasH = targetCanvas.height;
  const aspect = canvasH > 0 ? canvasW / canvasH : 1;

  gl.uniform2f(uCanvasSize, canvasW, canvasH);
  gl.uniform2f(uGridSize, width, height);
  gl.uniform1f(uCharCount, DOT_COUNT);
  gl.uniform1f(uBirth, birthValue);
  gl.uniform1f(uFlash, flashValue);
  gl.uniform1i(uGlyph, 0);
  gl.uniform3fv(uColors, colors);
  if (uListening) gl.uniform1f(uListening, 0);
  if (uSpeaking) gl.uniform1f(uSpeaking, 0);
  if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, 0);
  if (uAspect) gl.uniform1f(uAspect, aspect);
  if (uShowEyes) gl.uniform1f(uShowEyes, initialVisibility.showEyes ? 1 : 0);
  if (uShowMouth) gl.uniform1f(uShowMouth, initialVisibility.showMouth ? 1 : 0);

  configureCommonState(gl, canvasW, canvasH);
  const phasesArr = new Float32Array(3);

  const render = (
    time: number,
    birth: number,
    flash: number,
    listening = 0,
    speaking = 0,
    voiceEnergy = 0,
  ) => {
    const uniforms = createAnimationUniforms(width, height, time);

    gl.uniform1f(uTime, time);
    gl.uniform1f(uBirth, birth);
    gl.uniform1f(uFlash, flash);
    if (uListening) gl.uniform1f(uListening, listening);
    if (uSpeaking) gl.uniform1f(uSpeaking, speaking);
    if (uVoiceEnergy) gl.uniform1f(uVoiceEnergy, voiceEnergy);
    if (uPhases) {
      phasesArr[0] = uniforms.w1;
      phasesArr[1] = uniforms.w2;
      phasesArr[2] = uniforms.w3;
      gl.uniform3fv(uPhases, phasesArr);
    }
    if (uEyeOrigin)
      gl.uniform2f(uEyeOrigin, uniforms.eyeOriginX, uniforms.eyeOriginY);
    if (uEyeBlink) gl.uniform1f(uEyeBlink, uniforms.blink);
    if (uMouthPos)
      gl.uniform2f(uMouthPos, uniforms.mouthPosX, uniforms.mouthPosY);
    if (uMouthShape) gl.uniform1f(uMouthShape, uniforms.mouthShapeIdx);
    if (uMouthAnim) gl.uniform1f(uMouthAnim, uniforms.mouthAnim);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const setColors = (next: Float32Array) => {
    gl.uniform3fv(uColors, next);
  };

  const setVisibility = (showEyes: boolean, showMouth: boolean) => {
    if (uShowEyes) gl.uniform1f(uShowEyes, showEyes ? 1 : 0);
    if (uShowMouth) gl.uniform1f(uShowMouth, showMouth ? 1 : 0);
  };

  const destroy = () => {
    gl.deleteTexture(glyphTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
  };

  return { render, setColors, setVisibility, destroy };
};

export const initRenderer = (
  targetCanvas: HTMLCanvasElement,
  glyphAtlas: HTMLCanvasElement,
  width: number,
  height: number,
  colors: Float32Array,
  birthValue: number,
  flashValue: number,
  initialVisibility: { showEyes: boolean; showMouth: boolean } = {
    showEyes: true,
    showMouth: false,
  },
): GlRenderer | null => {
  const gl =
    (targetCanvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null) ||
    (targetCanvas.getContext(
      "experimental-webgl",
    ) as WebGLRenderingContext | null);
  if (!gl) return null;

  return (
    initInstancedRenderer(
      gl,
      targetCanvas,
      glyphAtlas,
      width,
      height,
      colors,
      birthValue,
      flashValue,
      initialVisibility,
    ) ??
    initFullCanvasRenderer(
      gl,
      targetCanvas,
      glyphAtlas,
      width,
      height,
      colors,
      birthValue,
      flashValue,
      initialVisibility,
    )
  );
};
