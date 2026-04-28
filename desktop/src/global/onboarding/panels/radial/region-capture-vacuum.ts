const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_center;
uniform float u_strength;
uniform float u_aspect;
varying vec2 v_uv;

void main() {
  vec2 d = v_uv - u_center;
  d.x *= u_aspect;
  float dist = length(d);
  float n = dist / 2.0;
  float nc = clamp(n, 0.0, 1.0);

  float angle = u_strength * 0.8 * (1.0 - nc);
  float sn = sin(angle);
  float cs = cos(angle);
  d = vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);

  float exp = 1.0 / (1.0 + u_strength * 4.0);
  d *= min(pow(max(n, 0.001), exp - 1.0), 20.0);
  d.x /= u_aspect;

  vec2 uv = u_center + d;
  float inB = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 col = texture2D(u_tex, clamp(uv, 0.0, 1.0));
  col *= inB;

  float fadeR = max(1.0 - u_strength * u_strength * 3.0, 0.02);
  col.a *= 1.0 - smoothstep(fadeR * 0.5, fadeR, nc);

  col.rgb *= max(1.0 - u_strength * u_strength * (1.0 - nc), 0.0);

  gl_FragColor = col;
}`;

const DURATION = 650;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function createShader(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return shader;
}

export async function runVacuumEffect(
  canvas: HTMLCanvasElement,
  thumbnailUrl: string,
  centerX: number,
  centerY: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;

  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) return;

  let img: HTMLImageElement;
  try {
    img = await loadImage(thumbnailUrl);
  } catch {
    return;
  }
  if (signal?.aborted) return;

  canvas.width = img.width;
  canvas.height = img.height;
  gl.viewport(0, 0, img.width, img.height);

  const vs = createShader(gl, gl.VERTEX_SHADER, VERT);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  const prog = gl.createProgram();
  if (!prog) return;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const pos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.uniform2f(gl.getUniformLocation(prog, "u_center"), centerX, centerY);
  gl.uniform1f(gl.getUniformLocation(prog, "u_aspect"), img.width / img.height);
  const strengthLoc = gl.getUniformLocation(prog, "u_strength");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return new Promise<void>((resolve) => {
    const start = performance.now();
    let rafId = 0;
    let done = false;

    const cleanup = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };

    const finish = () => {
      if (done) return;
      done = true;
      if (rafId) cancelAnimationFrame(rafId);
      signal?.removeEventListener("abort", finish);
      cleanup();
      resolve();
    };

    if (signal?.aborted) {
      finish();
      return;
    }

    signal?.addEventListener("abort", finish, { once: true });

    const frame = (now: number) => {
      if (done) return;
      const t = Math.min((now - start) / DURATION, 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(strengthLoc, t * t * t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (t < 0.85) {
        rafId = requestAnimationFrame(frame);
      } else {
        finish();
      }
    };

    rafId = requestAnimationFrame(frame);
  });
}
