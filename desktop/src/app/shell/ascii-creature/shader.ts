export const compileShader = (
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
  const baseHeader = `
    precision mediump float;
    uniform vec2 u_canvasSize;
    uniform vec2 u_gridSize;
    uniform float u_time;
    uniform float u_charCount;
    uniform float u_birth;
    uniform float u_flash;
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

    // Eyes — rectangular dots
    float eyeGap = 5.0 / u_gridSize.x;
    float eyeUp = 2.5 / u_gridSize.y;

    // Eyes follow animation phases via w1/w2/w3
    // Phase 1: orbital drift matching spiral rotation
    float eyeAngle = -u_time * 2.5;
    vec2 drift1 = vec2(cos(eyeAngle), sin(eyeAngle)) * 1.1;

    // Phase 2: pull toward dominant pulsing ray
    float et = u_time * 2.0;
    float ep1 = sin(et) * 0.5 + 0.5;
    float ep2 = sin(et + 2.094) * 0.5 + 0.5;
    float ep3 = sin(et + 4.188) * 0.5 + 0.5;
    float epSum = ep1 + ep2 + ep3;
    vec2 drift2 = (vec2(1.0, 0.0) * ep1
                 + vec2(-0.5, 0.866) * ep2
                 + vec2(-0.5, -0.866) * ep3) / epSum * 1.8;

    // Phase 3: breathing vertical shift
    vec2 drift3 = vec2(0.0, -sin(u_time * 0.4)) * 0.9;

    vec2 eyeDrift = drift1 * w1 + drift2 * w2 + drift3 * w3;
    vec2 eyeOrigin = vec2(0.5 + eyeDrift.x / u_gridSize.x, 0.5 - eyeUp + eyeDrift.y / u_gridSize.y);

    // Pseudo-random blink — hash each time slot for natural timing
    float blinkSlot = floor(u_time / 0.8);
    float blinkHash = fract(sin(blinkSlot * 91.7) * 43758.5453);
    float blinkLocal = fract(u_time / 0.8);
    float doBlink = step(0.65, blinkHash);

    // Quick V-shaped close-open
    float bt = clamp(blinkLocal / 0.1, 0.0, 1.0);
    float blinkCurve = smoothstep(0.0, 1.0, abs(bt * 2.0 - 1.0));
    float blink = mix(1.0, blinkCurve, doBlink);

    // Occasional double-blink (~20% of blinks)
    float dblHash = fract(sin(blinkSlot * 73.3) * 28461.7);
    float doDouble = step(0.8, dblHash) * doBlink;
    float bt2 = clamp((blinkLocal - 0.15) / 0.1, 0.0, 1.0);
    float dblCurve = smoothstep(0.0, 1.0, abs(bt2 * 2.0 - 1.0));
    blink *= mix(1.0, dblCurve, doDouble);

    vec2 eyeHalf = vec2(1.0 / u_gridSize.x, 1.5 / u_gridSize.y * blink);
    float leftEye = step(abs(uv.x - eyeOrigin.x + eyeGap), eyeHalf.x)
                  * step(abs(uv.y - eyeOrigin.y), eyeHalf.y);
    float rightEye = step(abs(uv.x - eyeOrigin.x - eyeGap), eyeHalf.x)
                   * step(abs(uv.y - eyeOrigin.y), eyeHalf.y);
    float eyeMask = max(leftEye, rightEye) * smoothstep(0.3, 0.6, u_birth);
    gl_FragColor = mix(gl_FragColor, vec4(u_colors[4], 1.0), eyeMask);

    // Mouth — expressive shapes that follow the face
    vec2 mouthPos = vec2(eyeOrigin.x, eyeOrigin.y + 3.5 / u_gridSize.y);

    // Pseudo-random timing and shape selection
    float mouthSlot = floor(u_time / 2.5);
    float mouthHash = fract(sin(mouthSlot * 47.3) * 31718.9);
    float shapeHash = fract(sin(mouthSlot * 113.1) * 18734.3);
    float mouthLocal = fract(u_time / 2.5);

    float doOpen = step(0.70, mouthHash);

    // Shape selection — equal 20% each via separate hash
    float isO =     (1.0 - step(0.2, shapeHash));
    float isSmile = step(0.2, shapeHash) * (1.0 - step(0.4, shapeHash));
    float isFrown = step(0.4, shapeHash) * (1.0 - step(0.6, shapeHash));
    float isSideV = step(0.6, shapeHash) * (1.0 - step(0.8, shapeHash));
    float isDash =  step(0.8, shapeHash);

    // Open/close animation — longer hold
    float openUp = smoothstep(0.0, 0.08, mouthLocal);
    float closeDown = 1.0 - smoothstep(0.6, 0.8, mouthLocal);
    float mouthAnim = openUp * closeDown * doOpen;

    vec2 md = (uv - mouthPos) * u_gridSize;
    float lineW = 0.5;

    // Compute only the active mouth shape
    float mouthShape = 0.0;
    if (isO > 0.5) {
      vec2 mdO = md;
      mdO.y /= max(mouthAnim, 0.15);
      float oDist = length(mdO);
      mouthShape = smoothstep(1.8, 1.5, oDist) * smoothstep(0.5, 0.8, oDist);
    } else if (isSmile > 0.5) {
      float smileDist = abs(md.y - 0.6 + 0.7 * abs(md.x));
      mouthShape = (1.0 - smoothstep(lineW * 0.5, lineW, smileDist)) * step(abs(md.x), 1.8);
    } else if (isFrown > 0.5) {
      float frownDist = abs(md.y + 0.6 - 0.7 * abs(md.x));
      mouthShape = (1.0 - smoothstep(lineW * 0.5, lineW, frownDist)) * step(abs(md.x), 1.8);
    } else if (isSideV > 0.5) {
      float sideDist = abs(md.x - 0.8 + 0.6 * abs(md.y));
      mouthShape = (1.0 - smoothstep(lineW * 0.5, lineW, sideDist)) * step(abs(md.y), 1.2);
    } else if (isDash > 0.5) {
      mouthShape = (1.0 - smoothstep(lineW * 0.3, lineW * 0.7, abs(md.y))) * step(abs(md.x), 1.5);
    }
    mouthShape *= smoothstep(0.05, 0.2, mouthAnim);
    float mouthMask = mouthShape * smoothstep(0.3, 0.6, u_birth);
    gl_FragColor = mix(gl_FragColor, vec4(u_colors[4], 1.0), mouthMask);
  `;

  // Flowing organic patterns — 3 phases morphing smoothly
  return `${baseHeader}
    void main() {
      vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);

      // True circular distance using canvas pixel aspect ratio
      vec2 c = uv - 0.5;
      c.x *= u_canvasSize.x / u_canvasSize.y;
      float dist = length(c) * 2.0;

      // Early discard — pixels far from center are always transparent
      if (dist > 1.2) { gl_FragColor = vec4(0.0); return; }

      float angle = atan(c.y, c.x);

      float cycle = u_time * 0.15;
      float phase = mod(cycle, 3.0);

      float w1 = max(0.0, 1.0 - abs(phase - 0.0)) + max(0.0, 1.0 - abs(phase - 3.0));
      float w2 = max(0.0, 1.0 - abs(phase - 1.0));
      float w3 = max(0.0, 1.0 - abs(phase - 2.0));
      float total = w1 + w2 + w3;
      w1 /= total; w2 /= total; w3 /= total;

      // Phase 1: Flowing spiral disk (skip when weight ≈ 0)
      float i1 = 0.0;
      if (w1 > 0.01 && dist >= 0.15) {
        float spiralOffset = 1.0 / (dist + 0.05);
        float wave1 = sin(angle * 3.0 + spiralOffset * 2.0 - u_time * 3.0);
        float wave2 = cos(angle * 5.0 - spiralOffset * 3.0 + u_time * 2.0);
        float falloff = max(0.0, 1.0 - (dist - 0.15) * 1.5);
        float disk = exp(-pow((dist - 0.3) * 10.0, 2.0)) * 0.8;
        i1 = ((wave1 + wave2) * 0.5 + 0.5) * falloff + disk;
      }

      // Phase 2: Pulsing rays with radial waves (skip when weight ≈ 0)
      float i2 = 0.0;
      if (w2 > 0.01) {
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
        i2 = rays * falloff2 + core2;
      }

      // Phase 3: Organic breathing forms (skip when weight ≈ 0)
      float i3 = 0.0;
      if (w3 > 0.01) {
        float breathe = sin(u_time * 0.4) * 0.5 + 0.5;
        float potential = sin(angle * 7.0 + dist * 8.0 + u_time * 0.5) * 0.5 + 0.5;
        potential *= exp(-dist * 1.0);
        float form = sin(angle * 3.0 - u_time * 0.3) * 0.5 + 0.5;
        form *= sin(dist * 12.0 - u_time * 1.2) * 0.5 + 0.5;
        form *= exp(-dist * 1.5);
        float self = exp(-dist * 3.5) * (0.7 + breathe * 0.3);
        i3 = self + mix(potential, form, breathe) * 0.5;
      }

      float intensity = i1 * w1 + i2 * w2 + i3 * w3;
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
