(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('gl'), video = $('cam');
  const startEl = $('start'), msgEl = $('msg'), barEl = $('bar');
  const toastEl = $('toast'), hintEl = $('hint'), flipBtn = $('flip');

  // ---------- Tunables ----------
  const MAX_DPR = 2;                                   // retina is enough; 3x triples fill cost
  const TIERS = [12000, 22000, 40000, 65000, 100000];  // particle counts
  const MAX_TOUCH = 8;
  const STYLES = ['True colour', 'Neon', 'Mono', 'Thermal'];

  // ---------- State ----------
  let gl, prog, loc = {}, buf, tex;
  let count = 0, cell = 1, W = 0, H = 0;
  let tier = 2, locked = false, steppedUp = false, goodWindows = 0;
  let perfT = 0, perfN = 0, perfSkip = true;
  let source = null;            // 'cam' | 'demo'
  let stream = null, facing = 'user';
  let lastVideoTime = -1, srcW = 4, srcH = 3;
  let style = 0;
  let running = false, raf = 0, last = 0, time = 0;
  let explodeAt = -99;
  const touches = new Float32Array(MAX_TOUCH * 3);     // x, y (device px), strength
  const pointerSlot = new Map();
  let nextSlot = 0;

  try { style = +(localStorage.getItem('pm-style') || 0) % STYLES.length; } catch (e) {}

  // ---------- Shaders ----------
  const VS = `
    attribute vec2 a_uv;
    attribute vec2 a_rnd;
    uniform sampler2D u_tex;
    uniform vec2 u_res;
    uniform vec2 u_crop;
    uniform float u_mirror;
    uniform float u_cell;
    uniform float u_time;
    uniform float u_explode;
    uniform float u_style;
    uniform vec3 u_touch[${MAX_TOUCH}];
    varying vec3 v_col;

    vec3 thermal(float t) {
      return clamp(vec3(1.5 * t - 0.2, 1.8 * t - 0.7, 0.9 - 2.2 * abs(t - 0.3) + max(0.0, 3.0 * t - 2.2)), 0.0, 1.0);
    }

    void main() {
      vec2 uv = (a_uv - 0.5) * u_crop + 0.5;
      uv.x = mix(uv.x, 1.0 - uv.x, u_mirror);
      vec3 c = texture2D(u_tex, uv).rgb;
      float lum = dot(c, vec3(0.299, 0.587, 0.114));

      vec2 p = a_uv * u_res;
      float m = min(u_res.x, u_res.y);

      // gentle life: shimmer + brightness pushes outward from the centre
      p += vec2(sin(u_time * 1.7 + a_rnd.x * 6.283), cos(u_time * 1.3 + a_rnd.y * 6.283)) * u_cell * 0.18;
      p += (p - u_res * 0.5) * lum * 0.035;

      // finger trail: push away, swirl, scatter
      float r = m * 0.2;
      float push = 0.0;
      for (int i = 0; i < ${MAX_TOUCH}; i++) {
        vec3 t = u_touch[i];
        vec2 d = p - t.xy;
        float f = t.z * exp(-dot(d, d) / (r * r));
        vec2 n = d / (length(d) + 0.001);
        p += (n * 0.85 + vec2(-n.y, n.x) * 0.45 + (a_rnd - 0.5) * 1.3) * f * r;
        push += f;
      }

      // full explosion
      vec2 dir = a_rnd - 0.5;
      dir = dir / (length(dir) + 0.001);
      float far = 0.25 + fract(a_rnd.x * 7.31 + a_rnd.y * 3.17);
      p += (dir + vec2(-dir.y, dir.x) * 0.6 * u_explode) * u_explode * far * max(u_res.x, u_res.y) * 0.7;

      vec3 col;
      if (u_style < 0.5) {
        col = mix(vec3(lum), c, 1.25) * (0.3 + 0.9 * lum);
      } else if (u_style < 1.5) {
        vec3 a = mix(vec3(0.1, 0.9, 1.0), vec3(1.0, 0.2, 0.8), a_uv.y + 0.25 * sin(u_time * 0.4 + a_uv.x * 3.0));
        col = mix(vec3(0.35, 0.2, 1.0), a, lum) * (0.15 + 1.1 * lum);
      } else if (u_style < 2.5) {
        col = vec3(0.92, 0.96, 1.0) * lum * lum * 1.15;
      } else {
        col = thermal(lum) * (0.25 + 0.85 * lum);
      }
      col += vec3(0.5, 0.7, 1.0) * min(push, 1.0) * 0.25;
      v_col = col;

      vec2 clip = p / u_res * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      gl_PointSize = u_cell * (0.3 + 1.2 * lum) * (1.0 + 0.6 * min(push, 1.0) + 0.8 * u_explode);
    }`;

  const FS = `
    precision mediump float;
    varying vec3 v_col;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.12, d);
      gl_FragColor = vec4(v_col * a, 1.0);
    }`;

  // ---------- GL setup ----------
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function initGL() {
    gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL is not available on this device.');
    if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 1) throw new Error('This device cannot run the particle effect.');

    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'a_uv');
    gl.bindAttribLocation(prog, 1, 'a_rnd');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ['u_tex', 'u_res', 'u_crop', 'u_mirror', 'u_cell', 'u_time', 'u_explode', 'u_style', 'u_touch'])
      loc[n] = gl.getUniformLocation(prog, n);

    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    gl.uniform1i(loc.u_tex, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 1);
    lastVideoTime = -1;
  }

  function buildGrid() {
    const aspect = W / H;
    const cols = Math.max(8, Math.round(Math.sqrt(TIERS[tier] * aspect)));
    const rows = Math.max(8, Math.round(cols / aspect));
    count = cols * rows;
    cell = (W / cols) * 1.35;
    const data = new Float32Array(count * 4);
    let k = 0;
    for (let y = 0; y < rows; y++) {
      const off = (y & 1) ? 0.5 : 0;                    // staggered rows read as a finer grid
      for (let x = 0; x < cols; x++) {
        data[k++] = (x + 0.25 + off) / cols;
        data[k++] = (y + 0.5) / rows;
        data[k++] = Math.random();
        data[k++] = Math.random();
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    perfSkip = true; perfT = 0; perfN = 0;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w === W && h === H) return;
    W = canvas.width = w; H = canvas.height = h;
    gl.viewport(0, 0, W, H);
    buildGrid();
  }

  // ---------- Image sources ----------
  const demoCanvas = document.createElement('canvas');
  demoCanvas.width = 96; demoCanvas.height = 128;
  const demoCtx = demoCanvas.getContext('2d');
  let demoLast = 0;

  function drawDemo(t) {
    const c = demoCtx, w = 96, h = 128;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = w * (0.5 + 0.36 * Math.sin(t * (0.5 + i * 0.13) + i * 2.1));
      const y = h * (0.5 + 0.38 * Math.cos(t * (0.4 + i * 0.11) + i * 1.3));
      const r = 26 + 10 * Math.sin(t * 0.7 + i);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${(i * 72 + t * 25) % 360}, 95%, 62%, 0.95)`);
      g.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }
  }

  function updateSource() {
    if (source === 'cam') {
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      srcW = video.videoWidth || srcW; srcH = video.videoHeight || srcH;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    } else if (source === 'demo') {
      if (time - demoLast < 1 / 30) return;
      demoLast = time;
      drawDemo(time);
      srcW = 96; srcH = 128;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, demoCanvas);
    }
  }

  function stopStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('Camera is not available here. Open this page in Safari over HTTPS.');
    stopStream();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // 640x480 is plenty: each particle samples one pixel, and small frames upload fast
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    });
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (source === 'cam') showStart('Camera stopped. Tap to start again.'); });
    video.srcObject = stream;
    await video.play();
    lastVideoTime = -1;
    source = 'cam';
  }

  function cameraErrorText(e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
      return 'Camera access was blocked. Allow it in Settings → Safari → Camera, then try again.';
    if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) return 'No camera was found on this device.';
    if (e && e.name === 'NotReadableError') return 'Another app is using the camera. Close it and try again.';
    return (e && e.message) || 'The camera could not be started.';
  }

  // ---------- Render loop ----------
  function explodeValue() {
    const t = time - explodeAt;
    if (t < 0 || t > 4) return 0;
    if (t < 0.14) { const k = t / 0.14; return k * (2 - k); }
    if (t < 0.55) return 1;
    return Math.exp(-(t - 0.55) * 3.6);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now; time += dt;

    resize();
    updateSource();

    const decay = Math.exp(-dt * 2.6);
    for (let i = 0; i < MAX_TOUCH; i++) touches[i * 3 + 2] *= decay;
    pointerSlot.forEach((s) => { touches[s * 3 + 2] = 1; });

    const sa = W / H, va = srcW / srcH;
    gl.uniform2f(loc.u_crop, va > sa ? sa / va : 1, va > sa ? 1 : va / sa);
    gl.uniform2f(loc.u_res, W, H);
    gl.uniform1f(loc.u_mirror, source === 'cam' && facing === 'user' ? 1 : 0);
    gl.uniform1f(loc.u_cell, cell);
    gl.uniform1f(loc.u_time, time);
    gl.uniform1f(loc.u_explode, explodeValue());
    gl.uniform1f(loc.u_style, style);
    gl.uniform3fv(loc.u_touch, touches);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);

    adaptQuality(dt);
  }

  // Drop particle count if the phone can't hold 60fps; try one step up if it is cruising.
  function adaptQuality(dt) {
    perfT += dt; perfN++;
    if (perfT < 1.5) return;
    const avg = (perfT / perfN) * 1000;
    perfT = 0; perfN = 0;
    if (perfSkip) { perfSkip = false; return; }          // first window after a rebuild is noisy
    if (avg > 21 && tier > 0) {
      tier--; if (steppedUp) locked = true;
      goodWindows = 0; buildGrid();
    } else if (avg < 17.4 && !locked && tier < TIERS.length - 1) {
      if (++goodWindows >= 2) { tier++; steppedUp = true; goodWindows = 0; buildGrid(); }
    } else {
      goodWindows = 0;
    }
  }

  function run() {
    if (running || !source) return;
    running = true; last = performance.now(); perfSkip = true; perfT = 0; perfN = 0;
    raf = requestAnimationFrame(frame);
  }
  function halt() { running = false; cancelAnimationFrame(raf); }

  // ---------- Input ----------
  function setTouch(slot, e) {
    const r = canvas.getBoundingClientRect();
    touches[slot * 3] = (e.clientX - r.left) / r.width * W;
    touches[slot * 3 + 1] = (e.clientY - r.top) / r.height * H;
    touches[slot * 3 + 2] = 1;
  }
  let lastTap = 0, lastTapX = 0, lastTapY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const slot = nextSlot; nextSlot = (nextSlot + 1) % MAX_TOUCH;
    pointerSlot.set(e.pointerId, slot);
    setTouch(slot, e);
    hintEl.classList.remove('show');
    const now = performance.now();
    if (now - lastTap < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 44) { explodeAt = time; lastTap = 0; }
    else { lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY; }
  });
  canvas.addEventListener('pointermove', (e) => {
    const slot = pointerSlot.get(e.pointerId);
    if (slot === undefined) return;
    const dx = (e.clientX / canvas.clientWidth) * W - touches[slot * 3];
    const dy = (e.clientY / canvas.clientHeight) * H - touches[slot * 3 + 1];
    // leave a fading trail: hop to a fresh slot once the finger has travelled far enough
    if (dx * dx + dy * dy > Math.pow(Math.min(W, H) * 0.07, 2)) {
      let s = nextSlot;
      for (let i = 0; i < MAX_TOUCH; i++) {               // never steal a slot another finger holds
        let held = false;
        pointerSlot.forEach((v) => { if (v === s) held = true; });
        if (!held) break;
        s = (s + 1) % MAX_TOUCH;
      }
      nextSlot = (s + 1) % MAX_TOUCH;
      pointerSlot.set(e.pointerId, s);
      setTouch(s, e);
    }
  });
  const release = (e) => pointerSlot.delete(e.pointerId);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // block pinch zoom, double-tap zoom and the long-press menu
  for (const ev of ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick'])
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // ---------- UI ----------
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text; toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1300);
  }

  function showStart(message) {
    halt(); stopStream(); source = null;
    msgEl.textContent = message || '';
    barEl.hidden = true;
    startEl.classList.remove('hidden');
  }

  function enter() {
    startEl.classList.add('hidden');
    barEl.hidden = false;
    flipBtn.hidden = source !== 'cam';
    hintEl.classList.add('show');
    setTimeout(() => hintEl.classList.remove('show'), 4500);
    run();
  }

  let busy = false;
  $('go').addEventListener('click', async () => {
    if (busy) return;
    busy = true; msgEl.textContent = '';
    try { await startCamera(); enter(); }
    catch (e) { stopStream(); msgEl.textContent = cameraErrorText(e); }
    busy = false;
  });
  $('demo').addEventListener('click', () => { stopStream(); source = 'demo'; enter(); });

  $('style').addEventListener('click', () => {
    style = (style + 1) % STYLES.length;
    try { localStorage.setItem('pm-style', style); } catch (e) {}
    toast(STYLES[style]);
  });
  flipBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const prev = facing;
    facing = facing === 'user' ? 'environment' : 'user';
    try { await startCamera(); explodeAt = time; }
    catch (e) {
      facing = prev;
      try { await startCamera(); toast('No other camera'); }
      catch (e2) { showStart(cameraErrorText(e2)); }
    }
    busy = false;
  });

  // ---------- Lifecycle: stop drawing in the background to save battery ----------
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) { halt(); if (source === 'cam') video.pause(); return; }
    if (!source) return;
    if (source === 'cam') {
      const track = stream && stream.getVideoTracks()[0];
      try {
        if (!track || track.readyState === 'ended') await startCamera();
        else await video.play();
      } catch (e) { showStart('Tap to start the camera again.'); return; }
    }
    run();
  });

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); halt(); });
  canvas.addEventListener('webglcontextrestored', () => { initGL(); W = H = 0; resize(); run(); });

  // ---------- Boot ----------
  try {
    initGL();
    resize();
  } catch (e) {
    msgEl.textContent = e.message;
    $('go').disabled = true; $('demo').disabled = true;
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:')
    navigator.serviceWorker.register('sw.js').catch(() => {});
})();
