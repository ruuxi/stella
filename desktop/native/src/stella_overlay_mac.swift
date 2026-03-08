// ════════════════════════════════════════════════════════════════════════════
//  Stella Native Overlay — macOS
//  Metal + NSWindow transparent always-on-top overlay.
//  Renders: radial blob, voice creature, morph transition, region capture.
//  IPC: stdin/stdout JSON lines with Electron main process.
// ════════════════════════════════════════════════════════════════════════════

import Cocoa
import Metal
import MetalKit
import QuartzCore

// ════════════════════════════════════════════════════════════════════════════
//  Section 1 — Metal shaders (MSL)
// ════════════════════════════════════════════════════════════════════════════

let SHADER_SOURCE = """
#include <metal_stdlib>
using namespace metal;

struct VertexOut {
    float4 position [[position]];
    float2 uv;
};

vertex VertexOut vs_main(uint vid [[vertex_id]]) {
    VertexOut out;
    out.uv = float2((vid << 1) & 2, vid & 2);
    out.position = float4(out.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return out;
}

float glmod(float x, float y) { return x - y * floor(x / y); }

// ── Radial blob ──────────────────────────────────────────────────────────

struct BlobCB {
    float progress, leadP, lagP, morph;
    float time, selIdx;
    float2 _pad0;
    float4 fills[5];
    float4 selFill;
    float4 centerBg;
    float4 stroke;
};

fragment float4 blob_ps(VertexOut in [[stage_in]], constant BlobCB &cb [[buffer(0)]]) {
    constexpr float PI  = 3.14159265;
    constexpr float TAU = 6.28318530;
    constexpr float WEDGE_ANG = TAU / 5.0;
    constexpr float INNER_R  = 40.0  / 280.0;
    constexpr float OUTER_R  = 125.0 / 280.0;
    constexpr float CENTER_R = 35.0  / 280.0;

    float2 p = in.uv - 0.5;
    float dist  = length(p);
    float angle = atan2(p.y, p.x);
    float topAngle = glmod(angle + PI * 0.5, TAU);

    int   wi    = int(floor(topAngle / WEDGE_ANG));
    float wFrac = fract(topAngle / WEDGE_ANG);

    float wobble = sin(angle * 3.0 + cb.time * 1.5) * 0.012
                 + sin(angle * 5.0 - cb.time * 2.0) * 0.008
                 + sin(angle * 2.0 + 0.5) * 0.018
                 + sin(angle * 4.0 - 1.3) * 0.006;
    wobble *= (1.0 - cb.morph * 0.85);

    float asym = sin(angle * 2.3 + 0.7) * 0.035
               + sin(angle * 1.0 - 0.4) * 0.02;
    asym *= (1.0 - cb.morph * 0.9);

    float outerR  = cb.lagP * OUTER_R * (1.0 + asym) + wobble * cb.lagP;
    float innerT  = saturate((cb.progress - 0.4) / 0.6);
    float innerR  = innerT * INNER_R;
    float centerT = saturate((cb.leadP - 0.25) / 0.75);
    float centerR = centerT * CENTER_R;
    float soft    = mix(0.022, 0.004, cb.morph);

    float outerMask  = smoothstep(outerR  + soft,        outerR  - soft,        dist);
    float innerMask  = smoothstep(innerR  - soft * 0.5,  innerR  + soft * 0.5,  dist);
    float centerMask = smoothstep(centerR + soft * 0.4,  centerR - soft * 0.4,  dist);
    float ring = outerMask * innerMask;

    float3 wc = cb.fills[clamp(wi, 0, 4)].xyz;

    if (cb.selIdx >= 0.0 && abs(float(wi) - cb.selIdx) < 0.5)
        wc = cb.selFill.xyz;

    float3 avg = (cb.fills[0].xyz + cb.fills[1].xyz + cb.fills[2].xyz
                + cb.fills[3].xyz + cb.fills[4].xyz) * 0.2;
    float3 ringColor = mix(avg, wc, cb.morph);

    float bDist  = min(wFrac, 1.0 - wFrac);
    float bWidth = 0.006 / max(dist * 5.0, 0.01);
    float bLine  = smoothstep(0.0, bWidth, bDist);
    ringColor = mix(cb.stroke.xyz, ringColor, mix(1.0, bLine, cb.morph * 0.6));

    float3 color = ringColor;
    float  alpha = ring;
    color = mix(color, cb.centerBg.xyz, centerMask);
    alpha = max(alpha, centerMask);

    return float4(color * alpha, alpha);
}

// ── Voice creature ───────────────────────────────────────────────────────

struct CreatureCB {
    float2 canvasSize;
    float2 gridSize;
    float  time;
    float  charCount;
    float  birth;
    float  flash;
    float  listening;
    float  speaking;
    float  voiceEnergy;
    float  _pad;
    float4 colors[5];
};

float computePhases(float d, float a, float w1, float w2, float w3, float time) {
    float i1 = 0.0;
    if (w1 > 0.01 && d >= 0.15) {
        float so  = 1.0 / (d + 0.05);
        float wv1 = sin(a * 3.0 + so * 2.0 - time * 3.0);
        float wv2 = cos(a * 5.0 - so * 3.0 + time * 2.0);
        float fo  = max(0.0, 1.0 - (d - 0.15) * 1.5);
        float dk  = exp(-pow((d - 0.3) * 10.0, 2.0)) * 0.8;
        i1 = ((wv1 + wv2) * 0.5 + 0.5) * fo + dk;
    }
    float i2 = 0.0;
    if (w2 > 0.01) {
        float t1 = time * 2.0;
        float p1 = sin(t1) * 0.5 + 0.5;
        float p2 = sin(t1 + 2.094) * 0.5 + 0.5;
        float p3 = sin(t1 + 4.188) * 0.5 + 0.5;
        float s1 = exp(-abs(glmod(a + 0.0,   6.283) - 3.14) * 1.5) * p1;
        float s2 = exp(-abs(glmod(a + 2.094, 6.283) - 3.14) * 1.5) * p2;
        float s3 = exp(-abs(glmod(a + 4.188, 6.283) - 3.14) * 1.5) * p3;
        float rw  = sin(d * 10.0 - time * 3.0) * 0.3 + 0.7;
        float rays = max(max(s1, s2), s3) * rw;
        float c2 = exp(-d * 4.0) * 0.8;
        float f2 = max(0.0, 1.0 - d * 0.8);
        i2 = rays * f2 + c2;
    }
    float i3 = 0.0;
    if (w3 > 0.01) {
        float br = sin(time * 0.4) * 0.5 + 0.5;
        float pt = sin(a * 7.0 + d * 8.0 + time * 0.5) * 0.5 + 0.5;
        pt *= exp(-d * 1.0);
        float fm = sin(a * 3.0 - time * 0.3) * 0.5 + 0.5;
        fm *= sin(d * 12.0 - time * 1.2) * 0.5 + 0.5;
        fm *= exp(-d * 1.5);
        float sf = exp(-d * 3.5) * (0.7 + br * 0.3);
        i3 = sf + mix(pt, fm, br) * 0.5;
    }
    return i1 * w1 + i2 * w2 + i3 * w3;
}

fragment float4 creature_ps(VertexOut in [[stage_in]],
                            constant CreatureCB &cb [[buffer(0)]],
                            texture2d<float> glyph [[texture(0)]],
                            sampler glyphSmp [[sampler(0)]]) {
    float2 c = (in.uv - 0.5) * 1.2;
    c.x *= cb.canvasSize.x / cb.canvasSize.y;
    float dist = length(c) * 2.0;
    if (dist > 2.0) return float4(0, 0, 0, 0);

    float angle = atan2(c.y, c.x);

    float cycle = cb.time * 0.15;
    float phase = glmod(cycle, 3.0);
    float w1 = max(0.0, 1.0 - abs(phase - 0.0)) + max(0.0, 1.0 - abs(phase - 3.0));
    float w2 = max(0.0, 1.0 - abs(phase - 1.0));
    float w3 = max(0.0, 1.0 - abs(phase - 2.0));
    float total = w1 + w2 + w3;
    w1 /= total; w2 /= total; w3 /= total;

    float intensity = computePhases(dist, angle, w1, w2, w3, cb.time);

    if (cb.listening > 0.01) {
        float sd = dist * (1.0 + cb.listening * 0.5);
        float si = computePhases(sd, angle, w1, w2, w3, cb.time);
        intensity = mix(intensity, si, cb.listening);
        float rings = sin(dist * 20.0 + cb.time * 5.0) * 0.5 + 0.5;
        rings *= smoothstep(0.5, 0.1, dist);
        intensity += rings * cb.listening * 0.3;
        intensity *= 1.0 + cb.voiceEnergy * cb.listening * 0.8;
    }
    if (cb.speaking > 0.01) {
        float ed = dist / (1.0 + cb.speaking * 0.08 + cb.voiceEnergy * 0.12);
        float ei = computePhases(ed, angle, w1, w2, w3, cb.time);
        intensity = mix(intensity, ei, cb.speaking);
        float waves = sin(dist * 10.0 - cb.time * 8.0) * 0.5 + 0.5;
        waves *= smoothstep(1.2, 0.1, dist) * cb.voiceEnergy;
        intensity += waves * cb.speaking * 0.4;
        intensity *= 1.0 + cb.speaking * cb.voiceEnergy * 0.4;
    }
    intensity = min(intensity, 1.0);

    float birthRadius = cb.birth * 1.5;
    float birthEdge   = smoothstep(birthRadius, birthRadius - 0.3, dist);
    float smallness   = 1.0 - cb.birth;
    float pulseSpeed  = 5.0 + smallness * 2.0;
    float pulseStr    = smallness * 0.5;
    float birthPulse  = 1.0 + sin(dist * 25.0 - cb.time * pulseSpeed) * pulseStr;
    float breathe2    = 1.0 + sin(cb.time * 1.5) * 0.15 * smallness;
    intensity *= birthEdge * birthPulse * breathe2;
    intensity *= sqrt(cb.birth);

    float charIndex = floor(intensity * (cb.charCount - 1.0));
    float2 cellLocal = fract(in.uv * cb.gridSize);
    float2 glyphUV   = float2((cellLocal.x + charIndex) / cb.charCount, cellLocal.y);
    float  glyphAlpha = glyph.sample(glyphSmp, glyphUV).a;

    float colorPos = clamp(intensity * 4.0, 0.0, 3.999);
    float ci = floor(colorPos);
    float cf = smoothstep(0.0, 1.0, colorPos - ci);
    float3 color;
    if      (ci < 1.0) color = mix(cb.colors[0].xyz, cb.colors[1].xyz, cf);
    else if (ci < 2.0) color = mix(cb.colors[1].xyz, cb.colors[2].xyz, cf);
    else if (ci < 3.0) color = mix(cb.colors[2].xyz, cb.colors[3].xyz, cf);
    else               color = mix(cb.colors[3].xyz, cb.colors[4].xyz, cf);

    float luma = dot(color, float3(0.299, 0.587, 0.114));
    float sat  = mix(0.55, 1.4, 1.0 - intensity);
    color = mix(float3(luma), color, sat);
    float warm = 1.0 - intensity;
    color *= float3(1.0 + warm * 0.2, 1.0 + warm * 0.07, 1.0 - warm * 0.1);

    float waveRadius    = (1.0 - cb.flash) * 1.8;
    float waveWidth     = 0.3;
    float waveDist      = abs(dist - waveRadius);
    float waveIntensity = smoothstep(waveWidth, 0.0, waveDist) * cb.flash;
    color *= 1.0 + waveIntensity * 2.0;

    float4 result = float4(color * glyphAlpha, glyphAlpha);

    // Eyes
    float eyeGap = 5.0 / cb.gridSize.x;
    float eyeUp  = 2.5 / cb.gridSize.y;
    float eyeAngle = -cb.time * 2.5;
    float2 drift1 = float2(cos(eyeAngle), sin(eyeAngle)) * 1.1;

    float et  = cb.time * 2.0;
    float ep1 = sin(et)         * 0.5 + 0.5;
    float ep2 = sin(et + 2.094) * 0.5 + 0.5;
    float ep3 = sin(et + 4.188) * 0.5 + 0.5;
    float epSum = ep1 + ep2 + ep3;
    float2 drift2 = (float2(1.0, 0.0) * ep1
                   + float2(-0.5,  0.866) * ep2
                   + float2(-0.5, -0.866) * ep3) / epSum * 1.8;
    float2 drift3 = float2(0.0, -sin(cb.time * 0.4)) * 0.9;
    float2 eyeDrift = drift1 * w1 + drift2 * w2 + drift3 * w3;
    float2 eyeOrigin = float2(0.5 + eyeDrift.x / cb.gridSize.x,
                               0.5 - eyeUp + eyeDrift.y / cb.gridSize.y);

    float blinkSlot  = floor(cb.time / 0.8);
    float blinkHash  = fract(sin(blinkSlot * 91.7) * 43758.5453);
    float blinkLocal = fract(cb.time / 0.8);
    float doBlink    = step(0.65, blinkHash);
    float bt = saturate(blinkLocal / 0.1);
    float blinkCurve = smoothstep(0.0, 1.0, abs(bt * 2.0 - 1.0));
    float blink = mix(1.0, blinkCurve, doBlink);

    float dblHash  = fract(sin(blinkSlot * 73.3) * 28461.7);
    float doDouble = step(0.8, dblHash) * doBlink;
    float bt2 = saturate((blinkLocal - 0.15) / 0.1);
    float dblCurve = smoothstep(0.0, 1.0, abs(bt2 * 2.0 - 1.0));
    blink *= mix(1.0, dblCurve, doDouble);

    float2 eyeHalf = float2(1.0 / cb.gridSize.x, 1.5 / cb.gridSize.y * blink);
    float leftEye  = step(abs(in.uv.x - eyeOrigin.x + eyeGap), eyeHalf.x)
                   * step(abs(in.uv.y - eyeOrigin.y), eyeHalf.y);
    float rightEye = step(abs(in.uv.x - eyeOrigin.x - eyeGap), eyeHalf.x)
                   * step(abs(in.uv.y - eyeOrigin.y), eyeHalf.y);
    float eyeMask = max(leftEye, rightEye) * smoothstep(0.3, 0.6, cb.birth);
    result = mix(result, float4(cb.colors[4].xyz, 1.0), eyeMask);

    // Mouth
    float2 mouthPos = float2(eyeOrigin.x, eyeOrigin.y + 3.5 / cb.gridSize.y);
    float mouthSlot = floor(cb.time / 2.5);
    float mouthHash = fract(sin(mouthSlot * 47.3)  * 31718.9);
    float shapeHash = fract(sin(mouthSlot * 113.1) * 18734.3);
    float mouthLocal = fract(cb.time / 2.5);
    float doOpen = step(0.70, mouthHash);

    float isO     = (1.0 - step(0.2, shapeHash));
    float isSmile = step(0.2, shapeHash) * (1.0 - step(0.4, shapeHash));
    float isFrown = step(0.4, shapeHash) * (1.0 - step(0.6, shapeHash));
    float isSideV = step(0.6, shapeHash) * (1.0 - step(0.8, shapeHash));
    float isDash  = step(0.8, shapeHash);

    float openUp    = smoothstep(0.0, 0.08, mouthLocal);
    float closeDown = 1.0 - smoothstep(0.6, 0.8, mouthLocal);
    float mouthAnim = openUp * closeDown * doOpen;

    float2 md = (in.uv - mouthPos) * cb.gridSize;
    float lineW = 0.5;
    float mouthShape = 0.0;

    if (isO > 0.5) {
        float2 mdO = md;
        mdO.y /= max(mouthAnim, 0.15);
        float oDist = length(mdO);
        mouthShape = smoothstep(1.8, 1.5, oDist) * smoothstep(0.5, 0.8, oDist);
    } else if (isSmile > 0.5) {
        float sd2 = abs(md.y - 0.6 + 0.7 * abs(md.x));
        mouthShape = (1.0 - smoothstep(lineW * 0.5, lineW, sd2)) * step(abs(md.x), 1.8);
    } else if (isFrown > 0.5) {
        float fd = abs(md.y + 0.6 - 0.7 * abs(md.x));
        mouthShape = (1.0 - smoothstep(lineW * 0.5, lineW, fd)) * step(abs(md.x), 1.8);
    } else if (isSideV > 0.5) {
        float svd = abs(md.x - 0.8 + 0.6 * abs(md.y));
        mouthShape = (1.0 - smoothstep(lineW * 0.5, lineW, svd)) * step(abs(md.y), 1.2);
    } else if (isDash > 0.5) {
        mouthShape = (1.0 - smoothstep(lineW * 0.3, lineW * 0.7, abs(md.y))) * step(abs(md.x), 1.5);
    }
    mouthShape *= smoothstep(0.05, 0.2, mouthAnim);
    float mouthMask = mouthShape * smoothstep(0.3, 0.6, cb.birth);
    result = mix(result, float4(cb.colors[4].xyz, 1.0), mouthMask);

    return float4(result.rgb * result.a, result.a);
}

// ── Morph transition ─────────────────────────────────────────────────────

struct MorphCB {
    float  mixVal, strength, time, aspect;
    float2 center;
    float2 _pad;
    float4 color1, color2, color3, color4;
};

float4 sampleChroma(texture2d<float> tex, sampler s, float2 uv, float2 cd, float chr) {
    float r = tex.sample(s, clamp(uv + cd * chr, 0.0, 1.0)).r;
    float g = tex.sample(s, clamp(uv,            0.0, 1.0)).g;
    float b = tex.sample(s, clamp(uv - cd * chr, 0.0, 1.0)).b;
    float a = tex.sample(s, clamp(uv,            0.0, 1.0)).a;
    return float4(r, g, b, a);
}

fragment float4 morph_ps(VertexOut in [[stage_in]],
                         constant MorphCB &cb [[buffer(0)]],
                         texture2d<float> tex1 [[texture(0)]],
                         texture2d<float> tex2 [[texture(1)]],
                         sampler smp [[sampler(0)]]) {
    float2 uv = float2(in.uv.x, 1.0 - in.uv.y);

    float2 d = uv - cb.center;
    d.x *= cb.aspect;
    float dist = length(d);

    float ripple = sin(dist * 6.0 - cb.time * 4.0) * cb.strength * 0.012;
    ripple *= smoothstep(0.0, 0.35, dist) * (1.0 - smoothstep(0.6, 1.0, dist));
    float warp = sin(dist * 3.0 + cb.time * 2.0) * cb.strength * 0.02
               * smoothstep(0.0, 0.3, dist);

    float2 offset = normalize(d + float2(0.001, 0.001)) * (ripple + warp);
    offset.x /= cb.aspect;
    float2 suv = uv + offset;

    float  chromatic = cb.strength * 0.003;
    float2 chromDir  = normalize(d + float2(0.001, 0.001));
    chromDir.x /= cb.aspect;

    float4 col1 = sampleChroma(tex1, smp, suv, chromDir, chromatic);
    float4 col2 = sampleChroma(tex2, smp, suv, chromDir, chromatic);
    float4 col  = mix(col1, col2, cb.mixVal);

    float dx = 0.002 * cb.strength;
    float lumC = dot(col.rgb, float3(0.299, 0.587, 0.114));
    float lumR = dot(tex1.sample(smp, clamp(suv + float2(dx, 0), 0.0, 1.0)).rgb,
                     float3(0.299, 0.587, 0.114));
    float lumU = dot(tex1.sample(smp, clamp(suv + float2(0, dx), 0.0, 1.0)).rgb,
                     float3(0.299, 0.587, 0.114));
    float edge = length(float2(lumR - lumC, lumU - lumC));

    float angle = atan2(d.y, d.x);
    float colorPhase = fract(angle / 6.2832 + cb.time * 0.3) * 4.0;
    float3 tint = mix(cb.color1.xyz, cb.color2.xyz, smoothstep(0.0, 1.0, colorPhase));
    tint = mix(tint, cb.color3.xyz, smoothstep(1.0, 2.0, colorPhase));
    tint = mix(tint, cb.color4.xyz, smoothstep(2.0, 3.0, colorPhase));
    tint = mix(tint, cb.color1.xyz, smoothstep(3.0, 4.0, colorPhase));

    float colorMask = smoothstep(0.02, 0.08, edge) * cb.strength * 0.35;
    col.rgb = mix(col.rgb, tint, colorMask);
    return col;
}

// ── Region capture ───────────────────────────────────────────────────────

struct RegionCB {
    float2 resolution;
    float2 selectMin, selectMax;
    float dimAlpha, hasSelection;
};

fragment float4 region_ps(VertexOut in [[stage_in]], constant RegionCB &cb [[buffer(0)]]) {
    float2 pixel = in.uv * cb.resolution;
    if (cb.hasSelection > 0.5) {
        bool inside = pixel.x >= cb.selectMin.x && pixel.x <= cb.selectMax.x &&
                      pixel.y >= cb.selectMin.y && pixel.y <= cb.selectMax.y;
        if (inside) {
            float bw = 1.5;
            bool onBorder = pixel.x < cb.selectMin.x + bw || pixel.x > cb.selectMax.x - bw ||
                           pixel.y < cb.selectMin.y + bw || pixel.y > cb.selectMax.y - bw;
            if (onBorder) { float a = 0.7; return float4(a, a, a, a); }
            return float4(0, 0, 0, 0);
        }
    }
    float a = cb.dimAlpha;
    return float4(0, 0, 0, a);
}
"""

// ════════════════════════════════════════════════════════════════════════════
//  Section 2 — CB structs (Swift side, matching Metal)
// ════════════════════════════════════════════════════════════════════════════

struct BlobCBData {
    var progress: Float = 0, leadP: Float = 0, lagP: Float = 0, morph: Float = 0
    var time: Float = 0, selIdx: Float = -1, _pad0: (Float, Float) = (0, 0)
    var fills: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>) = (.zero, .zero, .zero, .zero, .zero)
    var selFill: SIMD4<Float> = .zero
    var centerBg: SIMD4<Float> = .zero
    var stroke: SIMD4<Float> = .zero
}

struct CreatureCBData {
    var canvasSize: SIMD2<Float> = .zero
    var gridSize: SIMD2<Float> = .zero
    var time: Float = 0, charCount: Float = 10, birth: Float = 1, flash: Float = 0
    var listening: Float = 0, speaking: Float = 0, voiceEnergy: Float = 0, _pad: Float = 0
    var colors: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>) = (
        SIMD4(0.47, 0.63, 0.97, 0), SIMD4(0.73, 0.60, 0.97, 0),
        SIMD4(0.49, 0.81, 1.00, 0), SIMD4(0.62, 0.81, 0.42, 0),
        SIMD4(1.00, 0.95, 0.80, 0)
    )
}

struct MorphCBData {
    var mixVal: Float = 0, strength: Float = 0, time: Float = 0, aspect: Float = 1
    var center: SIMD2<Float> = SIMD2(0.5, 0.5), _pad: SIMD2<Float> = .zero
    var color1: SIMD4<Float> = SIMD4(0.48, 0.64, 0.97, 0)
    var color2: SIMD4<Float> = SIMD4(0.73, 0.60, 0.97, 0)
    var color3: SIMD4<Float> = SIMD4(0.49, 0.81, 1.00, 0)
    var color4: SIMD4<Float> = SIMD4(0.62, 0.81, 0.42, 0)
}

struct RegionCBData {
    var resolution: SIMD2<Float> = .zero
    var selectMin: SIMD2<Float> = .zero, selectMax: SIMD2<Float> = .zero
    var dimAlpha: Float = 0.35, hasSelection: Float = 0
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 3 — Application state
// ════════════════════════════════════════════════════════════════════════════

enum BlobAnimState { case idle, opening, settled, closing }
enum MorphPhase { case idle, rippling, crossfading, calming }

class OverlayState {
    // Window
    var window: NSWindow?
    var winX: CGFloat = 0, winY: CGFloat = 0, winW: CGFloat = 1920, winH: CGFloat = 1080
    var interactive = false

    // Metal
    var device: MTLDevice!
    var commandQueue: MTLCommandQueue!
    var metalLayer: CAMetalLayer!
    var blobPipeline: MTLRenderPipelineState!
    var creaturePipeline: MTLRenderPipelineState!
    var morphPipeline: MTLRenderPipelineState!
    var regionPipeline: MTLRenderPipelineState!
    var nearestSampler: MTLSamplerState!
    var linearSampler: MTLSamplerState!

    // Textures
    var glyphAtlas: MTLTexture?
    var morphTex1: MTLTexture?, morphTex2: MTLTexture?

    // Radial blob
    var blobAnim: BlobAnimState = .idle
    var blobStart: Double = 0
    var blobSelIdx: Float = -1
    var blobScreenX: Float = 0, blobScreenY: Float = 0, blobSize: Float = 280
    var blobData = BlobCBData()

    // Voice creature
    var creatureActive = false
    var creatureX: Float = 0, creatureY: Float = 0
    var creatureW: Float = 168, creatureH: Float = 168
    var creatureGridW: Float = 20, creatureGridH: Float = 20
    var creatureBirth: Float = 1, creatureFlash: Float = 0
    var creatureListening: Float = 0, creatureSpeaking: Float = 0, creatureVoiceEnergy: Float = 0
    var creatureStartTime: Double = 0
    var creatureColors: [SIMD4<Float>] = [
        SIMD4(0.47, 0.63, 0.97, 0), SIMD4(0.73, 0.60, 0.97, 0),
        SIMD4(0.49, 0.81, 1.00, 0), SIMD4(0.62, 0.81, 0.42, 0),
        SIMD4(1.00, 0.95, 0.80, 0),
    ]

    // Morph
    var morphPhase: MorphPhase = .idle
    var morphX: Float = 0, morphY: Float = 0, morphW: Float = 0, morphH: Float = 0
    var morphMix: Float = 0, morphStrength: Float = 0
    var morphPhaseStart: Double = 0, morphStartTime: Double = 0
    var morphColors: [SIMD4<Float>] = [
        SIMD4(0.48, 0.64, 0.97, 0), SIMD4(0.73, 0.60, 0.97, 0),
        SIMD4(0.49, 0.81, 1.00, 0), SIMD4(0.62, 0.81, 0.42, 0),
    ]

    // Region capture
    var regionActive = false, regionDragging = false
    var regionStartX: Float = 0, regionStartY: Float = 0
    var regionCurX: Float = 0, regionCurY: Float = 0

    // Lifecycle
    var running = true
    var renderTimer: Timer?

    // Coordinate conversion: primary screen height for Y-flip
    var primaryScreenHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }
}

let g = OverlayState()

// ════════════════════════════════════════════════════════════════════════════
//  Section 4 — JSON helpers + IPC
// ════════════════════════════════════════════════════════════════════════════

func sendJson(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str = String(data: data, encoding: .utf8) else { return }
    print(str)
    fflush(stdout)
}

func jsonStr(_ dict: [String: Any], _ key: String) -> String {
    dict[key] as? String ?? ""
}

func jsonNum(_ dict: [String: Any], _ key: String, _ def: Double = 0) -> Double {
    (dict[key] as? NSNumber)?.doubleValue ?? def
}

func jsonBool(_ dict: [String: Any], _ key: String) -> Bool {
    dict[key] as? Bool ?? false
}

func jsonFloatArray(_ dict: [String: Any], _ key: String) -> [Float] {
    (dict[key] as? [NSNumber])?.map { $0.floatValue } ?? []
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 5 — Math helpers
// ════════════════════════════════════════════════════════════════════════════

func springEase(_ t: Double) -> Double {
    if t <= 0 { return 0 }
    let zeta = 0.58, omega = 28.0
    let omegaD = omega * sqrt(1 - zeta * zeta)
    return 1.0 - exp(-zeta * omega * t) *
        (cos(omegaD * t) + (zeta * omega / omegaD) * sin(omegaD * t))
}

func nowMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 6 — Metal initialization
// ════════════════════════════════════════════════════════════════════════════

func initMetal() -> Bool {
    guard let device = MTLCreateSystemDefaultDevice() else { return false }
    g.device = device
    g.commandQueue = device.makeCommandQueue()

    guard let library = try? device.makeLibrary(source: SHADER_SOURCE, options: nil) else {
        fputs("Failed to compile Metal shaders\n", stderr)
        return false
    }
    let vs = library.makeFunction(name: "vs_main")!

    func makePipeline(_ fsName: String) -> MTLRenderPipelineState? {
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vs
        desc.fragmentFunction = library.makeFunction(name: fsName)
        let ca = desc.colorAttachments[0]!
        ca.pixelFormat = .bgra8Unorm
        ca.isBlendingEnabled = true
        ca.sourceRGBBlendFactor = .one
        ca.destinationRGBBlendFactor = .oneMinusSourceAlpha
        ca.rgbBlendOperation = .add
        ca.sourceAlphaBlendFactor = .one
        ca.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        ca.alphaBlendOperation = .add
        return try? device.makeRenderPipelineState(descriptor: desc)
    }

    g.blobPipeline     = makePipeline("blob_ps")
    g.creaturePipeline = makePipeline("creature_ps")
    g.morphPipeline    = makePipeline("morph_ps")
    g.regionPipeline   = makePipeline("region_ps")

    // Samplers
    let nearDesc = MTLSamplerDescriptor()
    nearDesc.minFilter = .nearest; nearDesc.magFilter = .nearest
    nearDesc.sAddressMode = .clampToEdge; nearDesc.tAddressMode = .clampToEdge
    g.nearestSampler = device.makeSamplerState(descriptor: nearDesc)

    let linDesc = MTLSamplerDescriptor()
    linDesc.minFilter = .linear; linDesc.magFilter = .linear
    linDesc.sAddressMode = .clampToEdge; linDesc.tAddressMode = .clampToEdge
    g.linearSampler = device.makeSamplerState(descriptor: linDesc)

    return true
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 7 — Glyph atlas + texture loading
// ════════════════════════════════════════════════════════════════════════════

func createGlyphAtlas() {
    let dotCount = 10, gw = 20, gh = 20
    let atlasW = gw * dotCount, atlasH = gh
    var pixels = [UInt8](repeating: 0, count: atlasW * atlasH * 4)

    let maxR = Float(min(gw, gh)) * 0.45
    for i in 1..<dotCount {
        let t = Float(i) / Float(dotCount - 1)
        let radius = maxR * powf(t, 0.7)
        if radius < 0.5 { continue }
        let cx = Float(i * gw + gw / 2), cy = Float(gh / 2)
        for py in 0..<atlasH {
            for px in (i * gw)..<((i + 1) * gw) {
                let dx = Float(px) + 0.5 - cx, dy = Float(py) + 0.5 - cy
                if sqrtf(dx * dx + dy * dy) <= radius {
                    let idx = (py * atlasW + px) * 4
                    pixels[idx] = 255; pixels[idx+1] = 255
                    pixels[idx+2] = 255; pixels[idx+3] = 255
                }
            }
        }
    }

    let desc = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: .rgba8Unorm, width: atlasW, height: atlasH, mipmapped: false)
    desc.usage = .shaderRead
    g.glyphAtlas = g.device.makeTexture(descriptor: desc)
    g.glyphAtlas?.replace(region: MTLRegionMake2D(0, 0, atlasW, atlasH),
                          mipmapLevel: 0, withBytes: pixels, bytesPerRow: atlasW * 4)
}

func loadTextureFromFile(_ path: String) -> MTLTexture? {
    guard let image = NSImage(contentsOfFile: path),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let w = cgImage.width, h = cgImage.height
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &pixels, width: w, height: h,
                              bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))

    let desc = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: false)
    desc.usage = .shaderRead
    let tex = g.device.makeTexture(descriptor: desc)
    tex?.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0,
                 withBytes: pixels, bytesPerRow: w * 4)
    return tex
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 8 — Animation updates
// ════════════════════════════════════════════════════════════════════════════

func updateBlobAnimation(_ now: Double) {
    switch g.blobAnim {
    case .opening:
        let s = (now - g.blobStart) / 1000
        g.blobData.progress = Float(springEase(s))
        g.blobData.leadP    = Float(springEase(s + 0.035))
        g.blobData.lagP     = Float(springEase(s - 0.020))
        g.blobData.morph    = powf(max(0, Float(springEase(s - 0.06))), 1.3)
        g.blobData.time     = Float(s)
        if s * 1000 >= 420 { g.blobAnim = .settled }

    case .closing:
        let elapsed = now - g.blobStart
        let t = Float(min(elapsed / 180, 1))
        let eased = t * t
        g.blobData.progress = 1 - eased
        g.blobData.lagP  = 1 - powf(min(t * 1.15, 1), 2)
        g.blobData.leadP = 1 - powf(max(0, t - 0.08), 2) / (0.92 * 0.92)
        g.blobData.morph = max(0, g.blobData.progress - 0.15) / 0.85
        g.blobData.time  = t * 0.2
        if t >= 1 {
            g.blobAnim = .idle
            sendJson(["event": "radial_anim_done"])
        }

    default: break
    }
}

let MORPH_RAMP_MS  = 600.0
let MORPH_FADE_MS  = 800.0
let MORPH_CALM_MS  = 600.0

func cosEase(_ t: Double) -> Double { 0.5 - 0.5 * cos(.pi * t) }

func updateMorphAnimation(_ now: Double) {
    guard g.morphPhase != .idle else { return }
    let phaseElapsed = now - g.morphPhaseStart

    switch g.morphPhase {
    case .rippling:
        g.morphStrength = Float(cosEase(min(phaseElapsed / MORPH_RAMP_MS, 1)))
    case .crossfading:
        let t = min(phaseElapsed / MORPH_FADE_MS, 1)
        g.morphMix = Float(cosEase(t))
        if t >= 1 { g.morphPhase = .calming; g.morphPhaseStart = now }
    case .calming:
        let t = min(phaseElapsed / MORPH_CALM_MS, 1)
        g.morphStrength = 1 - Float(cosEase(t))
        if t >= 1 {
            g.morphPhase = .idle
            sendJson(["event": "morph_done"])
            g.morphTex1 = nil; g.morphTex2 = nil
        }
    default: break
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 9 — Rendering
// ════════════════════════════════════════════════════════════════════════════

func isAnyActive() -> Bool {
    g.blobAnim != .idle || g.creatureActive || g.morphPhase != .idle || g.regionActive
}

func setViewport(_ encoder: MTLRenderCommandEncoder, _ x: Float, _ y: Float, _ w: Float, _ h: Float) {
    // Convert from IPC coordinates (Electron top-left origin) to overlay-local
    let localX = Double(x) - Double(g.winX)
    let localY = Double(y) - Double(g.winY)
    encoder.setViewport(MTLViewport(originX: localX, originY: localY,
                                    width: Double(w), height: Double(h), znear: 0, zfar: 1))
}

func renderFrame() {
    guard let drawable = g.metalLayer.nextDrawable() else { return }
    let now = nowMs()

    updateBlobAnimation(now)
    updateMorphAnimation(now)
    if g.creatureFlash > 0.001 { g.creatureFlash = max(0, g.creatureFlash - Float(16.0 / 1200.0)) }

    let rpd = MTLRenderPassDescriptor()
    rpd.colorAttachments[0].texture = drawable.texture
    rpd.colorAttachments[0].loadAction = .clear
    rpd.colorAttachments[0].storeAction = .store
    rpd.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)

    guard let cmdBuf = g.commandQueue.makeCommandBuffer(),
          let enc = cmdBuf.makeRenderCommandEncoder(descriptor: rpd) else { return }

    // Region capture (fullscreen dim)
    if g.regionActive {
        var cb = RegionCBData()
        cb.resolution = SIMD2(Float(g.winW), Float(g.winH))
        cb.dimAlpha = 0.35
        if g.regionDragging {
            cb.selectMin = SIMD2(min(g.regionStartX, g.regionCurX),
                                 min(g.regionStartY, g.regionCurY))
            cb.selectMax = SIMD2(max(g.regionStartX, g.regionCurX),
                                 max(g.regionStartY, g.regionCurY))
            cb.hasSelection = 1
        }
        enc.setViewport(MTLViewport(originX: 0, originY: 0,
                                    width: Double(g.winW), height: Double(g.winH), znear: 0, zfar: 1))
        enc.setRenderPipelineState(g.regionPipeline)
        enc.setFragmentBytes(&cb, length: MemoryLayout<RegionCBData>.size, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    // Morph
    if g.morphPhase != .idle, let tex1 = g.morphTex1 {
        let elapsed = Float((nowMs() - g.morphStartTime) / 1000)
        var cb = MorphCBData()
        cb.mixVal = g.morphMix; cb.strength = g.morphStrength; cb.time = elapsed
        cb.aspect = g.morphW > 0 ? g.morphW / g.morphH : 1
        cb.color1 = g.morphColors[0]; cb.color2 = g.morphColors[1]
        cb.color3 = g.morphColors[2]; cb.color4 = g.morphColors[3]

        setViewport(enc, g.morphX, g.morphY, g.morphW, g.morphH)
        enc.setRenderPipelineState(g.morphPipeline)
        enc.setFragmentBytes(&cb, length: MemoryLayout<MorphCBData>.size, index: 0)
        enc.setFragmentTexture(tex1, index: 0)
        enc.setFragmentTexture(g.morphTex2 ?? tex1, index: 1)
        enc.setFragmentSamplerState(g.linearSampler, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    // Blob
    if g.blobAnim != .idle {
        g.blobData.selIdx = g.blobSelIdx
        setViewport(enc, g.blobScreenX, g.blobScreenY, g.blobSize, g.blobSize)
        enc.setRenderPipelineState(g.blobPipeline)
        enc.setFragmentBytes(&g.blobData, length: MemoryLayout<BlobCBData>.size, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    // Creature
    if g.creatureActive, let atlas = g.glyphAtlas {
        let elapsed = Float((nowMs() - g.creatureStartTime) / 1000)
        var cb = CreatureCBData()
        cb.canvasSize = SIMD2(g.creatureW * 2, g.creatureH * 2)
        cb.gridSize = SIMD2(g.creatureGridW, g.creatureGridH)
        cb.time = elapsed; cb.charCount = 10
        cb.birth = g.creatureBirth; cb.flash = g.creatureFlash
        cb.listening = g.creatureListening; cb.speaking = g.creatureSpeaking
        cb.voiceEnergy = g.creatureVoiceEnergy
        cb.colors = (g.creatureColors[0], g.creatureColors[1], g.creatureColors[2],
                     g.creatureColors[3], g.creatureColors[4])

        setViewport(enc, g.creatureX, g.creatureY, g.creatureW, g.creatureH)
        enc.setRenderPipelineState(g.creaturePipeline)
        enc.setFragmentBytes(&cb, length: MemoryLayout<CreatureCBData>.size, index: 0)
        enc.setFragmentTexture(atlas, index: 0)
        enc.setFragmentSamplerState(g.nearestSampler, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    enc.endEncoding()
    cmdBuf.present(drawable)
    cmdBuf.commit()
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 10 — IPC command processing
// ════════════════════════════════════════════════════════════════════════════

func processCommand(_ dict: [String: Any]) {
    let cmd = jsonStr(dict, "cmd")

    switch cmd {
    case "show_radial":
        let cx = Float(jsonNum(dict, "x")), cy = Float(jsonNum(dict, "y"))
        let sz = Float(jsonNum(dict, "size", 280))
        g.blobScreenX = cx - sz / 2; g.blobScreenY = cy - sz / 2; g.blobSize = sz
        g.blobSelIdx = -1; g.blobAnim = .opening; g.blobStart = nowMs()
        g.blobData = BlobCBData()
        let fills = jsonFloatArray(dict, "fills")
        if fills.count >= 15 {
            for i in 0..<5 {
                let c = SIMD4<Float>(fills[i*3], fills[i*3+1], fills[i*3+2], 0)
                withUnsafeMutablePointer(to: &g.blobData.fills) { ptr in
                    let base = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: SIMD4<Float>.self)
                    base[i] = c
                }
            }
        }
        let sf = jsonFloatArray(dict, "selFill")
        if sf.count >= 3 { g.blobData.selFill = SIMD4(sf[0], sf[1], sf[2], 0) }
        let cb = jsonFloatArray(dict, "centerBg")
        if cb.count >= 3 { g.blobData.centerBg = SIMD4(cb[0], cb[1], cb[2], 0) }
        let st = jsonFloatArray(dict, "stroke")
        if st.count >= 3 { g.blobData.stroke = SIMD4(st[0], st[1], st[2], 0) }
        g.window?.orderFrontRegardless()
        ensureRenderTimer()

    case "hide_radial":
        if g.blobAnim == .opening || g.blobAnim == .settled {
            g.blobAnim = .closing; g.blobStart = nowMs()
        }

    case "radial_cursor":
        let cx = Float(jsonNum(dict, "x")), cy = Float(jsonNum(dict, "y"))
        let dx = cx - g.blobScreenX - g.blobSize / 2
        let dy = cy - g.blobScreenY - g.blobSize / 2
        let dist = sqrtf(dx * dx + dy * dy)
        if dist >= 40 && dist <= 125 {
            let angle = atan2f(dy, dx)
            let topAngle = fmodf(angle + .pi * 0.5 + .pi * 2, .pi * 2)
            g.blobSelIdx = floorf(topAngle / (.pi * 2 / 5))
        } else { g.blobSelIdx = -1 }

    case "show_voice":
        g.creatureActive = true
        g.creatureX = Float(jsonNum(dict, "x")); g.creatureY = Float(jsonNum(dict, "y"))
        g.creatureStartTime = nowMs(); g.creatureBirth = 0
        let colors = jsonFloatArray(dict, "colors")
        if colors.count >= 15 {
            for i in 0..<5 { g.creatureColors[i] = SIMD4(colors[i*3], colors[i*3+1], colors[i*3+2], 0) }
        }
        g.window?.orderFrontRegardless()
        ensureRenderTimer()

    case "hide_voice":
        g.creatureActive = false

    case "voice_update":
        g.creatureListening = Float(jsonNum(dict, "listening"))
        g.creatureSpeaking = Float(jsonNum(dict, "speaking"))
        g.creatureVoiceEnergy = Float(jsonNum(dict, "energy"))

    case "creature_birth":
        g.creatureBirth = Float(jsonNum(dict, "value", 1))

    case "creature_flash":
        g.creatureFlash = 1

    case "morph_forward":
        let path = jsonStr(dict, "screenshot")
        g.morphX = Float(jsonNum(dict, "x")); g.morphY = Float(jsonNum(dict, "y"))
        g.morphW = Float(jsonNum(dict, "w")); g.morphH = Float(jsonNum(dict, "h"))
        g.morphTex1 = loadTextureFromFile(path)
        g.morphPhase = .rippling; g.morphMix = 0; g.morphStrength = 0
        g.morphStartTime = nowMs(); g.morphPhaseStart = g.morphStartTime
        g.window?.orderFrontRegardless()
        ensureRenderTimer()

    case "morph_reverse":
        g.morphTex2 = loadTextureFromFile(jsonStr(dict, "screenshot"))
        g.morphPhase = .crossfading; g.morphPhaseStart = nowMs()

    case "morph_end":
        g.morphPhase = .idle; g.morphTex1 = nil; g.morphTex2 = nil

    case "region_start":
        g.regionActive = true; g.regionDragging = false
        g.window?.orderFrontRegardless()
        ensureRenderTimer()

    case "region_end":
        g.regionActive = false; g.regionDragging = false

    case "set_interactive":
        g.interactive = jsonBool(dict, "value")
        g.window?.ignoresMouseEvents = !g.interactive
        if g.regionActive && g.interactive {
            NSCursor.crosshair.set()
        }

    case "respan":
        let x = CGFloat(jsonNum(dict, "x")), y = CGFloat(jsonNum(dict, "y"))
        let w = CGFloat(jsonNum(dict, "w")), h = CGFloat(jsonNum(dict, "h"))
        g.winX = x; g.winY = y; g.winW = w; g.winH = h
        // Convert Electron coords (top-left origin) to NSWindow coords (bottom-left origin)
        let nsY = g.primaryScreenHeight - y - h
        g.window?.setFrame(NSRect(x: x, y: nsY, width: w, height: h), display: true)
        g.metalLayer?.drawableSize = CGSize(width: w, height: h)

    case "set_colors":
        let fills = jsonFloatArray(dict, "fills")
        if fills.count >= 15 {
            for i in 0..<5 {
                let c = SIMD4<Float>(fills[i*3], fills[i*3+1], fills[i*3+2], 0)
                withUnsafeMutablePointer(to: &g.blobData.fills) { ptr in
                    let base = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: SIMD4<Float>.self)
                    base[i] = c
                }
            }
        }
        let ccols = jsonFloatArray(dict, "creature")
        if ccols.count >= 15 {
            for i in 0..<5 { g.creatureColors[i] = SIMD4(ccols[i*3], ccols[i*3+1], ccols[i*3+2], 0) }
        }

    case "quit":
        g.running = false
        NSApplication.shared.terminate(nil)

    default: break
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 11 — Render timer management
// ════════════════════════════════════════════════════════════════════════════

func ensureRenderTimer() {
    if g.renderTimer != nil { return }
    g.renderTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { _ in
        renderFrame()
        if !isAnyActive() {
            g.renderTimer?.invalidate()
            g.renderTimer = nil
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 12 — Window + mouse handling
// ════════════════════════════════════════════════════════════════════════════

class OverlayView: NSView {
    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard g.regionActive else { return }
        let pt = toOverlayCoords(event)
        g.regionDragging = true
        g.regionStartX = pt.x; g.regionStartY = pt.y
        g.regionCurX = pt.x; g.regionCurY = pt.y
    }

    override func mouseDragged(with event: NSEvent) {
        guard g.regionActive, g.regionDragging else { return }
        let pt = toOverlayCoords(event)
        g.regionCurX = pt.x; g.regionCurY = pt.y
    }

    override func mouseUp(with event: NSEvent) {
        guard g.regionActive, g.regionDragging else { return }
        g.regionDragging = false
        let pt = toOverlayCoords(event)
        let selW = abs(pt.x - g.regionStartX), selH = abs(pt.y - g.regionStartY)
        if selW >= 6 && selH >= 6 {
            let x = min(g.regionStartX, pt.x), y = min(g.regionStartY, pt.y)
            sendJson(["event": "region_select", "x": x, "y": y, "w": selW, "h": selH])
        } else {
            sendJson(["event": "region_click", "x": pt.x, "y": pt.y])
        }
        g.regionActive = false
    }

    override func rightMouseDown(with event: NSEvent) {
        guard g.regionActive else { return }
        g.regionDragging = false; g.regionActive = false
        sendJson(["event": "region_cancel"])
    }

    override func keyDown(with event: NSEvent) {
        if g.regionActive && event.keyCode == 53 /* Escape */ {
            g.regionDragging = false; g.regionActive = false
            sendJson(["event": "region_cancel"])
            return
        }
        super.keyDown(with: event)
    }

    override func resetCursorRects() {
        if g.regionActive {
            addCursorRect(bounds, cursor: .crosshair)
        }
    }

    // Convert NSEvent location to overlay-local coords (top-left origin, matching Metal viewport)
    private func toOverlayCoords(_ event: NSEvent) -> (x: Float, y: Float) {
        let local = convert(event.locationInWindow, from: nil)
        return (Float(local.x), Float(bounds.height - local.y))
    }
}

func createWindow() {
    // Compute total display bounds in Electron coords (top-left origin)
    let primary = g.primaryScreenHeight
    var minX = CGFloat.infinity, minElectronY = CGFloat.infinity
    var maxX = -CGFloat.infinity, maxElectronY = -CGFloat.infinity
    for screen in NSScreen.screens {
        let f = screen.frame
        let eTop = primary - (f.origin.y + f.height)
        let eBottom = primary - f.origin.y
        minX = min(minX, f.origin.x)
        minElectronY = min(minElectronY, eTop)
        maxX = max(maxX, f.origin.x + f.width)
        maxElectronY = max(maxElectronY, eBottom)
    }
    let w = maxX - minX, h = maxElectronY - minElectronY
    g.winX = minX; g.winY = minElectronY; g.winW = w; g.winH = h

    // Convert to NSWindow coords
    let nsY = primary - minElectronY - h

    let window = NSWindow(contentRect: NSRect(x: minX, y: nsY, width: w, height: h),
                          styleMask: .borderless, backing: .buffered, defer: false)
    window.level = .screenSaver
    window.isOpaque = false
    window.backgroundColor = .clear
    window.ignoresMouseEvents = true
    window.hasShadow = false
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

    let view = OverlayView(frame: NSRect(x: 0, y: 0, width: w, height: h))
    view.wantsLayer = true

    let metalLayer = CAMetalLayer()
    metalLayer.device = g.device
    metalLayer.pixelFormat = .bgra8Unorm
    metalLayer.isOpaque = false
    metalLayer.framebufferOnly = true
    metalLayer.drawableSize = CGSize(width: w, height: h)
    view.layer = metalLayer
    g.metalLayer = metalLayer

    window.contentView = view
    window.orderFrontRegardless()
    g.window = window
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 13 — Stdin reader + entry point
// ════════════════════════════════════════════════════════════════════════════

func startStdinReader() {
    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() {
            guard !line.isEmpty,
                  let data = line.data(using: .utf8),
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            DispatchQueue.main.async { processCommand(dict) }
        }
        // stdin closed — parent gone
        DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
    }
}

// ── Main ──

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // No dock icon

guard initMetal() else { exit(1) }
createGlyphAtlas()
createWindow()
startStdinReader()

// Listen for display configuration changes
NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                       object: nil, queue: .main) { _ in
    // Recompute display bounds and reposition window
    let primary = g.primaryScreenHeight
    var minX = CGFloat.infinity, minEY = CGFloat.infinity
    var maxX = -CGFloat.infinity, maxEY = -CGFloat.infinity
    for screen in NSScreen.screens {
        let f = screen.frame
        minX = min(minX, f.origin.x)
        minEY = min(minEY, primary - (f.origin.y + f.height))
        maxX = max(maxX, f.origin.x + f.width)
        maxEY = max(maxEY, primary - f.origin.y)
    }
    let w = maxX - minX, h = maxEY - minEY
    g.winX = minX; g.winY = minEY; g.winW = w; g.winH = h
    let nsY = primary - minEY - h
    g.window?.setFrame(NSRect(x: minX, y: nsY, width: w, height: h), display: true)
    g.metalLayer?.drawableSize = CGSize(width: w, height: h)
}

sendJson(["event": "ready"])
app.run()
