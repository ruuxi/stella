/**
 * WebGL blob animation for the radial dial.
 * Renders an expanding organic blob that morphs into wedge sectors.
 * Uses spring physics for Apple-like overshoot + settle.
 */

// ---- Shaders ----

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `
precision highp float;
varying vec2 v_uv;

uniform float u_progress;
uniform float u_leadP;
uniform float u_lagP;
uniform float u_morph;
uniform float u_time;
uniform vec3 u_fills[5];
uniform vec3 u_selFill;
uniform vec3 u_centerBg;
uniform vec3 u_stroke;
uniform float u_selIdx;

const float PI = 3.14159265;
const float TAU = 6.28318530;
const float WEDGE_ANG = TAU / 5.0;
const float INNER_R = 40.0 / 280.0;
const float OUTER_R = 125.0 / 280.0;
const float CENTER_R = 35.0 / 280.0;

void main() {
    vec2 p = v_uv - 0.5;
    float dist = length(p);
    float angle = atan(p.y, p.x);
    float topAngle = mod(angle + PI * 0.5, TAU);

    int wi = int(floor(topAngle / WEDGE_ANG));
    float wFrac = fract(topAngle / WEDGE_ANG);

    // Organic edge wobble — multiple harmonics for fluid feel
    float wobble = sin(angle * 3.0 + u_time * 1.5) * 0.012
                 + sin(angle * 5.0 - u_time * 2.0) * 0.008
                 + sin(angle * 2.0 + 0.5) * 0.018
                 + sin(angle * 4.0 - 1.3) * 0.006;
    wobble *= (1.0 - u_morph * 0.85);

    // Non-uniform expansion — some lobes grow faster
    float asym = sin(angle * 2.3 + 0.7) * 0.035
               + sin(angle * 1.0 - 0.4) * 0.02;
    asym *= (1.0 - u_morph * 0.9);

    // Outer edge (lags)
    float outerR = u_lagP * OUTER_R * (1.0 + asym) + wobble * u_lagP;

    // Inner hole (delayed, forms after blob expands)
    float innerT = clamp((u_progress - 0.4) / 0.6, 0.0, 1.0);
    float innerR = innerT * INNER_R;

    // Center circle (leads)
    float centerT = clamp((u_leadP - 0.25) / 0.75, 0.0, 1.0);
    float centerR = centerT * CENTER_R;

    // Edge softness — blurry when small, crisp when settled
    float soft = mix(0.022, 0.004, u_morph);

    float outerMask = smoothstep(outerR + soft, outerR - soft, dist);
    float innerMask = smoothstep(innerR - soft * 0.5, innerR + soft * 0.5, dist);
    float centerMask = smoothstep(centerR + soft * 0.4, centerR - soft * 0.4, dist);

    float ring = outerMask * innerMask;

    // Wedge color (if-chain for WebGL 1 compat)
    vec3 wc;
    if (wi == 0) wc = u_fills[0];
    else if (wi == 1) wc = u_fills[1];
    else if (wi == 2) wc = u_fills[2];
    else if (wi == 3) wc = u_fills[3];
    else wc = u_fills[4];

    // Selected wedge override
    if (u_selIdx >= 0.0 && abs(float(wi) - u_selIdx) < 0.5) {
        wc = u_selFill;
    }

    // Blend uniform blob color → distinct sector colors
    vec3 avg = (u_fills[0] + u_fills[1] + u_fills[2] + u_fills[3] + u_fills[4]) * 0.2;
    vec3 ringColor = mix(avg, wc, u_morph);

    // Subtle sector border lines
    float bDist = min(wFrac, 1.0 - wFrac);
    float bWidth = 0.006 / max(dist * 5.0, 0.01);
    float bLine = smoothstep(0.0, bWidth, bDist);
    ringColor = mix(u_stroke, ringColor, mix(1.0, bLine, u_morph * 0.6));

    // Composite: center on top of ring
    vec3 color = ringColor;
    float alpha = ring;
    color = mix(color, u_centerBg, centerMask);
    alpha = max(alpha, centerMask);

    gl_FragColor = vec4(color, alpha);
}
`

// ---- Types ----

type Vec3 = [number, number, number]

export interface BlobColors {
  fills: Vec3[]
  selectedFill: Vec3
  centerBg: Vec3
  stroke: Vec3
}

interface BlobGL {
  gl: WebGLRenderingContext
  prog: WebGLProgram
  locs: Record<string, WebGLUniformLocation | null>
}

// ---- Module state ----

let blobGL: BlobGL | null = null
let animFrame: number | null = null

// ---- Color conversion ----

let _colorCtx: CanvasRenderingContext2D | null | undefined

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function parseHexColor(color: string): Uint8ClampedArray | null {
  if (!color.startsWith('#')) return null
  const hex = color.slice(1).trim()
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16)
    const g = parseInt(hex[1] + hex[1], 16)
    const b = parseInt(hex[2] + hex[2], 16)
    const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) : 255
    if ([r, g, b, a].some(Number.isNaN)) return null
    return new Uint8ClampedArray([r, g, b, a])
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255
    if ([r, g, b, a].some(Number.isNaN)) return null
    return new Uint8ClampedArray([r, g, b, a])
  }
  return null
}

function parseRgbToken(token: string): number | null {
  const t = token.trim()
  if (!t) return null
  if (t.endsWith('%')) {
    const pct = Number.parseFloat(t.slice(0, -1))
    if (!Number.isFinite(pct)) return null
    return clampByte((pct / 100) * 255)
  }
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return null
  return clampByte(n)
}

function parseAlphaToken(token: string | undefined): number {
  if (!token) return 255
  const t = token.trim()
  if (t.endsWith('%')) {
    const pct = Number.parseFloat(t.slice(0, -1))
    if (!Number.isFinite(pct)) return 255
    return clampByte((pct / 100) * 255)
  }
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n)) return 255
  return clampByte(n <= 1 ? n * 255 : n)
}

function parseRgbColor(color: string): Uint8ClampedArray | null {
  const match = color.trim().match(/^rgba?\((.+)\)$/i)
  if (!match) return null

  const body = match[1].replace(/\s*\/\s*/g, ',')
  const parts = body.split(/[,\s]+/).filter(Boolean)
  if (parts.length < 3) return null

  const r = parseRgbToken(parts[0])
  const g = parseRgbToken(parts[1])
  const b = parseRgbToken(parts[2])
  if (r === null || g === null || b === null) return null

  return new Uint8ClampedArray([r, g, b, parseAlphaToken(parts[3])])
}

function getColorCtx(): CanvasRenderingContext2D | null {
  if (_colorCtx !== undefined) return _colorCtx
  if (typeof document === 'undefined') {
    _colorCtx = null
    return _colorCtx
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  _colorCtx = canvas.getContext('2d')
  return _colorCtx
}

function sampleColor(color: string): Uint8ClampedArray {
  const parsed = parseHexColor(color) ?? parseRgbColor(color)
  if (parsed) return parsed

  const ctx = getColorCtx()
  if (!ctx) return new Uint8ClampedArray([0, 0, 0, 255])

  try {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    return ctx.getImageData(0, 0, 1, 1).data
  } catch {
    return new Uint8ClampedArray([0, 0, 0, 255])
  }
}

export function cssToVec3(color: string): Vec3 {
  const d = sampleColor(color)
  return [d[0] / 255, d[1] / 255, d[2] / 255]
}

/** Convert any CSS color to an opaque rgb() string (strips alpha). */
export function cssToOpaque(color: string): string {
  const d = sampleColor(color)
  return `rgb(${d[0]}, ${d[1]}, ${d[2]})`
}

// ---- WebGL setup ----

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s)
    return null
  }
  return s
}

export function initBlob(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false })
  if (!gl) return false

  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) return false

  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog)
    return false
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  // Fullscreen quad
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const pos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(pos)
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)

  const loc = (name: string) => gl.getUniformLocation(prog, name)

  blobGL = {
    gl,
    prog,
    locs: {
      u_progress: loc('u_progress'),
      u_leadP: loc('u_leadP'),
      u_lagP: loc('u_lagP'),
      u_morph: loc('u_morph'),
      u_time: loc('u_time'),
      u_fills: loc('u_fills'),
      u_selFill: loc('u_selFill'),
      u_centerBg: loc('u_centerBg'),
      u_stroke: loc('u_stroke'),
      u_selIdx: loc('u_selIdx'),
    },
  }

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  return true
}

// ---- Spring physics ----

function springEase(t: number): number {
  if (t <= 0) return 0
  const zeta = 0.58
  const omega = 28
  const omegaD = omega * Math.sqrt(1 - zeta * zeta)
  return (
    1 -
    Math.exp(-zeta * omega * t) *
      (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t))
  )
}

// ---- Render single frame ----

function draw(
  progress: number,
  leadP: number,
  lagP: number,
  morph: number,
  time: number,
  selIdx: number,
  colors: BlobColors,
) {
  if (!blobGL) return
  const { gl, prog, locs } = blobGL

  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.useProgram(prog)

  gl.uniform1f(locs.u_progress!, progress)
  gl.uniform1f(locs.u_leadP!, leadP)
  gl.uniform1f(locs.u_lagP!, lagP)
  gl.uniform1f(locs.u_morph!, morph)
  gl.uniform1f(locs.u_time!, time)
  gl.uniform1f(locs.u_selIdx!, selIdx)

  const flat = new Float32Array(15)
  for (let i = 0; i < 5; i++) {
    const c = colors.fills[i] ?? [0, 0, 0]
    flat[i * 3] = c[0]
    flat[i * 3 + 1] = c[1]
    flat[i * 3 + 2] = c[2]
  }
  gl.uniform3fv(locs.u_fills!, flat)
  gl.uniform3fv(locs.u_selFill!, new Float32Array(colors.selectedFill))
  gl.uniform3fv(locs.u_centerBg!, new Float32Array(colors.centerBg))
  gl.uniform3fv(locs.u_stroke!, new Float32Array(colors.stroke))

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

// ---- Animation loops ----

const OPEN_SETTLE = 420 // ms
const CLOSE_DURATION = 180 // ms

export { CLOSE_DURATION }

export function startOpen(
  selIdxRef: { current: number },
  colorsRef: { current: BlobColors },
  onComplete: () => void,
) {
  if (animFrame !== null) cancelAnimationFrame(animFrame)
  const start = performance.now()

  const tick = (now: number) => {
    const s = (now - start) / 1000
    const progress = springEase(s)
    const leadP = springEase(s + 0.035)
    const lagP = springEase(s - 0.020)
    const morphRaw = springEase(s - 0.06)
    const morph = Math.pow(Math.max(0, morphRaw), 1.3)

    draw(progress, leadP, lagP, morph, s, selIdxRef.current, colorsRef.current)

    if (s * 1000 < OPEN_SETTLE) {
      animFrame = requestAnimationFrame(tick)
    } else {
      animFrame = null
      onComplete()
    }
  }
  animFrame = requestAnimationFrame(tick)
}

export function startClose(
  selIdxRef: { current: number },
  colorsRef: { current: BlobColors },
  onComplete: () => void,
) {
  if (animFrame !== null) cancelAnimationFrame(animFrame)
  const start = performance.now()

  const tick = (now: number) => {
    const elapsed = now - start
    const t = Math.min(elapsed / CLOSE_DURATION, 1)
    const eased = t * t
    const progress = 1 - eased
    const lagP = 1 - Math.pow(Math.min(t * 1.15, 1), 2)
    const leadP = 1 - Math.pow(Math.max(0, t - 0.08), 2) / (0.92 * 0.92)
    const morph = Math.max(0, progress - 0.15) / 0.85

    draw(progress, leadP, lagP, morph, t * 0.2, selIdxRef.current, colorsRef.current)

    if (t < 1) {
      animFrame = requestAnimationFrame(tick)
    } else {
      animFrame = null
      clearCanvas()
      onComplete()
    }
  }
  animFrame = requestAnimationFrame(tick)
}

export function cancelAnimation() {
  if (animFrame !== null) {
    cancelAnimationFrame(animFrame)
    animFrame = null
  }
  clearCanvas()
}

function clearCanvas() {
  if (blobGL) {
    const { gl } = blobGL
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
}

export function destroyBlob() {
  cancelAnimation()
  if (blobGL) {
    blobGL.gl.deleteProgram(blobGL.prog)
    blobGL = null
  }
}
