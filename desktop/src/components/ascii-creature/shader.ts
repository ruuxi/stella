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
  `;

  // Flowing organic patterns — 3 phases morphing smoothly
  return `${baseHeader}
    void main() {
      vec2 uv = vec2(gl_FragCoord.x / u_canvasSize.x, 1.0 - gl_FragCoord.y / u_canvasSize.y);

      // True circular distance using canvas pixel aspect ratio
      vec2 c = uv - 0.5;
      c.x *= u_canvasSize.x / u_canvasSize.y;
      float dist = length(c) * 2.0;
      float angle = atan(c.y, c.x);

      float cycle = u_time * 0.15;
      float phase = mod(cycle, 3.0);

      float w1 = max(0.0, 1.0 - abs(phase - 0.0)) + max(0.0, 1.0 - abs(phase - 3.0));
      float w2 = max(0.0, 1.0 - abs(phase - 1.0));
      float w3 = max(0.0, 1.0 - abs(phase - 2.0));
      float total = w1 + w2 + w3;
      w1 /= total; w2 /= total; w3 /= total;

      // Phase 1: Flowing spiral disk
      float i1 = 0.0;
      if (dist >= 0.15) {
        float spiralOffset = 1.0 / (dist + 0.05);
        float wave1 = sin(angle * 3.0 + spiralOffset * 2.0 - u_time * 3.0);
        float wave2 = cos(angle * 5.0 - spiralOffset * 3.0 + u_time * 2.0);
        float falloff = max(0.0, 1.0 - (dist - 0.15) * 1.5);
        float disk = exp(-pow((dist - 0.3) * 10.0, 2.0)) * 0.8;
        i1 = ((wave1 + wave2) * 0.5 + 0.5) * falloff + disk;
      }

      // Phase 2: Pulsing rays with radial waves
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

      // Phase 3: Organic breathing forms
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
