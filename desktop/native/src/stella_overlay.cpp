// ════════════════════════════════════════════════════════════════════════════
//  Stella Native Overlay
//  Direct3D 11 + DirectComposition transparent always-on-top overlay window.
//  Renders: radial blob, voice creature, morph transition.
//  IPC: stdin/stdout JSON lines with Electron main process.
// ════════════════════════════════════════════════════════════════════════════

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <dcomp.h>
#include <dwmapi.h>
#include <wincodec.h>

#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <string>
#include <thread>
#include <mutex>
#include <vector>
#include <atomic>
#include <algorithm>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "dcomp.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")

// ── Custom message for IPC commands posted from stdin thread ──────────────
#define WM_OVERLAY_CMD (WM_USER + 1)

// ════════════════════════════════════════════════════════════════════════════
//  Section 1 — JSON helpers (minimal, for our known protocol)
// ════════════════════════════════════════════════════════════════════════════

static std::string jsonGetStr(const std::string& j, const char* key) {
    std::string needle = std::string("\"") + key + "\"";
    auto pos = j.find(needle);
    if (pos == std::string::npos) return "";
    pos = j.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos = j.find('"', pos + 1);
    if (pos == std::string::npos) return "";
    auto end = j.find('"', pos + 1);
    if (end == std::string::npos) return "";
    return j.substr(pos + 1, end - pos - 1);
}

static double jsonGetNum(const std::string& j, const char* key, double def = 0.0) {
    std::string needle = std::string("\"") + key + "\"";
    auto pos = j.find(needle);
    if (pos == std::string::npos) return def;
    pos = j.find(':', pos + needle.size());
    if (pos == std::string::npos) return def;
    pos++;
    while (pos < j.size() && (j[pos] == ' ' || j[pos] == '\t')) pos++;
    if (pos >= j.size()) return def;
    try { return std::stod(j.substr(pos)); }
    catch (...) { return def; }
}

static bool jsonGetBool(const std::string& j, const char* key, bool def = false) {
    std::string needle = std::string("\"") + key + "\"";
    auto pos = j.find(needle);
    if (pos == std::string::npos) return def;
    pos = j.find(':', pos + needle.size());
    if (pos == std::string::npos) return def;
    return j.find("true", pos) != std::string::npos &&
           j.find("true", pos) < j.find_first_of(",}", pos);
}

// Parse a flat float array like [0.1,0.2,0.3]
static std::vector<float> jsonGetFloatArray(const std::string& j, const char* key) {
    std::vector<float> out;
    std::string needle = std::string("\"") + key + "\"";
    auto pos = j.find(needle);
    if (pos == std::string::npos) return out;
    pos = j.find('[', pos);
    if (pos == std::string::npos) return out;
    pos++;
    while (pos < j.size() && j[pos] != ']') {
        while (pos < j.size() && (j[pos] == ' ' || j[pos] == ',')) pos++;
        if (pos >= j.size() || j[pos] == ']') break;
        // Check for nested array
        if (j[pos] == '[') {
            pos++;
            continue;
        }
        try { out.push_back((float)std::stod(j.substr(pos))); }
        catch (...) { break; }
        while (pos < j.size() && j[pos] != ',' && j[pos] != ']') pos++;
    }
    return out;
}

static void sendJson(const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    fputs(buf, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 2 — Math helpers
// ════════════════════════════════════════════════════════════════════════════

static double springEase(double t) {
    if (t <= 0.0) return 0.0;
    const double zeta = 0.58;
    const double omega = 28.0;
    const double omegaD = omega * sqrt(1.0 - zeta * zeta);
    return 1.0 - exp(-zeta * omega * t) *
        (cos(omegaD * t) + (zeta * omega / omegaD) * sin(omegaD * t));
}

static double now_ms() {
    static LARGE_INTEGER freq = {};
    if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return (double)t.QuadPart / (double)freq.QuadPart * 1000.0;
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 3 — HLSL shaders (embedded as raw string literals)
// ════════════════════════════════════════════════════════════════════════════

// ── 3a. Shared vertex shader (fullscreen triangle from vertex ID) ─────────
static const char* VS_SOURCE = R"HLSL(
struct VSOut {
    float4 pos : SV_POSITION;
    float2 uv  : TEXCOORD0;
};
VSOut VSMain(uint id : SV_VertexID) {
    VSOut o;
    o.uv  = float2((id << 1) & 2, id & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}
)HLSL";

// ── 3b. Radial blob pixel shader ─────────────────────────────────────────
static const char* BLOB_PS_SOURCE = R"HLSL(
cbuffer BlobCB : register(b0) {
    float u_progress;
    float u_leadP;
    float u_lagP;
    float u_morph;
    float u_time;
    float u_selIdx;
    float2 _pad0;
    float4 u_fills[5];
    float4 u_selFill;
    float4 u_centerBg;
    float4 u_stroke;
};

static const float PI  = 3.14159265;
static const float TAU = 6.28318530;
static const float WEDGE_ANG = TAU / 5.0;
static const float INNER_R  = 40.0  / 280.0;
static const float OUTER_R  = 125.0 / 280.0;
static const float CENTER_R = 35.0  / 280.0;

float glmod(float x, float y) { return x - y * floor(x / y); }

float4 PSMain(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    float2 p = uv - 0.5;
    float dist  = length(p);
    float angle = atan2(p.y, p.x);
    float topAngle = glmod(angle + PI * 0.5, TAU);

    int   wi    = (int)floor(topAngle / WEDGE_ANG);
    float wFrac = frac(topAngle / WEDGE_ANG);

    float wobble = sin(angle * 3.0 + u_time * 1.5) * 0.012
                 + sin(angle * 5.0 - u_time * 2.0) * 0.008
                 + sin(angle * 2.0 + 0.5) * 0.018
                 + sin(angle * 4.0 - 1.3) * 0.006;
    wobble *= (1.0 - u_morph * 0.85);

    float asym = sin(angle * 2.3 + 0.7) * 0.035
               + sin(angle * 1.0 - 0.4) * 0.02;
    asym *= (1.0 - u_morph * 0.9);

    float outerR  = u_lagP * OUTER_R * (1.0 + asym) + wobble * u_lagP;
    float innerT  = saturate((u_progress - 0.4) / 0.6);
    float innerR  = innerT * INNER_R;
    float centerT = saturate((u_leadP - 0.25) / 0.75);
    float centerR = centerT * CENTER_R;
    float soft    = lerp(0.022, 0.004, u_morph);

    float outerMask  = smoothstep(outerR  + soft,        outerR  - soft,        dist);
    float innerMask  = smoothstep(innerR  - soft * 0.5,  innerR  + soft * 0.5,  dist);
    float centerMask = smoothstep(centerR + soft * 0.4,  centerR - soft * 0.4,  dist);
    float ring = outerMask * innerMask;

    float3 wc;
    if      (wi == 0) wc = u_fills[0].xyz;
    else if (wi == 1) wc = u_fills[1].xyz;
    else if (wi == 2) wc = u_fills[2].xyz;
    else if (wi == 3) wc = u_fills[3].xyz;
    else              wc = u_fills[4].xyz;

    if (u_selIdx >= 0.0 && abs((float)wi - u_selIdx) < 0.5)
        wc = u_selFill.xyz;

    float3 avg = (u_fills[0].xyz + u_fills[1].xyz + u_fills[2].xyz
                + u_fills[3].xyz + u_fills[4].xyz) * 0.2;
    float3 ringColor = lerp(avg, wc, u_morph);

    float bDist  = min(wFrac, 1.0 - wFrac);
    float bWidth = 0.006 / max(dist * 5.0, 0.01);
    float bLine  = smoothstep(0.0, bWidth, bDist);
    ringColor = lerp(u_stroke.xyz, ringColor, lerp(1.0, bLine, u_morph * 0.6));

    float3 color = ringColor;
    float  alpha = ring;
    color = lerp(color, u_centerBg.xyz, centerMask);
    alpha = max(alpha, centerMask);

    return float4(color * alpha, alpha);  // premultiplied
}
)HLSL";

// ── 3c. Voice creature pixel shader ──────────────────────────────────────
static const char* CREATURE_PS_SOURCE = R"HLSL(
cbuffer CreatureCB : register(b0) {
    float2 u_canvasSize;
    float2 u_gridSize;
    float  u_time;
    float  u_charCount;
    float  u_birth;
    float  u_flash;
    float  u_listening;
    float  u_speaking;
    float  u_voiceEnergy;
    float  _cpad;
    float4 u_colors[5];
};

Texture2D    u_glyph     : register(t0);
SamplerState glyphSampler : register(s0);

float glmod(float x, float y) { return x - y * floor(x / y); }

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
        i3 = sf + lerp(pt, fm, br) * 0.5;
    }
    return i1 * w1 + i2 * w2 + i3 * w3;
}

float4 PSMain(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    // Circular distance with canvas aspect correction
    float2 c = (uv - 0.5) * 1.2;
    c.x *= u_canvasSize.x / u_canvasSize.y;
    float dist = length(c) * 2.0;
    if (dist > 2.0) return float4(0, 0, 0, 0);

    float angle = atan2(c.y, c.x);

    // 3-phase cycling
    float cycle = u_time * 0.15;
    float phase = glmod(cycle, 3.0);
    float w1 = max(0.0, 1.0 - abs(phase - 0.0)) + max(0.0, 1.0 - abs(phase - 3.0));
    float w2 = max(0.0, 1.0 - abs(phase - 1.0));
    float w3 = max(0.0, 1.0 - abs(phase - 2.0));
    float total = w1 + w2 + w3;
    w1 /= total; w2 /= total; w3 /= total;

    float intensity = computePhases(dist, angle, w1, w2, w3, u_time);

    // Voice: listening — contract inward
    if (u_listening > 0.01) {
        float sd = dist * (1.0 + u_listening * 0.5);
        float si = computePhases(sd, angle, w1, w2, w3, u_time);
        intensity = lerp(intensity, si, u_listening);
        float rings = sin(dist * 20.0 + u_time * 5.0) * 0.5 + 0.5;
        rings *= smoothstep(0.5, 0.1, dist);
        intensity += rings * u_listening * 0.3;
        intensity *= 1.0 + u_voiceEnergy * u_listening * 0.8;
    }

    // Voice: speaking — expand outward
    if (u_speaking > 0.01) {
        float ed = dist / (1.0 + u_speaking * 0.08 + u_voiceEnergy * 0.12);
        float ei = computePhases(ed, angle, w1, w2, w3, u_time);
        intensity = lerp(intensity, ei, u_speaking);
        float waves = sin(dist * 10.0 - u_time * 8.0) * 0.5 + 0.5;
        waves *= smoothstep(1.2, 0.1, dist) * u_voiceEnergy;
        intensity += waves * u_speaking * 0.4;
        intensity *= 1.0 + u_speaking * u_voiceEnergy * 0.4;
    }

    intensity = min(intensity, 1.0);

    // Birth animation
    float birthRadius = u_birth * 1.5;
    float birthEdge   = smoothstep(birthRadius, birthRadius - 0.3, dist);
    float smallness   = 1.0 - u_birth;
    float pulseSpeed  = 5.0 + smallness * 2.0;
    float pulseStr    = smallness * 0.5;
    float birthPulse  = 1.0 + sin(dist * 25.0 - u_time * pulseSpeed) * pulseStr;
    float breathe2    = 1.0 + sin(u_time * 1.5) * 0.15 * smallness;
    intensity *= birthEdge * birthPulse * breathe2;
    intensity *= sqrt(u_birth);

    float charIndex = floor(intensity * (u_charCount - 1.0));

    // Glyph atlas lookup
    float2 cellLocal = frac(uv * u_gridSize);
    float2 glyphUV   = float2((cellLocal.x + charIndex) / u_charCount, cellLocal.y);
    float  glyphAlpha = u_glyph.Sample(glyphSampler, glyphUV).a;

    // Color interpolation
    float colorPos = clamp(intensity * 4.0, 0.0, 3.999);
    float ci = floor(colorPos);
    float cf = smoothstep(0.0, 1.0, colorPos - ci);
    float3 color;
    if      (ci < 1.0) color = lerp(u_colors[0].xyz, u_colors[1].xyz, cf);
    else if (ci < 2.0) color = lerp(u_colors[1].xyz, u_colors[2].xyz, cf);
    else if (ci < 3.0) color = lerp(u_colors[2].xyz, u_colors[3].xyz, cf);
    else               color = lerp(u_colors[3].xyz, u_colors[4].xyz, cf);

    // Inverted saturation gradient
    float luma = dot(color, float3(0.299, 0.587, 0.114));
    float sat  = lerp(0.55, 1.4, 1.0 - intensity);
    color = lerp(float3(luma, luma, luma), color, sat);

    // Warm tint on outer dots
    float warm = 1.0 - intensity;
    color *= float3(1.0 + warm * 0.2, 1.0 + warm * 0.07, 1.0 - warm * 0.1);

    // Flash wave
    float waveRadius    = (1.0 - u_flash) * 1.8;
    float waveWidth     = 0.3;
    float waveDist      = abs(dist - waveRadius);
    float waveIntensity = smoothstep(waveWidth, 0.0, waveDist) * u_flash;
    color *= 1.0 + waveIntensity * 2.0;

    float4 result = float4(color * glyphAlpha, glyphAlpha);

    // ── Eyes ──
    float eyeGap = 5.0 / u_gridSize.x;
    float eyeUp  = 2.5 / u_gridSize.y;

    float eyeAngle = -u_time * 2.5;
    float2 drift1 = float2(cos(eyeAngle), sin(eyeAngle)) * 1.1;

    float et  = u_time * 2.0;
    float ep1 = sin(et)         * 0.5 + 0.5;
    float ep2 = sin(et + 2.094) * 0.5 + 0.5;
    float ep3 = sin(et + 4.188) * 0.5 + 0.5;
    float epSum = ep1 + ep2 + ep3;
    float2 drift2 = (float2(1.0, 0.0) * ep1
                   + float2(-0.5,  0.866) * ep2
                   + float2(-0.5, -0.866) * ep3) / epSum * 1.8;

    float2 drift3 = float2(0.0, -sin(u_time * 0.4)) * 0.9;
    float2 eyeDrift = drift1 * w1 + drift2 * w2 + drift3 * w3;
    float2 eyeOrigin = float2(0.5 + eyeDrift.x / u_gridSize.x,
                               0.5 - eyeUp + eyeDrift.y / u_gridSize.y);

    // Blink
    float blinkSlot  = floor(u_time / 0.8);
    float blinkHash  = frac(sin(blinkSlot * 91.7) * 43758.5453);
    float blinkLocal = frac(u_time / 0.8);
    float doBlink    = step(0.65, blinkHash);
    float bt = saturate(blinkLocal / 0.1);
    float blinkCurve = smoothstep(0.0, 1.0, abs(bt * 2.0 - 1.0));
    float blink = lerp(1.0, blinkCurve, doBlink);

    // Double blink
    float dblHash  = frac(sin(blinkSlot * 73.3) * 28461.7);
    float doDouble = step(0.8, dblHash) * doBlink;
    float bt2 = saturate((blinkLocal - 0.15) / 0.1);
    float dblCurve = smoothstep(0.0, 1.0, abs(bt2 * 2.0 - 1.0));
    blink *= lerp(1.0, dblCurve, doDouble);

    float2 eyeHalf = float2(1.0 / u_gridSize.x, 1.5 / u_gridSize.y * blink);
    float leftEye  = step(abs(uv.x - eyeOrigin.x + eyeGap), eyeHalf.x)
                   * step(abs(uv.y - eyeOrigin.y), eyeHalf.y);
    float rightEye = step(abs(uv.x - eyeOrigin.x - eyeGap), eyeHalf.x)
                   * step(abs(uv.y - eyeOrigin.y), eyeHalf.y);
    float eyeMask = max(leftEye, rightEye) * smoothstep(0.3, 0.6, u_birth);
    result = lerp(result, float4(u_colors[4].xyz, 1.0), eyeMask);

    // ── Mouth ──
    float2 mouthPos = float2(eyeOrigin.x, eyeOrigin.y + 3.5 / u_gridSize.y);
    float mouthSlot = floor(u_time / 2.5);
    float mouthHash = frac(sin(mouthSlot * 47.3)  * 31718.9);
    float shapeHash = frac(sin(mouthSlot * 113.1) * 18734.3);
    float mouthLocal = frac(u_time / 2.5);
    float doOpen = step(0.70, mouthHash);

    float isO     = (1.0 - step(0.2, shapeHash));
    float isSmile = step(0.2, shapeHash) * (1.0 - step(0.4, shapeHash));
    float isFrown = step(0.4, shapeHash) * (1.0 - step(0.6, shapeHash));
    float isSideV = step(0.6, shapeHash) * (1.0 - step(0.8, shapeHash));
    float isDash  = step(0.8, shapeHash);

    float openUp    = smoothstep(0.0, 0.08, mouthLocal);
    float closeDown = 1.0 - smoothstep(0.6, 0.8, mouthLocal);
    float mouthAnim = openUp * closeDown * doOpen;

    float2 md = (uv - mouthPos) * u_gridSize;
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
    float mouthMask = mouthShape * smoothstep(0.3, 0.6, u_birth);
    result = lerp(result, float4(u_colors[4].xyz, 1.0), mouthMask);

    // Premultiplied alpha output
    return float4(result.rgb * result.a, result.a);
}
)HLSL";

// ── 3d. Morph transition pixel shader ────────────────────────────────────
static const char* MORPH_PS_SOURCE = R"HLSL(
cbuffer MorphCB : register(b0) {
    float  u_mix;
    float  u_strength;
    float  u_time;
    float  u_aspect;
    float2 u_center;
    float2 _mpad;
    float4 u_color1;
    float4 u_color2;
    float4 u_color3;
    float4 u_color4;
};

Texture2D    u_tex  : register(t0);
Texture2D    u_tex2 : register(t1);
SamplerState texSmp : register(s0);

float4 sampleChroma(Texture2D tex, SamplerState s, float2 uv, float2 cd, float chr) {
    float r = tex.Sample(s, clamp(uv + cd * chr, 0.0, 1.0)).r;
    float g = tex.Sample(s, clamp(uv,            0.0, 1.0)).g;
    float b = tex.Sample(s, clamp(uv - cd * chr, 0.0, 1.0)).b;
    float a = tex.Sample(s, clamp(uv,            0.0, 1.0)).a;
    return float4(r, g, b, a);
}

float4 PSMain(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    uv.y = 1.0 - uv.y;  // flip for screenshot orientation

    float2 d = uv - u_center;
    d.x *= u_aspect;
    float dist = length(d);

    float ripple = sin(dist * 6.0 - u_time * 4.0) * u_strength * 0.012;
    ripple *= smoothstep(0.0, 0.35, dist) * (1.0 - smoothstep(0.6, 1.0, dist));

    float warp = sin(dist * 3.0 + u_time * 2.0) * u_strength * 0.02
               * smoothstep(0.0, 0.3, dist);

    float2 offset = normalize(d + float2(0.001, 0.001)) * (ripple + warp);
    offset.x /= u_aspect;
    float2 suv = uv + offset;

    float  chromatic = u_strength * 0.003;
    float2 chromDir  = normalize(d + float2(0.001, 0.001));
    chromDir.x /= u_aspect;

    float4 col1 = sampleChroma(u_tex,  texSmp, suv, chromDir, chromatic);
    float4 col2 = sampleChroma(u_tex2, texSmp, suv, chromDir, chromatic);
    float4 col  = lerp(col1, col2, u_mix);

    // Edge detection for color tint
    float dx = 0.002 * u_strength;
    float lumC = dot(col.rgb, float3(0.299, 0.587, 0.114));
    float lumR = dot(u_tex.Sample(texSmp, clamp(suv + float2(dx, 0), 0, 1)).rgb,
                     float3(0.299, 0.587, 0.114));
    float lumU = dot(u_tex.Sample(texSmp, clamp(suv + float2(0, dx), 0, 1)).rgb,
                     float3(0.299, 0.587, 0.114));
    float edge = length(float2(lumR - lumC, lumU - lumC));

    float angle = atan2(d.y, d.x);
    float colorPhase = frac(angle / 6.2832 + u_time * 0.3) * 4.0;
    float3 tint = lerp(u_color1.xyz, u_color2.xyz, smoothstep(0.0, 1.0, colorPhase));
    tint = lerp(tint, u_color3.xyz, smoothstep(1.0, 2.0, colorPhase));
    tint = lerp(tint, u_color4.xyz, smoothstep(2.0, 3.0, colorPhase));
    tint = lerp(tint, u_color1.xyz, smoothstep(3.0, 4.0, colorPhase));

    float colorMask = smoothstep(0.02, 0.08, edge) * u_strength * 0.35;
    col.rgb = lerp(col.rgb, tint, colorMask);

    return col;
}
)HLSL";

// ── 3e. Region capture pixel shader ───────────────────────────────────────
static const char* REGION_PS_SOURCE = R"HLSL(
cbuffer RegionCB : register(b0) {
    float2 resolution;
    float2 selectMin;
    float2 selectMax;
    float dimAlpha;
    float hasSelection;
};

float4 PSMain(float4 pos : SV_POSITION, float2 uv : TEXCOORD0) : SV_TARGET {
    float2 pixel = uv * resolution;

    if (hasSelection > 0.5) {
        bool inside = pixel.x >= selectMin.x && pixel.x <= selectMax.x &&
                      pixel.y >= selectMin.y && pixel.y <= selectMax.y;
        if (inside) {
            float bw = 1.5;
            bool onBorder = pixel.x < selectMin.x + bw || pixel.x > selectMax.x - bw ||
                           pixel.y < selectMin.y + bw || pixel.y > selectMax.y - bw;
            if (onBorder) {
                float a = 0.7;
                return float4(a, a, a, a);
            }
            return float4(0, 0, 0, 0);
        }
    }

    float a = dimAlpha;
    return float4(0, 0, 0, a);
}
)HLSL";

// ════════════════════════════════════════════════════════════════════════════
//  Section 4 — Constant buffer structs (must match HLSL cbuffer layout)
// ════════════════════════════════════════════════════════════════════════════

struct alignas(16) BlobCB {
    float progress, leadP, lagP, morph;     // row 0
    float time, selIdx, _pad0[2];           // row 1
    float fills[5][4];                      // rows 2–6
    float selFill[4];                       // row 7
    float centerBg[4];                      // row 8
    float stroke[4];                        // row 9
};
static_assert(sizeof(BlobCB) == 160, "BlobCB size mismatch");

struct alignas(16) CreatureCB {
    float canvasSize[2];                    // 0
    float gridSize[2];                      // 8
    float time;                             // 16
    float charCount;                        // 20
    float birth;                            // 24
    float flash;                            // 28
    float listening;                        // 32
    float speaking;                         // 36
    float voiceEnergy;                      // 40
    float _pad;                             // 44
    float colors[5][4];                     // 48
};
static_assert(sizeof(CreatureCB) == 128, "CreatureCB size mismatch");

struct alignas(16) MorphCB {
    float mix, strength, time, aspect;      // row 0
    float center[2]; float _pad[2];         // row 1
    float color1[4];                        // row 2
    float color2[4];                        // row 3
    float color3[4];                        // row 4
    float color4[4];                        // row 5
};
static_assert(sizeof(MorphCB) == 96, "MorphCB size mismatch");

struct alignas(16) RegionCB {
    float resolution[2];               // 0
    float selectMin[2];                // 8
    float selectMax[2];                // 16
    float dimAlpha;                    // 24
    float hasSelection;                // 28
};
static_assert(sizeof(RegionCB) == 32, "RegionCB size mismatch");

// ════════════════════════════════════════════════════════════════════════════
//  Section 5 — Application state
// ════════════════════════════════════════════════════════════════════════════

enum BlobAnimState { BLOB_IDLE, BLOB_OPENING, BLOB_SETTLED, BLOB_CLOSING };
enum MorphPhase    { MORPH_IDLE, MORPH_RIPPLING, MORPH_CROSSFADING, MORPH_CALMING };

struct OverlayState {
    // Window
    HWND  hwnd = nullptr;
    int   winX = 0, winY = 0, winW = 1920, winH = 1080;
    bool  interactive = false;

    // D3D11
    ID3D11Device*           device   = nullptr;
    ID3D11DeviceContext*    ctx      = nullptr;
    IDXGISwapChain1*        swap     = nullptr;
    ID3D11RenderTargetView* rtv      = nullptr;
    IDCompositionDevice*    dcomp    = nullptr;
    IDCompositionTarget*    dcompTgt = nullptr;
    IDCompositionVisual*    dcompVis = nullptr;

    // Shaders
    ID3D11VertexShader*     vs       = nullptr;
    ID3D11PixelShader*      blobPS   = nullptr;
    ID3D11PixelShader*      creatPS  = nullptr;
    ID3D11PixelShader*      morphPS  = nullptr;
    ID3D11PixelShader*      regionPS = nullptr;
    ID3D11BlendState*       blendPre = nullptr;  // premultiplied alpha
    ID3D11Buffer*           blobCBuf = nullptr;
    ID3D11Buffer*           creatCBuf = nullptr;
    ID3D11Buffer*           morphCBuf = nullptr;
    ID3D11Buffer*           regionCBuf = nullptr;

    // Creature glyph atlas
    ID3D11ShaderResourceView* glyphSRV = nullptr;
    ID3D11SamplerState*       glyphSmp = nullptr;

    // Morph textures
    ID3D11ShaderResourceView* morphTex1SRV = nullptr;
    ID3D11ShaderResourceView* morphTex2SRV = nullptr;
    ID3D11SamplerState*       morphSmp     = nullptr;

    // ── Radial blob state ──
    BlobAnimState blobAnim = BLOB_IDLE;
    double blobStart = 0;
    float  blobSelIdx = -1.0f;
    float  blobScreenX = 0, blobScreenY = 0;
    float  blobSize = 280;
    BlobCB blobData{};

    // ── Voice creature state ──
    bool  creatureActive = false;
    float creatureX = 0, creatureY = 0;
    float creatureW = 168, creatureH = 168;
    float creatureGridW = 20, creatureGridH = 20;
    float creatureBirth = 1.0f;
    float creatureFlash = 0.0f;
    float creatureListening = 0;
    float creatureSpeaking = 0;
    float creatureVoiceEnergy = 0;
    double creatureStartTime = 0;
    float creatureColors[5][4] = {
        {0.47f, 0.63f, 0.97f, 0}, {0.73f, 0.60f, 0.97f, 0},
        {0.49f, 0.81f, 1.00f, 0}, {0.62f, 0.81f, 0.42f, 0},
        {1.00f, 0.95f, 0.80f, 0},
    };

    // ── Morph state ──
    MorphPhase morphPhase = MORPH_IDLE;
    float morphX = 0, morphY = 0, morphW = 0, morphH = 0;
    float morphMix = 0, morphStrength = 0;
    double morphPhaseStart = 0;
    double morphStartTime = 0;
    float morphColors[4][4] = {
        {0.48f, 0.64f, 0.97f, 0}, {0.73f, 0.60f, 0.97f, 0},
        {0.49f, 0.81f, 1.00f, 0}, {0.62f, 0.81f, 0.42f, 0},
    };

    // ── Region capture state ──
    bool regionActive = false;
    bool regionDragging = false;
    float regionStartX = 0, regionStartY = 0;  // client coords (overlay-relative)
    float regionCurX = 0, regionCurY = 0;

    // ── Threading ──
    std::atomic<bool> running{true};
    std::mutex cmdMutex;
    std::vector<std::string> pendingCmds;
};

static OverlayState g;

// ════════════════════════════════════════════════════════════════════════════
//  Section 6 — D3D11 + DirectComposition initialization
// ════════════════════════════════════════════════════════════════════════════

static ID3D11PixelShader* compilePS(const char* src, const char* entry) {
    ID3DBlob* blob = nullptr;
    ID3DBlob* err  = nullptr;
    HRESULT hr = D3DCompile(src, strlen(src), nullptr, nullptr, nullptr,
                            entry, "ps_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0,
                            &blob, &err);
    if (FAILED(hr)) {
        if (err) {
            fprintf(stderr, "PS compile error: %s\n", (char*)err->GetBufferPointer());
            err->Release();
        }
        return nullptr;
    }
    if (err) err->Release();
    ID3D11PixelShader* ps = nullptr;
    g.device->CreatePixelShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &ps);
    blob->Release();
    return ps;
}

static bool initD3D() {
    // ── Device ──
    D3D_FEATURE_LEVEL fl;
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   flags, nullptr, 0, D3D11_SDK_VERSION,
                                   &g.device, &fl, &g.ctx);
    if (FAILED(hr)) return false;

    // ── DXGI swap chain for composition ──
    IDXGIDevice* dxgiDev = nullptr;
    g.device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDev);
    IDXGIAdapter* adapter = nullptr;
    dxgiDev->GetAdapter(&adapter);
    IDXGIFactory2* factory = nullptr;
    adapter->GetParent(__uuidof(IDXGIFactory2), (void**)&factory);

    DXGI_SWAP_CHAIN_DESC1 scd{};
    scd.Width       = (UINT)g.winW;
    scd.Height      = (UINT)g.winH;
    scd.Format      = DXGI_FORMAT_B8G8R8A8_UNORM;
    scd.SampleDesc  = {1, 0};
    scd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scd.BufferCount = 2;
    scd.SwapEffect  = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    scd.AlphaMode   = DXGI_ALPHA_MODE_PREMULTIPLIED;
    hr = factory->CreateSwapChainForComposition(g.device, &scd, nullptr, &g.swap);
    factory->Release(); adapter->Release();
    if (FAILED(hr)) { dxgiDev->Release(); return false; }

    // ── Render target view ──
    ID3D11Texture2D* backBuf = nullptr;
    g.swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&backBuf);
    g.device->CreateRenderTargetView(backBuf, nullptr, &g.rtv);
    backBuf->Release();

    // ── DirectComposition ──
    hr = DCompositionCreateDevice(dxgiDev, __uuidof(IDCompositionDevice), (void**)&g.dcomp);
    dxgiDev->Release();
    if (FAILED(hr)) return false;
    g.dcomp->CreateTargetForHwnd(g.hwnd, TRUE, &g.dcompTgt);
    g.dcomp->CreateVisual(&g.dcompVis);
    g.dcompVis->SetContent(g.swap);
    g.dcompTgt->SetRoot(g.dcompVis);
    g.dcomp->Commit();

    // ── Vertex shader ──
    {
        ID3DBlob* blob = nullptr;
        ID3DBlob* err  = nullptr;
        D3DCompile(VS_SOURCE, strlen(VS_SOURCE), nullptr, nullptr, nullptr,
                   "VSMain", "vs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &blob, &err);
        if (err) { fprintf(stderr, "VS: %s\n", (char*)err->GetBufferPointer()); err->Release(); }
        if (blob) {
            g.device->CreateVertexShader(blob->GetBufferPointer(), blob->GetBufferSize(), nullptr, &g.vs);
            blob->Release();
        }
    }

    // ── Pixel shaders ──
    g.blobPS   = compilePS(BLOB_PS_SOURCE,     "PSMain");
    g.creatPS  = compilePS(CREATURE_PS_SOURCE, "PSMain");
    g.morphPS  = compilePS(MORPH_PS_SOURCE,    "PSMain");
    g.regionPS = compilePS(REGION_PS_SOURCE,   "PSMain");

    // ── Blend state (premultiplied alpha) ──
    {
        D3D11_BLEND_DESC bd{};
        bd.RenderTarget[0].BlendEnable    = TRUE;
        bd.RenderTarget[0].SrcBlend       = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlend      = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOp        = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].SrcBlendAlpha  = D3D11_BLEND_ONE;
        bd.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        bd.RenderTarget[0].BlendOpAlpha   = D3D11_BLEND_OP_ADD;
        bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        g.device->CreateBlendState(&bd, &g.blendPre);
    }

    // ── Constant buffers ──
    auto makeCB = [](UINT size) -> ID3D11Buffer* {
        D3D11_BUFFER_DESC bd{};
        bd.ByteWidth      = size;
        bd.Usage           = D3D11_USAGE_DYNAMIC;
        bd.BindFlags       = D3D11_BIND_CONSTANT_BUFFER;
        bd.CPUAccessFlags  = D3D11_CPU_ACCESS_WRITE;
        ID3D11Buffer* buf = nullptr;
        g.device->CreateBuffer(&bd, nullptr, &buf);
        return buf;
    };
    g.blobCBuf   = makeCB(sizeof(BlobCB));
    g.creatCBuf  = makeCB(sizeof(CreatureCB));
    g.morphCBuf  = makeCB(sizeof(MorphCB));
    g.regionCBuf = makeCB(sizeof(RegionCB));

    // ── Sampler for creature glyph atlas (NEAREST) ──
    {
        D3D11_SAMPLER_DESC sd{};
        sd.Filter   = D3D11_FILTER_MIN_MAG_MIP_POINT;
        sd.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        g.device->CreateSamplerState(&sd, &g.glyphSmp);
    }

    // ── Sampler for morph textures (LINEAR) ──
    {
        D3D11_SAMPLER_DESC sd{};
        sd.Filter   = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sd.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
        sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        g.device->CreateSamplerState(&sd, &g.morphSmp);
    }

    return true;
}

static void resizeSwapChain(int w, int h) {
    if (!g.swap || w <= 0 || h <= 0) return;
    g.winW = w; g.winH = h;
    if (g.rtv) { g.rtv->Release(); g.rtv = nullptr; }
    g.swap->ResizeBuffers(2, (UINT)w, (UINT)h, DXGI_FORMAT_B8G8R8A8_UNORM, 0);
    ID3D11Texture2D* bb = nullptr;
    g.swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&bb);
    g.device->CreateRenderTargetView(bb, nullptr, &g.rtv);
    bb->Release();
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 7 — Glyph atlas generation (for voice creature)
// ════════════════════════════════════════════════════════════════════════════

static void createGlyphAtlas() {
    const int DOT_COUNT = 10;
    const int gw = 20, gh = 20;
    const int atlasW = gw * DOT_COUNT, atlasH = gh;
    std::vector<uint8_t> pixels(atlasW * atlasH * 4, 0);

    float maxR = (float)(std::min)(gw, gh) * 0.45f;

    for (int i = 1; i < DOT_COUNT; i++) {
        float t = (float)i / (DOT_COUNT - 1);
        float radius = maxR * powf(t, 0.7f);
        if (radius < 0.5f) continue;
        float cx = (float)(i * gw + gw / 2);
        float cy = (float)(gh / 2);
        int x0 = i * gw, x1 = (i + 1) * gw;
        for (int py = 0; py < atlasH; py++) {
            for (int px = x0; px < x1; px++) {
                float dx = px + 0.5f - cx;
                float dy = py + 0.5f - cy;
                if (sqrtf(dx * dx + dy * dy) <= radius) {
                    int idx = (py * atlasW + px) * 4;
                    pixels[idx] = pixels[idx+1] = pixels[idx+2] = pixels[idx+3] = 255;
                }
            }
        }
    }

    D3D11_TEXTURE2D_DESC td{};
    td.Width     = atlasW;
    td.Height    = atlasH;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format    = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc = {1, 0};
    td.Usage     = D3D11_USAGE_IMMUTABLE;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;

    D3D11_SUBRESOURCE_DATA init{};
    init.pSysMem     = pixels.data();
    init.SysMemPitch = atlasW * 4;

    ID3D11Texture2D* tex = nullptr;
    g.device->CreateTexture2D(&td, &init, &tex);
    if (tex) {
        g.device->CreateShaderResourceView(tex, nullptr, &g.glyphSRV);
        tex->Release();
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 8 — Morph texture loading (WIC)
// ════════════════════════════════════════════════════════════════════════════

static ID3D11ShaderResourceView* loadTextureFromFile(const wchar_t* path) {
    IWICImagingFactory* wic = nullptr;
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                     IID_PPV_ARGS(&wic));
    if (!wic) return nullptr;

    IWICBitmapDecoder* decoder = nullptr;
    wic->CreateDecoderFromFilename(path, nullptr, GENERIC_READ,
                                    WICDecodeMetadataCacheOnLoad, &decoder);
    if (!decoder) { wic->Release(); return nullptr; }

    IWICBitmapFrameDecode* frame = nullptr;
    decoder->GetFrame(0, &frame);
    if (!frame) { decoder->Release(); wic->Release(); return nullptr; }

    IWICFormatConverter* conv = nullptr;
    wic->CreateFormatConverter(&conv);
    conv->Initialize(frame, GUID_WICPixelFormat32bppBGRA,
                     WICBitmapDitherTypeNone, nullptr, 0,
                     WICBitmapPaletteTypeCustom);

    UINT w = 0, h = 0;
    conv->GetSize(&w, &h);
    std::vector<BYTE> px(w * h * 4);
    conv->CopyPixels(nullptr, w * 4, (UINT)px.size(), px.data());

    conv->Release(); frame->Release(); decoder->Release(); wic->Release();

    D3D11_TEXTURE2D_DESC td{};
    td.Width = w; td.Height = h;
    td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc = {1, 0};
    td.Usage = D3D11_USAGE_IMMUTABLE;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;

    D3D11_SUBRESOURCE_DATA init{};
    init.pSysMem = px.data();
    init.SysMemPitch = w * 4;

    ID3D11Texture2D* tex = nullptr;
    g.device->CreateTexture2D(&td, &init, &tex);
    if (!tex) return nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
    g.device->CreateShaderResourceView(tex, nullptr, &srv);
    tex->Release();
    return srv;
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 9 — Component rendering
// ════════════════════════════════════════════════════════════════════════════

static void updateCB(ID3D11Buffer* buf, const void* data, UINT size) {
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (SUCCEEDED(g.ctx->Map(buf, 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
        memcpy(mapped.pData, data, size);
        g.ctx->Unmap(buf, 0);
    }
}

static void setViewport(float x, float y, float w, float h) {
    // Convert screen coords to overlay-local coords
    D3D11_VIEWPORT vp{};
    vp.TopLeftX = x - g.winX;
    vp.TopLeftY = y - g.winY;
    vp.Width    = w;
    vp.Height   = h;
    vp.MinDepth = 0;
    vp.MaxDepth = 1;
    g.ctx->RSSetViewports(1, &vp);
}

// ── Radial blob ──────────────────────────────────────────────────────────

static void updateBlobAnimation(double now) {
    if (g.blobAnim == BLOB_OPENING) {
        double s = (now - g.blobStart) / 1000.0;
        float progress = (float)springEase(s);
        float leadP    = (float)springEase(s + 0.035);
        float lagP     = (float)springEase(s - 0.020);
        float morphRaw = (float)springEase(s - 0.06);
        float morph    = powf((std::max)(0.0f, morphRaw), 1.3f);

        g.blobData.progress = progress;
        g.blobData.leadP    = leadP;
        g.blobData.lagP     = lagP;
        g.blobData.morph    = morph;
        g.blobData.time     = (float)s;

        if (s * 1000.0 >= 420.0) {
            g.blobAnim = BLOB_SETTLED;
        }
    } else if (g.blobAnim == BLOB_CLOSING) {
        double elapsed = now - g.blobStart;
        float t = (float)(std::min)(elapsed / 180.0, 1.0);
        float eased = t * t;
        float progress = 1.0f - eased;
        float lagP  = 1.0f - powf((std::min)(t * 1.15f, 1.0f), 2.0f);
        float leadP = 1.0f - powf((std::max)(0.0f, t - 0.08f), 2.0f) / (0.92f * 0.92f);
        float morph = (std::max)(0.0f, progress - 0.15f) / 0.85f;

        g.blobData.progress = progress;
        g.blobData.leadP    = leadP;
        g.blobData.lagP     = lagP;
        g.blobData.morph    = morph;
        g.blobData.time     = t * 0.2f;

        if (t >= 1.0f) {
            g.blobAnim = BLOB_IDLE;
            sendJson("{\"event\":\"radial_anim_done\"}");
        }
    }
}

static void renderBlob() {
    if (g.blobAnim == BLOB_IDLE) return;

    g.blobData.selIdx = g.blobSelIdx;
    updateCB(g.blobCBuf, &g.blobData, sizeof(BlobCB));

    setViewport(g.blobScreenX, g.blobScreenY, g.blobSize, g.blobSize);
    g.ctx->PSSetShader(g.blobPS, nullptr, 0);
    g.ctx->PSSetConstantBuffers(0, 1, &g.blobCBuf);
    g.ctx->Draw(3, 0);
}

// ── Voice creature ───────────────────────────────────────────────────────

static void renderCreature() {
    if (!g.creatureActive) return;

    double elapsed = (now_ms() - g.creatureStartTime) / 1000.0;

    // Canvas pixel size at 2x DPR with 2.5x edge scale
    float canvasW = g.creatureW * 2.0f;
    float canvasH = g.creatureH * 2.0f;

    CreatureCB cb{};
    cb.canvasSize[0] = canvasW;
    cb.canvasSize[1] = canvasH;
    cb.gridSize[0]   = g.creatureGridW;
    cb.gridSize[1]   = g.creatureGridH;
    cb.time           = (float)elapsed;
    cb.charCount      = 10.0f;
    cb.birth          = g.creatureBirth;
    cb.flash          = g.creatureFlash;
    cb.listening      = g.creatureListening;
    cb.speaking       = g.creatureSpeaking;
    cb.voiceEnergy    = g.creatureVoiceEnergy;
    memcpy(cb.colors, g.creatureColors, sizeof(g.creatureColors));

    updateCB(g.creatCBuf, &cb, sizeof(CreatureCB));

    setViewport(g.creatureX, g.creatureY, g.creatureW, g.creatureH);
    g.ctx->PSSetShader(g.creatPS, nullptr, 0);
    g.ctx->PSSetConstantBuffers(0, 1, &g.creatCBuf);
    g.ctx->PSSetShaderResources(0, 1, &g.glyphSRV);
    g.ctx->PSSetSamplers(0, 1, &g.glyphSmp);
    g.ctx->Draw(3, 0);

    // Clear SRV binding
    ID3D11ShaderResourceView* nullSRV = nullptr;
    g.ctx->PSSetShaderResources(0, 1, &nullSRV);
}

// ── Morph transition ─────────────────────────────────────────────────────

static const double MORPH_RAMP_MS   = 600;
static const double MORPH_FADE_MS   = 800;
static const double MORPH_CALM_MS   = 600;

static void updateMorphAnimation(double now) {
    if (g.morphPhase == MORPH_IDLE) return;

    double phaseElapsed = now - g.morphPhaseStart;
    double totalElapsed = now - g.morphStartTime;

    auto cosEase = [](double t) { return 0.5 - 0.5 * cos(3.14159265 * t); };

    if (g.morphPhase == MORPH_RIPPLING) {
        double t = (std::min)(phaseElapsed / MORPH_RAMP_MS, 1.0);
        g.morphStrength = (float)cosEase(t);
    } else if (g.morphPhase == MORPH_CROSSFADING) {
        double t = (std::min)(phaseElapsed / MORPH_FADE_MS, 1.0);
        g.morphMix = (float)cosEase(t);
        if (t >= 1.0) {
            g.morphPhase = MORPH_CALMING;
            g.morphPhaseStart = now;
        }
    } else if (g.morphPhase == MORPH_CALMING) {
        double t = (std::min)(phaseElapsed / MORPH_CALM_MS, 1.0);
        g.morphStrength = 1.0f - (float)cosEase(t);
        if (t >= 1.0) {
            g.morphPhase = MORPH_IDLE;
            sendJson("{\"event\":\"morph_done\"}");
            // Release textures
            if (g.morphTex1SRV) { g.morphTex1SRV->Release(); g.morphTex1SRV = nullptr; }
            if (g.morphTex2SRV) { g.morphTex2SRV->Release(); g.morphTex2SRV = nullptr; }
        }
    }
}

static void renderMorph() {
    if (g.morphPhase == MORPH_IDLE) return;
    if (!g.morphTex1SRV) return;

    double elapsed = (now_ms() - g.morphStartTime) / 1000.0;

    MorphCB cb{};
    cb.mix      = g.morphMix;
    cb.strength = g.morphStrength;
    cb.time     = (float)elapsed;
    cb.aspect   = g.morphW > 0 ? g.morphW / g.morphH : 1.0f;
    cb.center[0] = 0.5f;
    cb.center[1] = 0.5f;
    memcpy(cb.color1, g.morphColors[0], 16);
    memcpy(cb.color2, g.morphColors[1], 16);
    memcpy(cb.color3, g.morphColors[2], 16);
    memcpy(cb.color4, g.morphColors[3], 16);

    updateCB(g.morphCBuf, &cb, sizeof(MorphCB));

    setViewport(g.morphX, g.morphY, g.morphW, g.morphH);
    g.ctx->PSSetShader(g.morphPS, nullptr, 0);
    g.ctx->PSSetConstantBuffers(0, 1, &g.morphCBuf);

    ID3D11ShaderResourceView* srvs[2] = { g.morphTex1SRV, g.morphTex2SRV ? g.morphTex2SRV : g.morphTex1SRV };
    g.ctx->PSSetShaderResources(0, 2, srvs);
    g.ctx->PSSetSamplers(0, 1, &g.morphSmp);
    g.ctx->Draw(3, 0);

    ID3D11ShaderResourceView* nullSRVs[2] = { nullptr, nullptr };
    g.ctx->PSSetShaderResources(0, 2, nullSRVs);
}

// ── Region capture ───────────────────────────────────────────────────────

static void renderRegion() {
    if (!g.regionActive) return;

    RegionCB cb{};
    cb.resolution[0] = (float)g.winW;
    cb.resolution[1] = (float)g.winH;
    cb.dimAlpha = 0.35f;

    if (g.regionDragging) {
        cb.selectMin[0] = (std::min)(g.regionStartX, g.regionCurX);
        cb.selectMin[1] = (std::min)(g.regionStartY, g.regionCurY);
        cb.selectMax[0] = (std::max)(g.regionStartX, g.regionCurX);
        cb.selectMax[1] = (std::max)(g.regionStartY, g.regionCurY);
        cb.hasSelection = 1.0f;
    }

    updateCB(g.regionCBuf, &cb, sizeof(RegionCB));

    // Full overlay viewport
    D3D11_VIEWPORT vp{};
    vp.Width    = (float)g.winW;
    vp.Height   = (float)g.winH;
    vp.MaxDepth = 1;
    g.ctx->RSSetViewports(1, &vp);

    g.ctx->PSSetShader(g.regionPS, nullptr, 0);
    g.ctx->PSSetConstantBuffers(0, 1, &g.regionCBuf);
    g.ctx->Draw(3, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 10 — Main render loop
// ════════════════════════════════════════════════════════════════════════════

static bool isAnyActive() {
    return g.blobAnim != BLOB_IDLE || g.creatureActive || g.morphPhase != MORPH_IDLE || g.regionActive;
}

static void renderFrame() {
    if (!g.rtv) return;

    double now = now_ms();

    // Update animations
    updateBlobAnimation(now);
    updateMorphAnimation(now);

    // Decay creature flash
    if (g.creatureFlash > 0.001f) {
        double dt = 16.0 / 1200.0; // ~16ms frame / 1200ms duration
        g.creatureFlash = (std::max)(0.0f, g.creatureFlash - (float)dt);
    }

    // Clear
    float clear[] = {0, 0, 0, 0};
    g.ctx->ClearRenderTargetView(g.rtv, clear);
    g.ctx->OMSetRenderTargets(1, &g.rtv, nullptr);
    g.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    g.ctx->VSSetShader(g.vs, nullptr, 0);
    g.ctx->OMSetBlendState(g.blendPre, nullptr, 0xFFFFFFFF);

    // Render components
    renderRegion();
    renderMorph();
    renderBlob();
    renderCreature();

    g.swap->Present(1, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 11 — IPC command processing
// ════════════════════════════════════════════════════════════════════════════

static void processCommand(const std::string& line) {
    std::string cmd = jsonGetStr(line, "cmd");

    if (cmd == "show_radial") {
        float cx = (float)jsonGetNum(line, "x");
        float cy = (float)jsonGetNum(line, "y");
        float sz = (float)jsonGetNum(line, "size", 280);
        g.blobScreenX = cx - sz / 2;
        g.blobScreenY = cy - sz / 2;
        g.blobSize = sz;
        g.blobSelIdx = -1;
        g.blobAnim = BLOB_OPENING;
        g.blobStart = now_ms();
        memset(&g.blobData, 0, sizeof(BlobCB));
        // Apply colors if provided, else keep defaults
        auto fills = jsonGetFloatArray(line, "fills");
        if (fills.size() >= 15) {
            for (int i = 0; i < 5; i++) {
                g.blobData.fills[i][0] = fills[i*3+0];
                g.blobData.fills[i][1] = fills[i*3+1];
                g.blobData.fills[i][2] = fills[i*3+2];
                g.blobData.fills[i][3] = 0;
            }
        }
        auto sf = jsonGetFloatArray(line, "selFill");
        if (sf.size() >= 3) { g.blobData.selFill[0]=sf[0]; g.blobData.selFill[1]=sf[1]; g.blobData.selFill[2]=sf[2]; }
        auto cb = jsonGetFloatArray(line, "centerBg");
        if (cb.size() >= 3) { g.blobData.centerBg[0]=cb[0]; g.blobData.centerBg[1]=cb[1]; g.blobData.centerBg[2]=cb[2]; }
        auto st = jsonGetFloatArray(line, "stroke");
        if (st.size() >= 3) { g.blobData.stroke[0]=st[0]; g.blobData.stroke[1]=st[1]; g.blobData.stroke[2]=st[2]; }

        if (!IsWindowVisible(g.hwnd)) ShowWindow(g.hwnd, SW_SHOWNA);

    } else if (cmd == "hide_radial") {
        if (g.blobAnim == BLOB_OPENING || g.blobAnim == BLOB_SETTLED) {
            g.blobAnim = BLOB_CLOSING;
            g.blobStart = now_ms();
        }

    } else if (cmd == "radial_cursor") {
        float cx = (float)jsonGetNum(line, "x");
        float cy = (float)jsonGetNum(line, "y");
        // Compute which wedge is selected based on angle from center
        float dx = cx - g.blobScreenX - g.blobSize / 2;
        float dy = cy - g.blobScreenY - g.blobSize / 2;
        float dist = sqrtf(dx*dx + dy*dy);
        float innerR = 40.0f, outerR = 125.0f;
        if (dist >= innerR && dist <= outerR) {
            float angle = atan2f(dy, dx);
            float topAngle = fmodf(angle + 3.14159265f * 0.5f + 6.28318530f, 6.28318530f);
            g.blobSelIdx = floorf(topAngle / (6.28318530f / 5.0f));
        } else {
            g.blobSelIdx = -1.0f;
        }

    } else if (cmd == "show_voice") {
        g.creatureActive = true;
        g.creatureX = (float)jsonGetNum(line, "x");
        g.creatureY = (float)jsonGetNum(line, "y");
        g.creatureStartTime = now_ms();
        g.creatureBirth = 0.0f;  // start birth animation
        auto colors = jsonGetFloatArray(line, "colors");
        if (colors.size() >= 15) {
            for (int i = 0; i < 5; i++) {
                g.creatureColors[i][0] = colors[i*3+0];
                g.creatureColors[i][1] = colors[i*3+1];
                g.creatureColors[i][2] = colors[i*3+2];
            }
        }
        if (!IsWindowVisible(g.hwnd)) ShowWindow(g.hwnd, SW_SHOWNA);

    } else if (cmd == "hide_voice") {
        g.creatureActive = false;

    } else if (cmd == "voice_update") {
        g.creatureListening   = (float)jsonGetNum(line, "listening");
        g.creatureSpeaking    = (float)jsonGetNum(line, "speaking");
        g.creatureVoiceEnergy = (float)jsonGetNum(line, "energy");

    } else if (cmd == "creature_birth") {
        g.creatureBirth = (float)jsonGetNum(line, "value", 1.0);

    } else if (cmd == "creature_flash") {
        g.creatureFlash = 1.0f;

    } else if (cmd == "morph_forward") {
        std::string path = jsonGetStr(line, "screenshot");
        g.morphX = (float)jsonGetNum(line, "x");
        g.morphY = (float)jsonGetNum(line, "y");
        g.morphW = (float)jsonGetNum(line, "w");
        g.morphH = (float)jsonGetNum(line, "h");

        // Convert path to wide
        int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
        std::vector<wchar_t> wpath(wlen);
        MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);

        if (g.morphTex1SRV) { g.morphTex1SRV->Release(); g.morphTex1SRV = nullptr; }
        g.morphTex1SRV = loadTextureFromFile(wpath.data());

        g.morphPhase = MORPH_RIPPLING;
        g.morphMix = 0;
        g.morphStrength = 0;
        g.morphStartTime = now_ms();
        g.morphPhaseStart = g.morphStartTime;

        if (!IsWindowVisible(g.hwnd)) ShowWindow(g.hwnd, SW_SHOWNA);

    } else if (cmd == "morph_reverse") {
        std::string path = jsonGetStr(line, "screenshot");
        int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
        std::vector<wchar_t> wpath(wlen);
        MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);

        if (g.morphTex2SRV) { g.morphTex2SRV->Release(); g.morphTex2SRV = nullptr; }
        g.morphTex2SRV = loadTextureFromFile(wpath.data());

        g.morphPhase = MORPH_CROSSFADING;
        g.morphPhaseStart = now_ms();

    } else if (cmd == "morph_end") {
        g.morphPhase = MORPH_IDLE;
        if (g.morphTex1SRV) { g.morphTex1SRV->Release(); g.morphTex1SRV = nullptr; }
        if (g.morphTex2SRV) { g.morphTex2SRV->Release(); g.morphTex2SRV = nullptr; }

    } else if (cmd == "region_start") {
        g.regionActive = true;
        g.regionDragging = false;
        if (!IsWindowVisible(g.hwnd)) ShowWindow(g.hwnd, SW_SHOWNA);

    } else if (cmd == "region_end") {
        g.regionActive = false;
        g.regionDragging = false;

    } else if (cmd == "set_interactive") {
        g.interactive = jsonGetBool(line, "value");
        LONG exStyle = GetWindowLong(g.hwnd, GWL_EXSTYLE);
        if (g.interactive) {
            exStyle &= ~WS_EX_TRANSPARENT;
        } else {
            exStyle |= WS_EX_TRANSPARENT;
        }
        SetWindowLong(g.hwnd, GWL_EXSTYLE, exStyle);

    } else if (cmd == "respan") {
        int x = (int)jsonGetNum(line, "x");
        int y = (int)jsonGetNum(line, "y");
        int w = (int)jsonGetNum(line, "w");
        int h = (int)jsonGetNum(line, "h");
        SetWindowPos(g.hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
        resizeSwapChain(w, h);
        g.winX = x; g.winY = y;

    } else if (cmd == "set_colors") {
        auto fills = jsonGetFloatArray(line, "fills");
        if (fills.size() >= 15) {
            for (int i = 0; i < 5; i++) {
                g.blobData.fills[i][0] = fills[i*3+0];
                g.blobData.fills[i][1] = fills[i*3+1];
                g.blobData.fills[i][2] = fills[i*3+2];
            }
        }
        auto ccols = jsonGetFloatArray(line, "creature");
        if (ccols.size() >= 15) {
            for (int i = 0; i < 5; i++) {
                g.creatureColors[i][0] = ccols[i*3+0];
                g.creatureColors[i][1] = ccols[i*3+1];
                g.creatureColors[i][2] = ccols[i*3+2];
            }
        }

    } else if (cmd == "quit") {
        g.running = false;
        PostQuitMessage(0);
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 12 — Win32 window
// ════════════════════════════════════════════════════════════════════════════

static const int MIN_REGION_SIZE = 6;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_OVERLAY_CMD: {
            std::vector<std::string> cmds;
            {
                std::lock_guard<std::mutex> lock(g.cmdMutex);
                cmds.swap(g.pendingCmds);
            }
            for (auto& c : cmds) processCommand(c);
            return 0;
        }

        // ── Region capture mouse handling ──
        case WM_SETCURSOR:
            if (g.regionActive) {
                SetCursor(LoadCursor(nullptr, IDC_CROSS));
                return TRUE;
            }
            return DefWindowProcW(hwnd, msg, wp, lp);

        case WM_LBUTTONDOWN:
            if (g.regionActive) {
                SetCapture(hwnd);
                g.regionDragging = true;
                g.regionStartX = (float)LOWORD(lp);
                g.regionStartY = (float)HIWORD(lp);
                g.regionCurX = g.regionStartX;
                g.regionCurY = g.regionStartY;
                return 0;
            }
            break;

        case WM_MOUSEMOVE:
            if (g.regionActive && g.regionDragging) {
                g.regionCurX = (float)(short)LOWORD(lp);
                g.regionCurY = (float)(short)HIWORD(lp);
                return 0;
            }
            break;

        case WM_LBUTTONUP:
            if (g.regionActive && g.regionDragging) {
                ReleaseCapture();
                g.regionDragging = false;
                float endX = (float)(short)LOWORD(lp);
                float endY = (float)(short)HIWORD(lp);
                float selW = fabsf(endX - g.regionStartX);
                float selH = fabsf(endY - g.regionStartY);
                if (selW >= MIN_REGION_SIZE && selH >= MIN_REGION_SIZE) {
                    // Selection — send overlay-relative coords
                    float x = (std::min)(g.regionStartX, endX);
                    float y = (std::min)(g.regionStartY, endY);
                    sendJson("{\"event\":\"region_select\",\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f}",
                             x, y, selW, selH);
                } else {
                    // Click — send overlay-relative coords
                    sendJson("{\"event\":\"region_click\",\"x\":%.0f,\"y\":%.0f}", endX, endY);
                }
                g.regionActive = false;
                return 0;
            }
            break;

        case WM_RBUTTONDOWN:
        case WM_RBUTTONUP:
            if (g.regionActive) {
                if (g.regionDragging) ReleaseCapture();
                g.regionDragging = false;
                g.regionActive = false;
                sendJson("{\"event\":\"region_cancel\"}");
                return 0;
            }
            break;

        case WM_KEYDOWN:
            if (g.regionActive && wp == VK_ESCAPE) {
                if (g.regionDragging) ReleaseCapture();
                g.regionDragging = false;
                g.regionActive = false;
                sendJson("{\"event\":\"region_cancel\"}");
                return 0;
            }
            break;

        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wp, lp);
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static bool createWindow(HINSTANCE hInst) {
    WNDCLASSEXW wc{};
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = WndProc;
    wc.hInstance      = hInst;
    wc.lpszClassName  = L"StellaOverlay";
    RegisterClassExW(&wc);

    // Compute virtual screen bounds (all monitors)
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    g.winX = vx; g.winY = vy; g.winW = vw; g.winH = vh;

    g.hwnd = CreateWindowExW(
        WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
        L"StellaOverlay", L"",
        WS_POPUP,
        vx, vy, vw, vh,
        nullptr, nullptr, hInst, nullptr
    );

    return g.hwnd != nullptr;
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 13 — Stdin reader thread
// ════════════════════════════════════════════════════════════════════════════

static void stdinThread() {
    // Switch stdin to binary mode for reliable line reading
    _setmode(_fileno(stdin), _O_BINARY);

    std::string line;
    char buf[4096];
    while (g.running) {
        if (!fgets(buf, sizeof(buf), stdin)) {
            // EOF or error — parent process gone
            g.running = false;
            PostMessage(g.hwnd, WM_CLOSE, 0, 0);
            break;
        }
        line = buf;
        // Strip newline
        while (!line.empty() && (line.back() == '\n' || line.back() == '\r'))
            line.pop_back();
        if (line.empty()) continue;

        {
            std::lock_guard<std::mutex> lock(g.cmdMutex);
            g.pendingCmds.push_back(std::move(line));
        }
        PostMessage(g.hwnd, WM_OVERLAY_CMD, 0, 0);
        line.clear();
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Section 14 — Entry point
// ════════════════════════════════════════════════════════════════════════════

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, LPWSTR, int) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    // Redirect stdout to parent's pipe (already inherited)
    // Ensure line-buffered output
    setvbuf(stdout, nullptr, _IOLBF, 1024);

    if (!createWindow(hInst)) return 1;
    if (!initD3D())           return 1;
    createGlyphAtlas();

    // Show window (transparent initially)
    ShowWindow(g.hwnd, SW_SHOWNA);

    // Start stdin reader thread
    std::thread reader(stdinThread);
    reader.detach();

    // Signal ready
    sendJson("{\"event\":\"ready\"}");

    // ── Main loop: game-loop style with vsync ──
    MSG msg;
    while (g.running) {
        // Drain all pending messages
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) { g.running = false; break; }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (!g.running) break;

        if (isAnyActive()) {
            renderFrame();
        } else {
            // Nothing to render — wait for next message to save CPU
            WaitMessage();
        }
    }

    // ── Cleanup ──
    if (g.glyphSRV)    g.glyphSRV->Release();
    if (g.glyphSmp)    g.glyphSmp->Release();
    if (g.morphTex1SRV) g.morphTex1SRV->Release();
    if (g.morphTex2SRV) g.morphTex2SRV->Release();
    if (g.morphSmp)    g.morphSmp->Release();
    if (g.blobCBuf)    g.blobCBuf->Release();
    if (g.creatCBuf)   g.creatCBuf->Release();
    if (g.morphCBuf)   g.morphCBuf->Release();
    if (g.regionCBuf)  g.regionCBuf->Release();
    if (g.blobPS)      g.blobPS->Release();
    if (g.creatPS)     g.creatPS->Release();
    if (g.morphPS)     g.morphPS->Release();
    if (g.regionPS)    g.regionPS->Release();
    if (g.vs)          g.vs->Release();
    if (g.blendPre)    g.blendPre->Release();
    if (g.rtv)         g.rtv->Release();
    if (g.dcompVis)    g.dcompVis->Release();
    if (g.dcompTgt)    g.dcompTgt->Release();
    if (g.dcomp)       g.dcomp->Release();
    if (g.swap)        g.swap->Release();
    if (g.ctx)         g.ctx->Release();
    if (g.device)      g.device->Release();
    if (g.hwnd)        DestroyWindow(g.hwnd);

    CoUninitialize();
    return 0;
}
