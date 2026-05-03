const compileShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string,
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

export const createProgram = (
  gl: WebGLRenderingContext,
  vs: string,
  fs: string,
) => {
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

export const getFragmentShader = (): string => {
  // CPU precomputes per-frame values that are constant across all pixels
  // (phase weights, eye origin & blink, canvas aspect).
  // This eliminates dozens of trig ops per pixel.
  const baseHeader = `
    precision mediump float;
    uniform vec2 u_canvasSize;
    uniform vec2 u_gridSize;
    uniform float u_time;
    uniform float u_charCount;
    uniform float u_birth;
    uniform float u_flash;
    uniform float u_listening;
    uniform float u_speaking;
    uniform float u_voiceEnergy;
    uniform float u_aspect;
    uniform vec3 u_phases;
    uniform vec2 u_eyeOrigin;
    uniform float u_eyeBlink;
    uniform sampler2D u_glyph;
    uniform vec3 u_colors[5];
  `;

  const baseColorLogic = `
    // Smooth color interpolation — evenly spread across intensity
    float colorPos = clamp(intensity * 4.0, 0.0, 3.999);
    float ci = floor(colorPos);
    float cf = smoothstep(0.0, 1.0, colorPos - ci);

    vec3 color;
    if (ci < 1.0) {
      color = mix(u_colors[0], u_colors[1], cf);
    } else if (ci < 2.0) {
      color = mix(u_colors[1], u_colors[2], cf);
    } else if (ci < 3.0) {
      color = mix(u_colors[2], u_colors[3], cf);
    } else {
      color = mix(u_colors[3], u_colors[4], cf);
    }

    // Mute center, vivify edges — inverted saturation gradient
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    float sat = mix(0.55, 1.4, 1.0 - intensity);
    color = mix(vec3(luma), color, sat);

    // Warm tint on outer dots
    float warm = (1.0 - intensity);
    color *= vec3(1.0 + warm * 0.2, 1.0 + warm * 0.07, 1.0 - warm * 0.1);

    // Expanding flash wave from center outward
    float waveRadius = (1.0 - u_flash) * 1.8;
    float waveWidth = 0.3;
    float waveDist = abs(dist - waveRadius);
    float waveIntensity = smoothstep(waveWidth, 0.0, waveDist) * u_flash;
    color *= 1.0 + waveIntensity * 2.0;

    gl_FragColor = vec4(color, glyphAlpha);

    // Eyes — origin and blink come from CPU
    float eyeGap = 5.0 / u_gridSize.x;
    vec2 eyeHalf = vec2(1.0 / u_gridSize.x, 1.5 / u_gridSize.y * u_eyeBlink);
    float leftEye = step(abs(uv.x - u_eyeOrigin.x + eyeGap), eyeHalf.x)
                  * step(abs(uv.y - u_eyeOrigin.y), eyeHalf.y);
    float rightEye = step(abs(uv.x - u_eyeOrigin.x - eyeGap), eyeHalf.x)
                   * step(abs(uv.y - u_eyeOrigin.y), eyeHalf.y);
    float eyeMask = max(leftEye, rightEye) * smoothstep(0.3, 0.6, u_birth);
    gl_FragColor = mix(gl_FragColor, vec4(u_colors[4], 1.0), eyeMask);
  `;

  // Flowing organic patterns — 3 phases morphing smoothly
  // GLSL helper: compute the 3-phase intensity at any distance
  const phaseFunction = `
    float computePhases(float d, float a, float w1, float w2, float w3) {
      float i1 = 0.0;
      if (w1 > 0.01 && d >= 0.15) {
        float so = 1.0 / (d + 0.05);
        float wv1 = sin(a * 3.0 + so * 2.0 - u_time * 3.0);
        float wv2 = cos(a * 5.0 - so * 3.0 + u_time * 2.0);
        float fo = max(0.0, 1.0 - (d - 0.15) * 1.5);
        float dk = exp(-pow((d - 0.3) * 10.0, 2.0)) * 0.8;
        i1 = ((wv1 + wv2) * 0.5 + 0.5) * fo + dk;
      }
      float i2 = 0.0;
      if (w2 > 0.01) {
        float t1 = u_time * 2.0;
        float p1 = sin(t1) * 0.5 + 0.5;
        float p2 = sin(t1 + 2.094) * 0.5 + 0.5;
        float p3 = sin(t1 + 4.188) * 0.5 + 0.5;
        float s1 = exp(-abs(mod(a + 0.0, 6.283) - 3.14) * 1.5) * p1;
        float s2 = exp(-abs(mod(a + 2.094, 6.283) - 3.14) * 1.5) * p2;
        float s3 = exp(-abs(mod(a + 4.188, 6.283) - 3.14) * 1.5) * p3;
        float rw = sin(d * 10.0 - u_time * 3.0) * 0.3 + 0.7;
        float rays = max(max(s1, s2), s3) * rw;
        float c2 = exp(-d * 4.0) * 0.8;
        float f2 = max(0.0, 1.0 - d * 0.8);
        i2 = rays * f2 + c2;
      }
      float i3 = 0.0;
      if (w3 > 0.01) {
        float br = sin(u_time * 0.4) * 0.5 + 0.5;
        float pt = sin(a * 7.0 + d * 8.0 + u_time * 0.5) * 0.5 + 0.5;
        pt *= exp(-d * 1.0);
        float fm = sin(a * 3.0 - u_time * 0.3) * 0.5 + 0.5;
        fm *= sin(d * 12.0 - u_time * 1.2) * 0.5 + 0.5;
        fm *= exp(-d * 1.5);
        float sf = exp(-d * 3.5) * (0.7 + br * 0.3);
        i3 = sf + mix(pt, fm, br) * 0.5;
      }
      return i1 * w1 + i2 * w2 + i3 * w3;
    }
  `;

  return `${baseHeader}
    ${phaseFunction}
    void main() {
      vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);

      // True circular distance using canvas pixel aspect ratio.
      // UV scale < EDGE_SCALE leaves room for expansion effects without clipping.
      vec2 c = (uv - 0.5) * 1.2;
      c.x *= u_aspect;
      float dist = length(c) * 2.0;

      // Early discard — pixels far from center are always transparent
      if (dist > 2.0) { gl_FragColor = vec4(0.0); return; }

      float angle = atan(c.y, c.x);

      float w1 = u_phases.x;
      float w2 = u_phases.y;
      float w3 = u_phases.z;

      // Base intensity from the 3 idle phases. When listening or speaking is
      // dominant the base contribution is mixed out by ~mix() to <1%, so skip
      // the work entirely in that regime.
      float intensity = 0.0;
      if (max(u_listening, u_speaking) < 0.99) {
        intensity = computePhases(dist, angle, w1, w2, w3);
      }

      // Voice: Listening — contract inward, pulsing concentration
      if (u_listening > 0.01) {
        float squeezedDist = dist * (1.0 + u_listening * 0.5);
        float squeezedIntensity = computePhases(squeezedDist, angle, w1, w2, w3);
        intensity = mix(intensity, squeezedIntensity, u_listening);

        // Inward-flowing rings overlay
        float rings = sin(dist * 20.0 + u_time * 5.0) * 0.5 + 0.5;
        rings *= smoothstep(0.5, 0.1, dist);
        intensity += rings * u_listening * 0.3;

        // Mic energy: pulse brighter
        intensity *= 1.0 + u_voiceEnergy * u_listening * 0.8;
      }

      // Voice: Speaking — expand outward, pulse with energy
      if (u_speaking > 0.01) {
        float expandedDist = dist / (1.0 + u_speaking * 0.08 + u_voiceEnergy * 0.12);
        float expandedIntensity = computePhases(expandedDist, angle, w1, w2, w3);
        intensity = mix(intensity, expandedIntensity, u_speaking);

        // Outward-flowing waves
        float waves = sin(dist * 10.0 - u_time * 8.0) * 0.5 + 0.5;
        waves *= smoothstep(1.2, 0.1, dist) * u_voiceEnergy;
        intensity += waves * u_speaking * 0.4;

        // Overall energy boost
        intensity *= 1.0 + u_speaking * u_voiceEnergy * 0.4;
      }

      intensity = min(intensity, 1.0);

      // Birth animation
      float birthRadius = u_birth * 1.5;
      float birthEdge = smoothstep(birthRadius, birthRadius - 0.3, dist);
      float smallness = 1.0 - u_birth;
      float pulseSpeed = 5.0 + smallness * 2.0;
      float pulseStrength = smallness * 0.5;
      float birthPulse = 1.0 + sin(dist * 25.0 - u_time * pulseSpeed) * pulseStrength;
      float breathe2 = 1.0 + sin(u_time * 1.5) * 0.15 * smallness;
      intensity *= birthEdge * birthPulse * breathe2;
      intensity *= sqrt(u_birth);

      float charIndex = floor(intensity * (u_charCount - 1.0));

      vec2 cellLocal = fract(uv * u_gridSize);
      vec2 glyphUV = vec2((cellLocal.x + charIndex) / u_charCount, cellLocal.y);
      float glyphAlpha = texture2D(u_glyph, glyphUV).a;
      ${baseColorLogic}
    }
  `;
};

export const getInstancedVertexShader = (): string => `
  precision mediump float;

  attribute vec2 a_corner;
  attribute vec2 a_cell;

  uniform vec2 u_gridSize;
  uniform float u_time;
  uniform float u_charCount;
  uniform float u_birth;
  uniform float u_flash;
  uniform float u_listening;
  uniform float u_speaking;
  uniform float u_voiceEnergy;
  uniform float u_aspect;
  uniform vec3 u_phases;
  uniform vec2 u_eyeOrigin;
  uniform float u_eyeBlink;
  uniform vec3 u_colors[5];

  varying vec2 v_glyphUv;
  varying float v_charIndex;
  varying vec3 v_color;
  varying float v_solidAlpha;
  varying float v_visible;

  float computePhases(float d, float a, float w1, float w2, float w3) {
    float i1 = 0.0;
    if (w1 > 0.01 && d >= 0.15) {
      float so = 1.0 / (d + 0.05);
      float wv1 = sin(a * 3.0 + so * 2.0 - u_time * 3.0);
      float wv2 = cos(a * 5.0 - so * 3.0 + u_time * 2.0);
      float fo = max(0.0, 1.0 - (d - 0.15) * 1.5);
      float dk = exp(-pow((d - 0.3) * 10.0, 2.0)) * 0.8;
      i1 = ((wv1 + wv2) * 0.5 + 0.5) * fo + dk;
    }
    float i2 = 0.0;
    if (w2 > 0.01) {
      float t1 = u_time * 2.0;
      float p1 = sin(t1) * 0.5 + 0.5;
      float p2 = sin(t1 + 2.094) * 0.5 + 0.5;
      float p3 = sin(t1 + 4.188) * 0.5 + 0.5;
      float s1 = exp(-abs(mod(a + 0.0, 6.283) - 3.14) * 1.5) * p1;
      float s2 = exp(-abs(mod(a + 2.094, 6.283) - 3.14) * 1.5) * p2;
      float s3 = exp(-abs(mod(a + 4.188, 6.283) - 3.14) * 1.5) * p3;
      float rw = sin(d * 10.0 - u_time * 3.0) * 0.3 + 0.7;
      float rays = max(max(s1, s2), s3) * rw;
      float c2 = exp(-d * 4.0) * 0.8;
      float f2 = max(0.0, 1.0 - d * 0.8);
      i2 = rays * f2 + c2;
    }
    float i3 = 0.0;
    if (w3 > 0.01) {
      float br = sin(u_time * 0.4) * 0.5 + 0.5;
      float pt = sin(a * 7.0 + d * 8.0 + u_time * 0.5) * 0.5 + 0.5;
      pt *= exp(-d * 1.0);
      float fm = sin(a * 3.0 - u_time * 0.3) * 0.5 + 0.5;
      fm *= sin(d * 12.0 - u_time * 1.2) * 0.5 + 0.5;
      fm *= exp(-d * 1.5);
      float sf = exp(-d * 3.5) * (0.7 + br * 0.3);
      i3 = sf + mix(pt, fm, br) * 0.5;
    }
    return i1 * w1 + i2 * w2 + i3 * w3;
  }

  vec3 colorForIntensity(float intensity, float dist) {
    float colorPos = clamp(intensity * 4.0, 0.0, 3.999);
    float ci = floor(colorPos);
    float cf = smoothstep(0.0, 1.0, colorPos - ci);

    vec3 color;
    if (ci < 1.0) {
      color = mix(u_colors[0], u_colors[1], cf);
    } else if (ci < 2.0) {
      color = mix(u_colors[1], u_colors[2], cf);
    } else if (ci < 3.0) {
      color = mix(u_colors[2], u_colors[3], cf);
    } else {
      color = mix(u_colors[3], u_colors[4], cf);
    }

    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    float sat = mix(0.55, 1.4, 1.0 - intensity);
    color = mix(vec3(luma), color, sat);

    float warm = 1.0 - intensity;
    color *= vec3(1.0 + warm * 0.2, 1.0 + warm * 0.07, 1.0 - warm * 0.1);

    float waveRadius = (1.0 - u_flash) * 1.8;
    float waveWidth = 0.3;
    float waveDist = abs(dist - waveRadius);
    float waveIntensity = smoothstep(waveWidth, 0.0, waveDist) * u_flash;
    return color * (1.0 + waveIntensity * 2.0);
  }

  void main() {
    vec2 gridPos = a_cell + a_corner;
    vec2 clip = vec2(gridPos.x / u_gridSize.x * 2.0 - 1.0, 1.0 - gridPos.y / u_gridSize.y * 2.0);
    gl_Position = vec4(clip, 0.0, 1.0);

    vec2 uv = (a_cell + 0.5) / u_gridSize;
    vec2 c = (uv - 0.5) * 1.2;
    c.x *= u_aspect;
    float dist = length(c) * 2.0;
    v_visible = step(dist, 2.0);

    float angle = atan(c.y, c.x);
    float w1 = u_phases.x;
    float w2 = u_phases.y;
    float w3 = u_phases.z;

    float intensity = 0.0;
    if (max(u_listening, u_speaking) < 0.99) {
      intensity = computePhases(dist, angle, w1, w2, w3);
    }

    if (u_listening > 0.01) {
      float squeezedDist = dist * (1.0 + u_listening * 0.5);
      float squeezedIntensity = computePhases(squeezedDist, angle, w1, w2, w3);
      intensity = mix(intensity, squeezedIntensity, u_listening);

      float rings = sin(dist * 20.0 + u_time * 5.0) * 0.5 + 0.5;
      rings *= smoothstep(0.5, 0.1, dist);
      intensity += rings * u_listening * 0.3;
      intensity *= 1.0 + u_voiceEnergy * u_listening * 0.8;
    }

    if (u_speaking > 0.01) {
      float expandedDist = dist / (1.0 + u_speaking * 0.08 + u_voiceEnergy * 0.12);
      float expandedIntensity = computePhases(expandedDist, angle, w1, w2, w3);
      intensity = mix(intensity, expandedIntensity, u_speaking);

      float waves = sin(dist * 10.0 - u_time * 8.0) * 0.5 + 0.5;
      waves *= smoothstep(1.2, 0.1, dist) * u_voiceEnergy;
      intensity += waves * u_speaking * 0.4;
      intensity *= 1.0 + u_speaking * u_voiceEnergy * 0.4;
    }

    intensity = min(intensity, 1.0);

    float birthRadius = u_birth * 1.5;
    float birthEdge = smoothstep(birthRadius, birthRadius - 0.3, dist);
    float smallness = 1.0 - u_birth;
    float pulseSpeed = 5.0 + smallness * 2.0;
    float pulseStrength = smallness * 0.5;
    float birthPulse = 1.0 + sin(dist * 25.0 - u_time * pulseSpeed) * pulseStrength;
    float breathe2 = 1.0 + sin(u_time * 1.5) * 0.15 * smallness;
    intensity *= birthEdge * birthPulse * breathe2;
    intensity *= sqrt(u_birth);
    intensity = clamp(intensity, 0.0, 1.0);

    vec3 color = colorForIntensity(intensity, dist);

    float eyeGap = 5.0 / u_gridSize.x;
    vec2 eyeHalf = vec2(1.0 / u_gridSize.x, 1.5 / u_gridSize.y * u_eyeBlink);
    float leftEye = step(abs(uv.x - u_eyeOrigin.x + eyeGap), eyeHalf.x)
                  * step(abs(uv.y - u_eyeOrigin.y), eyeHalf.y);
    float rightEye = step(abs(uv.x - u_eyeOrigin.x - eyeGap), eyeHalf.x)
                   * step(abs(uv.y - u_eyeOrigin.y), eyeHalf.y);
    float solidMask = max(leftEye, rightEye) * smoothstep(0.3, 0.6, u_birth) * v_visible;
    v_color = mix(color, u_colors[4], solidMask);
    v_solidAlpha = solidMask;
    v_charIndex = floor(intensity * (u_charCount - 1.0));
    v_glyphUv = a_corner;
  }
`;

export const getInstancedFragmentShader = (): string => `
  precision mediump float;

  uniform float u_charCount;
  uniform sampler2D u_glyph;

  varying vec2 v_glyphUv;
  varying float v_charIndex;
  varying vec3 v_color;
  varying float v_solidAlpha;
  varying float v_visible;

  void main() {
    if (v_visible < 0.5) {
      discard;
    }

    vec2 glyphUV = vec2((v_glyphUv.x + v_charIndex) / u_charCount, v_glyphUv.y);
    float glyphAlpha = texture2D(u_glyph, glyphUV).a;
    float alpha = max(glyphAlpha, v_solidAlpha);
    if (alpha <= 0.001) {
      discard;
    }
    gl_FragColor = vec4(v_color, alpha);
  }
`;
