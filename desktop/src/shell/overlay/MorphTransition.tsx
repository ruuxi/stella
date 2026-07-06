import { useEffect, useRef, useState } from "react";
import type { SelfModHmrState } from "../../../../runtime/contracts/index.js";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  MORPH_STEADY_STRENGTH,
  type MorphVisualTiming,
} from "../../shared/contracts/morph-timing";
import { useTheme } from "@/context/theme-context";
import { shouldUseLowPowerEffects } from "@/shared/lib/device-perf";

/** Onboarding demo morph — stronger distortion + slower timing (see `flavor` IPC). */
const ONBOARDING_MORPH_STEADY_STRENGTH = 0.65;
const ONBOARDING_MORPH_COVER_RAMP_MS = 600;
const ONBOARDING_MORPH_HANDOFF_FADE_MS = 800;

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
});

type MorphFlavor = "hmr" | "onboarding";

type MorphPhase = "idle" | "covering" | "crossfading";

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

/**
 * Layered-glass morph cover.
 *
 * The old screenshot settles back behind a sheet of glass as `u_strength`
 * ramps: it recedes ~1% and keeps a barely-there breathe, while a
 * PROGRESSIVE frost builds — clear-ish at the centre, deep at the edges —
 * composited from two blur planes (a broad base and a finer floating layer,
 * both derived from the same golden-angle tap set, so depth costs no extra
 * texture fetches). The frosted state is graded like a material, not dimmed:
 * gentle desaturation, a centre lift with an edge vignette, a soft-knee
 * highlight bloom, and a slow specular sheen drifting diagonally through the
 * glass so the hold feels alive instead of frozen.
 *
 * `u_reveal` then drives the glimm-lineage band sweep (gaussian profile,
 * edge wave, synthesized-normal specular crest), kept as a saturation lens
 * over the user's own content but toned down from the previous pass. The
 * reveal boundary now has material character: a soft leading edge melting
 * into the frost with a crisp trail, a meniscus refraction where the frost
 * bends toward the sweep, and a sub-2px chromatic whisper on the incoming
 * sharp side that exists only inside the band.
 *
 * All design knobs are the consts at the top of the fragment shader.
 */
// Low-power devices drop to 16 taps; the IGN per-pixel spiral rotation turns
// the undersampling into film grain rather than visible rings.
const BLUR_TAPS = shouldUseLowPowerEffects() ? 16 : 48;

const BLUR_FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_tex2;
uniform float u_strength;
uniform float u_reveal;
uniform float u_time;
uniform float u_alpha;
uniform float u_aspect;
// "Stella is changing..." label, pre-rendered to a transparent canvas.
uniform sampler2D u_label;
uniform float u_has_label;
varying vec2 v_uv;

const int BLUR_TAPS = ${BLUR_TAPS};
const float TWO_PI = 6.28318530718;
const float PI = 3.14159265359;
const float GOLDEN_ANGLE = 2.39996323;

// ——— Design knobs ————————————————————————————————————————————————
// Progressive frost: blur radius across the depth field (df 0 = screen
// centre, 1 = corners). Centre stays readable, edges sink into deep glass.
const float FROST_RADIUS_NEAR = 0.024;
const float FROST_RADIUS_FAR  = 0.058;
// Blend between the fine floating plane and the broad base plane, by depth.
const float PLANE_MIX_NEAR = 0.35;
const float PLANE_MIX_FAR  = 0.80;
// Covered snapshot recede + breathe (fractions of frame size).
const float RECEDE_AMOUNT  = 0.012;
const float BREATHE_AMOUNT = 0.0035;
const float BREATHE_RATE   = 0.55;
// Frost material grading (all scaled by frost strength).
const float FROST_DESAT    = 0.10;
const float CENTER_LIFT    = 0.045;
const float VIGNETTE_AMOUNT = 0.085;
const float BLOOM_AMOUNT   = 0.12;
// Drifting sheen through the steady frost (one pass ≈ 6.5s).
const float SHEEN_RATE     = 0.155;
const float SHEEN_AMOUNT   = 0.045;
const float SHEEN_TIGHT    = 55.0;
// Reveal boundary material.
const float EDGE_SOFT_LEAD  = 0.055;
const float EDGE_SOFT_TRAIL = 0.018;
const float REFRACT_AMOUNT  = 0.010;
const float CHROMA_AMOUNT   = 0.0012;
// Band (glimm lineage, toned down from the previous pass).
const float BAND_WIDTH = 16.0;
const float WAVE_AMOUNT = 1.0;
const float SWELL_AMOUNT = 0.65;
const float SAT_BOOST = 1.5;
// ————————————————————————————————————————————————————————————————————

// Interleaved gradient noise — a cheap, well-distributed per-pixel value.
// We use it to rotate each pixel's sampling spiral by a unique angle so
// undersampling shows up as fine film grain instead of visible rings/banding.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float lumaOf(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

// Two frost planes from ONE golden-angle tap set: every tap is weighted
// under a broad kernel (deep glass) and a tight kernel (fine floating
// layer). Layered depth for zero extra texture fetches.
void frostedDual(
  sampler2D tex, vec2 uv, float radius, float rot,
  out vec3 broad, out vec3 fine
) {
  if (radius < 0.0006) {
    vec3 s = texture2D(tex, uv).rgb;
    broad = s;
    fine = s;
    return;
  }
  vec3 accB = vec3(0.0);
  float wsumB = 0.0;
  vec3 accF = vec3(0.0);
  float wsumF = 0.0;
  for (int i = 0; i < BLUR_TAPS; i++) {
    float fi = float(i) + 0.5;
    float t = fi / float(BLUR_TAPS);
    // sqrt() distributes samples evenly across the disk area.
    float r = sqrt(t) * radius;
    float a = fi * GOLDEN_ANGLE + rot;
    vec2 off = vec2(cos(a) / u_aspect, sin(a)) * r;
    vec3 s = texture2D(tex, clamp(uv + off, 0.0, 1.0)).rgb;
    float wB = exp(-2.2 * t);
    float wF = exp(-9.0 * t);
    accB += s * wB;
    wsumB += wB;
    accF += s * wF;
    wsumF += wF;
  }
  broad = accB / wsumB;
  fine = accF / wsumF;
}

void main() {
  float rot = ign(gl_FragCoord.xy) * TWO_PI;
  float axis = v_uv.x;
  float crossAxis = v_uv.y;
  vec2 centered = v_uv - 0.5;

  // ——— band geometry first: the reveal boundary refracts the frost ———
  float pos = mix(-0.2, 1.2, u_reveal);
  float tw = u_time;
  float waveX =
      sin(crossAxis * 6.0 + tw * 1.3) * 0.020
    + sin(crossAxis * 13.0 - tw * 0.9 + 1.4) * 0.012
    + sin(crossAxis * 21.0 + tw * 1.7 + 2.6) * 0.006;
  waveX *= WAVE_AMOUNT;
  float bandTight = 140.0 / BAND_WIDTH;
  float d = (axis - pos) - waveX;
  float band = exp(-d * d * bandTight);
  float dhDaxis = -2.0 * d * bandTight * band;
  float gate = smoothstep(0.0, 0.04, u_reveal) * smoothstep(1.0, 0.96, u_reveal);

  // ——— covered snapshot recedes + breathes behind the glass ———
  float breathe = 0.5 + 0.5 * sin(u_time * BREATHE_RATE);
  float recede = u_strength * (RECEDE_AMOUNT + BREATHE_AMOUNT * breathe);
  vec2 uvOld = centered * (1.0 + recede) + 0.5;
  // Meniscus: near the sweep the frost bends toward the boundary.
  float refr = clamp(dhDaxis, -1.2, 1.2) * REFRACT_AMOUNT * gate;
  uvOld.x = clamp(uvOld.x + refr, 0.0, 1.0);
  uvOld.y = clamp(uvOld.y, 0.0, 1.0);

  // ——— progressive layered frost ———
  // Depth field: 0 at the centre, 1 at the corners (aspect-corrected).
  float rad = length(centered * vec2(u_aspect, 1.0)) /
    (0.5 * length(vec2(u_aspect, 1.0)));
  float df = smoothstep(0.15, 1.0, rad);
  float radius = u_strength * mix(FROST_RADIUS_NEAR, FROST_RADIUS_FAR, df);
  vec3 broadF;
  vec3 fineF;
  frostedDual(u_tex, uvOld, radius, rot, broadF, fineF);
  vec3 frost = mix(fineF, broadF, mix(PLANE_MIX_NEAR, PLANE_MIX_FAR, df));

  // ——— frost material grading ———
  float fs = smoothstep(0.0, 0.9, u_strength);
  float fl = lumaOf(frost);
  frost = mix(frost, vec3(fl), FROST_DESAT * fs);
  float shade = 1.0 + CENTER_LIFT * (1.0 - df) * fs - VIGNETTE_AMOUNT * df * fs;
  frost *= shade;
  float knee = smoothstep(0.68, 1.0, fl);
  frost += frost * knee * BLOOM_AMOUNT * fs;

  // ——— drifting sheen: a slow light pass so the hold feels alive ———
  float sd = dot(v_uv, normalize(vec2(0.80, 0.60)));
  float sPos = mix(-0.45, 1.85, fract(u_time * SHEEN_RATE * 0.5));
  float sheenD = sd - sPos;
  float sheen = exp(-sheenD * sheenD * SHEEN_TIGHT);
  frost += vec3(sheen * SHEEN_AMOUNT * fs * (0.55 + 0.45 * fl));
  frost = clamp(frost, 0.0, 1.0);

  // ——— reveal: soft leading edge melting into the frost, crisp trail ———
  // While the cover holds, u_reveal is exactly 0: pos sits off-screen so
  // revealed is 0 for every visible pixel, gate is 0, and the whole
  // reveal/chroma/band section below collapses algebraically to frost
  // (mix and add by a 0 weight). Guarding it on the u_reveal uniform is a
  // fully-coherent branch that skips that work during the (long) steady hold
  // with byte-identical output — it only runs once the sweep begins.
  float revealed = 0.0;
  vec3 base = frost;
  if (u_reveal > 0.0) {
    revealed = 1.0 - smoothstep(pos - EDGE_SOFT_TRAIL, pos + EDGE_SOFT_LEAD, axis);

    // Chromatic whisper only inside the band, on the incoming sharp side.
    float chroma = CHROMA_AMOUNT * band * gate;
    vec3 sharpNew;
    sharpNew.r = texture2D(u_tex2, clamp(v_uv + vec2(chroma, 0.0), 0.0, 1.0)).r;
    sharpNew.g = texture2D(u_tex2, v_uv).g;
    sharpNew.b = texture2D(u_tex2, clamp(v_uv - vec2(chroma, 0.0), 0.0, 1.0)).b;

    base = mix(frost, sharpNew, revealed);
  }

  // Updating label baked onto the cover: sharp text over the frosted-old side,
  // fading in with the frost (u_strength) and swept away with the reveal band
  // (the 1.0 - revealed mask). Runs during the hold too, so it stays outside
  // the reveal guard (revealed is 0 there).
  if (u_has_label > 0.5) {
    vec4 lbl = texture2D(u_label, v_uv);
    float labelFade = (1.0 - revealed) * smoothstep(0.0, 0.35, u_strength);
    base = mix(base, lbl.rgb, lbl.a * labelFade);
  }

  // ——— glimm flat-band look (geometry computed above, pre-refraction) ———
  // Every term here is scaled by gate (0 while holding), so the block adds
  // nothing until the sweep runs; guard it on u_reveal for the same identical
  // output at lower cost during the hold.
  vec3 outRGB = base;
  if (u_reveal > 0.0) {
    // Synthesized surface normal from the band's analytic slope → the basis for
    // the iridescent hue shift + specular crest (glimm's name-drop trick).
    vec3 N = normalize(vec3(-dhDaxis * 0.18, 0.0, 1.0));

    float trail = clamp(0.5 - d * 1.3, 0.0, 1.0);
    trail = pow(trail, 2.5) * 0.24;
    // Flatten the gaussian falloff for the saturation lens so the band's sides
    // carry more strength (the sharp specular crest still uses raw band).
    float lensBand = pow(band, 0.7);
    float intensity = max(lensBand * 0.55, trail);

    float vfade =
      smoothstep(0.0, 0.015, crossAxis) * smoothstep(1.0, 0.985, crossAxis);

    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 L = normalize(vec3(0.35, 0.55, 0.9));
    vec3 H = normalize(L + V);
    float NdotH = clamp(dot(N, H), 0.0, 1.0);
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = pow(1.0 - NdotV, 3.0);
    float spec = pow(NdotH, 80.0);

    // Soften the band's entry/exit (gate computed above with the geometry).
    float entryFade = mix(0.2, 1.0, 4.0 * u_reveal * (1.0 - u_reveal));

    // Saturation lens: the sweep pushes the content's own colors more vivid (with
    // a slight contrast/brightness lift toward the crest) instead of painting a
    // theme tint, so the band reads as a pulse of the user's actual UI.
    float lensMix = clamp(intensity * vfade * entryFade * gate, 0.0, 1.0);
    float luma = dot(base, vec3(0.299, 0.587, 0.114));
    vec3 vivid = clamp(mix(vec3(luma), base, SAT_BOOST), 0.0, 1.0);
    vivid = clamp((vivid - 0.5) * 1.06 + 0.5, 0.0, 1.0);
    vivid *= (1.0 + 0.05 * intensity);
    outRGB = mix(base, vivid, lensMix);

    // Glassy specular crest rides the band centre — a content-agnostic white
    // sheen plus a faint fresnel of the vivid content keeps it feeling alive.
    float highMask = band * vfade * entryFade * gate * SWELL_AMOUNT;
    vec3 iris = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + d * 18.0 + tw * 0.8);
    vec3 bandColor = mix(vec3(0.55, 0.82, 1.0), iris, 0.55);
    outRGB = mix(outRGB, bandColor, clamp(lensBand * vfade * entryFade * gate * 0.16, 0.0, 0.20));
    outRGB += (vec3(spec) * 0.85 + bandColor * fresnel * 0.30) * highMask;
  }
  outRGB = clamp(outRGB, 0.0, 1.0);

  gl_FragColor = vec4(outRGB, u_alpha);
}`;

type ShaderGLContext = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  buf: WebGLBuffer;
  tex: WebGLTexture;
  tex2: WebGLTexture;
  labelTex: WebGLTexture | null;
  strengthLoc: WebGLUniformLocation | null;
  timeLoc: WebGLUniformLocation | null;
  alphaLoc: WebGLUniformLocation | null;
  revealLoc: WebGLUniformLocation | null;
};

type GLContext = ShaderGLContext;

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

/**
 * Resolve the app's display serif (Cormorant Garamond) from the overlay's
 * theme CSS vars, falling back to the bundled face.
 */
function getDisplayFontFamily(): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-family-display")
      .trim();
    if (v) return v;
  } catch {
    // overlay may not have computed styles yet; fall through
  }
  return "'Cormorant Garamond', Georgia, serif";
}

/**
 * Render the "Stella is changing..." label centered on a transparent canvas at
 * the morph's pixel size, so it can be uploaded as a texture and composited
 * onto the frosted cover.
 */
function createUpdatingLabelCanvas(
  width: number,
  height: number,
  fillColor: string,
  fontFamily: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const fontPx = Math.round(height * 0.036);
  ctx.font = `italic 400 ${fontPx}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const text = "Stella is changing...";
  const cx = width / 2;
  const cy = height / 2;

  ctx.fillStyle = fillColor;
  ctx.fillText(text, cx, cy);
  return canvas;
}

function uploadTexture(
  gl: WebGLRenderingContext,
  unit: number,
  img: TexImageSource,
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

/**
 * Persistent GL core: the WebGL context, compiled/linked program, geometry
 * buffer, and the sampler/blend/clear state that are IDENTICAL for every
 * morph. Creating the context and compiling+linking the shader is the bulk of
 * per-morph startup cost and it gates the first paint (→ overlay:morphReady),
 * so we build it once per canvas and reuse it across morphs. Only per-morph
 * data (textures, drawing-buffer size, variable uniforms) changes between
 * morphs, so the rendered output is byte-for-byte identical to compiling a
 * fresh program each time.
 */
type ProgramCore = {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  buf: WebGLBuffer;
};

function ensureProgramCore(
  canvas: HTMLCanvasElement,
  coreRef: { current: ProgramCore | null },
): ProgramCore | null {
  const existing = coreRef.current;
  if (
    existing &&
    existing.gl.canvas === canvas &&
    !existing.gl.isContextLost()
  ) {
    return existing;
  }

  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;

  const { prog, vs, fs } = compileProgram(gl, VERT, BLUR_FRAG);

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

  // Sampler bindings, blend mode and clear color are context/program state
  // that survive across morphs — set them once here.
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex2"), 1);
  gl.uniform1i(gl.getUniformLocation(prog, "u_label"), 2);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  const core: ProgramCore = { gl, prog, vs, fs, buf };
  coreRef.current = core;
  return core;
}

/**
 * 1×1 transparent placeholder for TEXTURE1 (u_tex2). The incoming capture only
 * exists at handoff, and the shader never samples u_tex2 while the cover holds
 * (u_reveal is 0, which gates every u_tex2 read out), so there is nothing to
 * show there during cover. This replaces re-uploading the old screenshot a
 * second time at init; the handoff overwrites this texture in place. It keeps
 * the same wrap/filter params loadSecondTexture relies on.
 */
function createPlaceholderTexture(
  gl: WebGLRenderingContext,
  unit: number,
): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.activeTexture(unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

function initShaderGL(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
  coreRef: { current: ProgramCore | null },
  label?: HTMLCanvasElement | null,
): ShaderGLContext | null {
  const core = ensureProgramCore(canvas, coreRef);
  if (!core) return null;
  const { gl, prog, vs, fs, buf } = core;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);
  gl.useProgram(prog);

  const tex = uploadTexture(gl, gl.TEXTURE0, img);
  // TEXTURE1 holds the incoming capture, uploaded at handoff; a tiny
  // placeholder is all that is needed during cover (u_tex2 is gated out while
  // u_reveal is 0).
  const tex2 = createPlaceholderTexture(gl, gl.TEXTURE1);

  // Optional "Stella is changing..." label, uploaded on TEXTURE2 when present.
  let labelTex: WebGLTexture | null = null;
  if (label) {
    labelTex = uploadTexture(gl, gl.TEXTURE2, label);
  }
  gl.activeTexture(gl.TEXTURE0);

  gl.uniform1f(gl.getUniformLocation(prog, "u_has_label"), labelTex ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_alpha"), 1.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_reveal"), 0.0);
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), img.width / img.height);

  return {
    gl,
    prog,
    vs,
    fs,
    buf,
    tex,
    tex2,
    labelTex,
    strengthLoc: gl.getUniformLocation(prog, "u_strength"),
    timeLoc: gl.getUniformLocation(prog, "u_time"),
    alphaLoc: gl.getUniformLocation(prog, "u_alpha"),
    revealLoc: gl.getUniformLocation(prog, "u_reveal"),
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
    gl.uniform1f(
      gl.getUniformLocation(prog, "u_aspect"),
      img.width / img.height,
    );
  }
  gl.activeTexture(gl.TEXTURE0);
}

// Per-morph teardown: delete only this morph's textures. The context,
// compiled program and geometry buffer live in the ProgramCore and are reused
// by the next morph (full teardown happens in destroyProgramCore on unmount).
function cleanupGL(ctx: GLContext) {
  const { gl } = ctx;
  gl.deleteTexture(ctx.tex);
  gl.deleteTexture(ctx.tex2);
  if (ctx.labelTex) gl.deleteTexture(ctx.labelTex);
}

function destroyProgramCore(core: ProgramCore) {
  const { gl, buf, prog, vs, fs } = core;
  gl.deleteBuffer(buf);
  gl.deleteProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
}

function startCoverRenderLoop(
  ctx: ShaderGLContext,
  strengthRef: { current: number },
  alphaRef: { current: number },
  activeTweensRef: { current: number },
  steadyStrengthRef: { current: number },
  timePhaseRef: { current: number },
  revealRef: { current: number },
  startTime: number,
  onFirstFrame?: () => void,
): () => void {
  let running = true;
  let firstFramePainted = false;
  // When no tween is in flight the cover holds steady. The band's edge wave
  // still advances via `u_time`, but humans don't notice a 30Hz cap on it —
  // so we halve GPU load by skipping every other frame. Tweens (cover ramp,
  // handoff sweep) snap back to 60Hz because that's where motion smoothness
  // actually matters.
  let skipNextFrame = false;
  let lastTimestamp = startTime;
  const { gl, strengthLoc, timeLoc, alphaLoc, revealLoc } = ctx;

  const frame = (now: number) => {
    if (!running) return;

    const dtSeconds = Math.max(0, (now - lastTimestamp) / 1000);
    lastTimestamp = now;
    const steady = steadyStrengthRef.current;
    // The band's edge wave eases in/out with cover strength so it stays calm
    // while the frost is still building and decays as the cover lifts.
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

    // clearColor is set once on the ProgramCore and persists across frames.
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(strengthLoc, strengthRef.current);
    gl.uniform1f(timeLoc, timePhaseRef.current);
    gl.uniform1f(alphaLoc, alphaRef.current);
    gl.uniform1f(revealLoc, revealRef.current);
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

type EaseFn = (t: number) => number;

// Symmetric cosine ease-in-out — the default for cover/crossfade tweens.
const easeInOutCosine: EaseFn = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

// Cubic ease-out — fast at the start, decelerating into the target. Used for
// the blur cover ramp so the frost rushes in then settles (clearly non-linear).
const easeOutCubic: EaseFn = (t) => 1 - Math.pow(1 - t, 3);

// CSS-style cubic-bezier(P1,P2) timing function, solved with Newton's method
// on x to recover the curve parameter (matches glimm's implementation).
const cubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EaseFn => {
  const bezX = (t: number) =>
    3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const bezY = (t: number) =>
    3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  const bezXd = (t: number) =>
    3 * (1 - 4 * t + 3 * t * t) * x1 + 3 * (2 * t - 3 * t * t) * x2 + 3 * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = bezX(t) - x;
      if (Math.abs(dx) < 1e-6) break;
      const d = bezXd(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    return bezY(t);
  };
};

// glimm's "snap" sweep curve — cubic-bezier(1, 0, 0.35, 0.95): holds at the
// start, then whips forward.
const bandSweepEase: EaseFn = cubicBezier(1, 0, 0.35, 0.95);

function tweenRef(
  ref: { current: number },
  to: number,
  duration: number,
  activeTweensRef?: { current: number },
  ease: EaseFn = easeInOutCosine,
  // Cancellation token: the tween captures the generation at start and bails
  // if it ever changes (a superseding morph / disposeMorph bumped it). Without
  // this, a tween from a previous morph keeps stepping and writing the shared
  // refs (strength/reveal) that the new morph just reset — e.g. a stale handoff
  // tween would drive revealRef back to 1 and render the new cover as solid
  // black.
  generationRef?: { current: number },
): Promise<void> {
  return new Promise((resolve) => {
    const from = ref.current;
    const start = performance.now();
    const generation = generationRef?.current;
    if (activeTweensRef) activeTweensRef.current += 1;
    const step = () => {
      // Superseded: stop writing the shared ref and stop decrementing. The
      // generation bump already reset activeTweensRef to 0, so decrementing
      // here would push it negative.
      if (generationRef && generationRef.current !== generation) {
        resolve();
        return;
      }
      const t = Math.min((performance.now() - start) / duration, 1);
      const eased = ease(t);
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
  const { colors } = useTheme();
  const [state, setState] = useState<MorphState>(IDLE_STATE);
  const [hmrState, setHmrState] = useState<SelfModHmrState>(IDLE_HMR_STATE);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCtxRef = useRef<GLContext | null>(null);
  // Persistent WebGL context + compiled program, reused across morphs so we
  // don't recreate the context / recompile the shader on every transition.
  const glCoreRef = useRef<ProgramCore | null>(null);
  const activeTransitionIdRef = useRef<string | null>(null);
  const strengthRef = useRef(0);
  const alphaRef = useRef(1);
  const stopLoopRef = useRef<(() => void) | null>(null);
  const loopStartTimeRef = useRef(0);
  const morphReadySentRef = useRef(false);
  const activeMorphFlavorRef = useRef<MorphFlavor>("hmr");
  const activeVisualTimingRef = useRef<MorphVisualTiming>(
    DEFAULT_HMR_VISUAL_TIMING,
  );
  const activeTweensRef = useRef(0);
  // Bumped on every disposeMorph (and thus at the start of every new morph,
  // which disposes first) to cancel any tweens still stepping from a prior
  // morph. See tweenRef's generationRef.
  const tweenGenerationRef = useRef(0);
  const steadyStrengthRef = useRef(MORPH_STEADY_STRENGTH);
  const timePhaseRef = useRef(0);
  // Blur-only: 0 during cover, tweened 0→1 on handoff to drive the band sweep.
  const revealRef = useRef(0);
  // Label fill/font, refreshed with the theme and read at morph start.
  const labelStyleRef = useRef<{
    fill: string;
    font: string;
  }>({
    fill: colors.foreground,
    font: "'Cormorant Garamond', Georgia, serif",
  });
  useEffect(() => {
    labelStyleRef.current = {
      fill: colors.foreground,
      font: getDisplayFontFamily(),
    };
  }, [colors]);

  // Warm Cormorant once so the baked label never falls back to a generic serif
  // family on the first morph.
  useEffect(() => {
    void document.fonts?.load("italic 400 80px 'Cormorant Garamond'");
  }, []);

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
      // Cancel any in-flight tweens before tearing down / starting fresh, and
      // clear the counter so a superseded tween's skipped decrement can't leave
      // it negative. onMorphForward calls this first, so this also runs before
      // the shared refs (strength/reveal) are reset for the new morph.
      tweenGenerationRef.current += 1;
      activeTweensRef.current = 0;
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
        activeVisualTimingRef.current = normalizeVisualTiming(data.timing);
        setHmrState(IDLE_HMR_STATE);
        setState({
          phase: "covering",
          x: data.x,
          y: data.y,
          width: data.width,
          height: data.height,
        });

        const steadyStrength =
          flavor === "onboarding"
            ? ONBOARDING_MORPH_STEADY_STRENGTH
            : MORPH_STEADY_STRENGTH;
        // Start from a clean still frame, then ease into cover strength (the
        // frost radius) so the cover reads as one S-curve: calm → active → calm.
        strengthRef.current = 0;
        alphaRef.current = 1;
        steadyStrengthRef.current = steadyStrength;
        timePhaseRef.current = 0;
        revealRef.current = 0;

        void loadImage(data.screenshotDataUrl).then((img) => {
          if (
            !canvasRef.current ||
            activeTransitionIdRef.current !== data.transitionId
          ) {
            return;
          }
          // The "Stella is changing..." label rides the production self-mod
          // cover; the onboarding demo morph stays unlabeled.
          const label =
            flavor === "hmr"
              ? createUpdatingLabelCanvas(
                  img.width,
                  img.height,
                  labelStyleRef.current.fill,
                  labelStyleRef.current.font,
                )
              : null;
          const ctx = initShaderGL(canvasRef.current, img, glCoreRef, label);
          if (!ctx) return;
          glCtxRef.current = ctx;

          loopStartTimeRef.current = performance.now();
          activeTweensRef.current = 0;
          stopLoopRef.current = startCoverRenderLoop(
            ctx,
            strengthRef,
            alphaRef,
            activeTweensRef,
            steadyStrengthRef,
            timePhaseRef,
            revealRef,
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
            // Frost rushes in then eases to steady (non-linear).
            easeOutCubic,
            tweenGenerationRef,
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

            const handoffMs =
              flavor === "onboarding"
                ? ONBOARDING_MORPH_HANDOFF_FADE_MS
                : normalizeVisualTiming(data.timing).handoffFadeMs;
            loadSecondTexture(ctx, img);
            // Push the (multi-MB) incoming-capture upload to the driver now,
            // while the cover still holds (u_reveal is 0, so the sweep hasn't
            // started), instead of letting it settle lazily on the first sweep
            // frame where it could stall the most motion-critical moment. This
            // only affects upload scheduling, not any rendered pixel.
            ctx.gl.flush();
            alphaRef.current = 1;
            setState((prev) => ({ ...prev, phase: "crossfading" }));

            const finalize = () => {
              if (data.transitionId !== activeTransitionIdRef.current) {
                return;
              }
              morphReadySentRef.current = false;
              window.electronAPI?.overlay.morphDone(data.transitionId);
              disposeMorph();
              activeTransitionIdRef.current = null;
              setState(IDLE_STATE);
            };

            // Reveal the new state behind a left→right band sweep (`u_reveal`
            // drives the band position; the band acts as a saturation lens).
            revealRef.current = 0;
            return tweenRef(
              revealRef,
              1.0,
              handoffMs,
              activeTweensRef,
              bandSweepEase,
              tweenGenerationRef,
            ).then(finalize);
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
      disposeMorph();
      if (glCoreRef.current) {
        destroyProgramCore(glCoreRef.current);
        glCoreRef.current = null;
      }
    };
  }, []);

  // The canvas stays mounted even when idle (just hidden) so its WebGL context
  // and compiled shader program survive between morphs — that's what lets
  // initShaderGL reuse the ProgramCore instead of recreating it each morph.
  // React would otherwise create a fresh canvas element (and a fresh context)
  // on every remount.
  const idle = state.phase === "idle";

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
        display: idle ? "none" : undefined,
      }}
    />
  );
}
