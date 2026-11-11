(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('gl'), labelsEl = $('labels'), ringEl = $('ring');
  const statsEl = $('stats'), hintEl = $('hint'), cardEl = $('card');

  // ---------- Tunables ----------
  const MAX_DPR = 2;
  const DUST_TIERS = [2500, 6000, 12000, 22000];   // decorative background stars
  const FOV_F = 1 / Math.tan((50 * Math.PI / 180) / 2);
  const GALAXY_R = 6.2;
  const LIVE_TTL = 12 * 3600 * 1000;               // refresh from GitHub at most twice a day
  const LIVE_MAX_REPOS = 25;
  const STRIDE = 11;
  const LANG = {
    JavaScript: [1.0, 0.85, 0.3], TypeScript: [0.35, 0.6, 1.0], Python: [0.35, 0.9, 0.75],
    Java: [1.0, 0.5, 0.3], HTML: [1.0, 0.42, 0.42], CSS: [0.75, 0.5, 1.0],
    Swift: [1.0, 0.6, 0.25], 'C#': [0.5, 0.95, 0.45], 'C++': [1.0, 0.45, 0.7],
  };
  const DEFAULT_COL = [0.75, 0.82, 1.0];
  const CUSTOM_COL = [1.0, 0.8, 0.45];

  // ---------- State ----------
  let gl, loc = {}, buf;
  let W = 0, H = 0, dpr = 1, cssW = 1, cssH = 1, aspect = 1;
  let stars = [];             // tappable: projects, commits, custom
  let labelled = [];          // stars that get a text label
  let nData = 0, dustTier = 2;
  let user = '';
  let yaw = 0.6, pitch = 1.12, dist = 20, baseDist = 20;
  let vyaw = 0, vpitch = 0;
  const target = [0, 0, 0], targetGoal = [0, 0, 0];
  let distGoal = null;
  let selected = null;
  let time = 0, last = 0, raf = 0, running = false;
  let perfT = 0, perfN = 0, perfSkip = true;
  let idle = 0;
  const boxes = [];

  function rng(seed) {                               // stable layout between visits
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const gauss = (r) => (r() + r() + r() - 1.5) / 1.5;

  // ---------- Shaders ----------
  const VS = `
    attribute vec3 a_c;
    attribute vec4 a_o;      // orbit radius, start angle, speed, height
    attribute vec4 a_col;    // rgb, world size
    uniform float u_t;
    uniform vec4 u_rot;      // cos yaw, sin yaw, cos pitch, sin pitch
    uniform vec3 u_cam;      // distance, focal, aspect
    uniform vec3 u_target;
    uniform float u_px;
    uniform float u_min;
    varying vec3 v_col;
    void main() {
      float a = a_o.y + a_o.z * u_t;
      vec3 p = a_c + vec3(cos(a) * a_o.x, a_o.w, sin(a) * a_o.x) - u_target;
      float x1 = p.x * u_rot.x + p.z * u_rot.y;
      float z1 = -p.x * u_rot.y + p.z * u_rot.x;
      float y1 = p.y * u_rot.z - z1 * u_rot.w;
      float z2 = p.y * u_rot.w + z1 * u_rot.z;
      float w = u_cam.x - z2;
      if (w < 0.15) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      gl_Position = vec4(x1 * u_cam.y / u_cam.z, y1 * u_cam.y, 0.0, w);
      float s = a_col.w * u_px / w * 3.0;            // sprite is 3x the core so the halo fits
      float fade = clamp(s / u_min, 0.25, 1.0);
      float tw = 0.82 + 0.18 * sin(u_t * 2.3 + a_o.y * 17.0 + a_c.x * 5.0);
      v_col = a_col.rgb * fade * tw;
      gl_PointSize = clamp(s, u_min, 220.0);
    }`;
  const FS = `
    precision mediump float;
    varying vec3 v_col;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float core = smoothstep(0.38, 0.05, d);
      float halo = max(0.0, 1.0 - d);
      gl_FragColor = vec4(v_col * (core + halo * halo * halo * 0.55), 1.0);
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function initGL() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL is not available on this device.');
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'a_c');
    gl.bindAttribLocation(prog, 1, 'a_o');
    gl.bindAttribLocation(prog, 2, 'a_col');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ['u_t', 'u_rot', 'u_cam', 'u_target', 'u_px', 'u_min']) loc[n] = gl.getUniformLocation(prog, n);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let i = 0; i < 3; i++) gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 12);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE * 4, 28);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0.004, 0.003, 0.014, 1);
  }

  // ---------- Galaxy layout ----------
  const armAngle = (arm, r) => arm * Math.PI + r * 0.8;
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  function buildGalaxy(data, custom) {
    const rand = rng(20261111);
    stars = []; labelled = [];
    user = data.user || '';

    const systems = [];
    for (const r of data.repos || []) systems.push({ repo: r, date: r.created });
    for (const c of custom || []) if (c && c.name) systems.push({ custom: c, date: c.date || '9999' });
    systems.sort((a, b) => (a.date < b.date ? -1 : 1));   // oldest sits nearest the core

    const n = systems.length;
    let commitCount = 0;
    systems.forEach((sys, i) => {
      const t = (i + 0.5) / n;
      const r = 1.1 + 4.6 * Math.pow(t, 0.8);
      const ang = armAngle(i % 2, r) + gauss(rand) * 0.1;
      const c = [Math.cos(ang) * r, gauss(rand) * 0.12, Math.sin(ang) * r];

      if (sys.custom) {
        const cu = sys.custom;
        const s = { kind: cu.kind || 'star', c, r: 0, a0: rand() * 6.28, sp: 0, yo: 0, col: CUSTOM_COL, size: 0.17,
          title: cu.name, sub: fmtDate(cu.date), body: cu.note || '', url: cu.url || '' };
        stars.push(s); labelled.push(s);
        return;
      }

      const repo = sys.repo;
      const col = LANG[repo.lang] || DEFAULT_COL;
      const commits = repo.commits || [];
      const m = commits.length;
      const more = m >= 100 ? '100+ commits' : m + (m === 1 ? ' commit' : ' commits');
      const sun = { kind: 'project', c, r: 0, a0: rand() * 6.28, sp: 0, yo: 0, col, size: 0.15 + Math.min(m, 100) * 0.0009,
        title: repo.name, sub: [repo.lang, more, 'started ' + fmtDate(repo.created)].filter(Boolean).join(' · '),
        body: repo.desc || '', url: repo.url };
      stars.push(sun); labelled.push(sun);

      const spread = 0.28 + 0.4 * Math.min(1, m / 60);
      const pale = col.map((v) => v * 0.55 + 0.45);
      commits.forEach((cm, k) => {                         // newest commits orbit closest
        const orbit = 0.16 + spread * Math.sqrt((k + 0.5) / m);
        stars.push({ kind: 'commit', c, r: orbit, a0: k * 2.39996 + rand(), sp: (0.05 + rand() * 0.03) / (orbit + 0.15),
          yo: gauss(rand) * 0.045, col: pale, size: 0.042,
          title: cm.msg || '(no message)', sub: repo.name + ' · ' + fmtDate(cm.date) + ' · ' + cm.sha, body: '', url: cm.url });
        commitCount++;
      });
    });
    nData = stars.length;

    // decorative dust: a bright core plus two spiral arms
    const maxDust = DUST_TIERS[DUST_TIERS.length - 1];
    const data32 = new Float32Array((nData + maxDust) * STRIDE);
    let k = 0;
    for (const s of stars) {
      data32.set([s.c[0], s.c[1], s.c[2], s.r, s.a0, s.sp, s.yo, s.col[0], s.col[1], s.col[2], s.size], k);
      k += STRIDE;
    }
    const dr = rng(7);
    for (let i = 0; i < maxDust; i++) {
      let x, y, z, col;
      if (dr() < 0.24) {
        const rr = Math.abs(gauss(dr)) * 1.25, a = dr() * 6.283;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr; y = gauss(dr) * 0.32 * Math.exp(-rr * 0.8);
        col = [1.0, 0.86, 0.66];
      } else {
        const rr = 0.6 + Math.pow(dr(), 0.7) * (GALAXY_R - 0.4);
        const loose = dr() < 0.3;                         // some stars fill the gaps between arms
        const a = loose ? dr() * 6.283 : armAngle(i % 2, rr) + gauss(dr) * (0.62 - rr * 0.04);
        x = Math.cos(a) * rr + gauss(dr) * 0.18; z = Math.sin(a) * rr + gauss(dr) * 0.18; y = gauss(dr) * 0.1;
        const mix = dr();
        col = [0.5 + 0.35 * mix, 0.58 + 0.12 * mix, 1.0 - 0.15 * mix];
      }
      const b = 0.26 + dr() * 0.42;
      data32.set([x, y, z, 0, dr() * 6.283, 0, 0, col[0] * b, col[1] * b, col[2] * b, 0.016 + dr() * 0.016], k);
      k += STRIDE;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data32, gl.STATIC_DRAW);

    labelsEl.textContent = '';
    for (const s of labelled) {
      const el = document.createElement('div');
      el.className = 'label'; el.textContent = s.title;
      labelsEl.appendChild(el); s.el = el;
    }
    const projects = (data.repos || []).length;
    statsEl.textContent = n
      ? (user ? user + ' · ' : '') + projects + ' projects · ' + commitCount + ' commits'
      : 'No stars found yet';
    select(null);
  }

  // ---------- Camera ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    cssW = canvas.clientWidth || 1; cssH = canvas.clientHeight || 1;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (w === W && h === H) return;
    const first = W === 0;
    W = canvas.width = w; H = canvas.height = h; aspect = W / H;
    gl.viewport(0, 0, W, H);
    const prev = baseDist;
    baseDist = (GALAXY_R * 0.96) / ((1 / FOV_F) * Math.min(aspect, 1.2));   // fit the galaxy to the narrow side
    dist = first ? baseDist : dist * baseDist / prev;
    perfSkip = true;
  }

  function starPos(s, out) {
    const a = s.a0 + s.sp * time;
    out[0] = s.c[0] + Math.cos(a) * s.r; out[1] = s.c[1] + s.yo; out[2] = s.c[2] + Math.sin(a) * s.r;
    return out;
  }
  let cy = 1, sy = 0, cp = 1, sp = 0;
  const tmp = [0, 0, 0], scr = [0, 0, 0];
  function project(p, out) {                          // world -> CSS px, out[2] = depth
    const x = p[0] - target[0], y = p[1] - target[1], z = p[2] - target[2];
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const w = dist - z2;
    out[2] = w;
    if (w < 0.15) return out;
    out[0] = (x1 * FOV_F / aspect / w * 0.5 + 0.5) * cssW;
    out[1] = (0.5 - y1 * FOV_F / w * 0.5) * cssH;
    return out;
  }

  // ---------- Render loop ----------
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now; time += dt;
    resize();

    if (!pointers.size) {
      yaw += vyaw * dt; pitch += vpitch * dt;
      const damp = Math.exp(-dt * 2.4);
      vyaw *= damp; vpitch *= damp;
      idle += dt;
      if (idle > 1.5 && !selected) yaw += 0.035 * dt * Math.min(1, (idle - 1.5) / 2);   // drift when left alone
    }
    pitch = Math.max(-1.45, Math.min(1.45, pitch));
    const ease = 1 - Math.exp(-dt * 5);
    for (let i = 0; i < 3; i++) target[i] += (targetGoal[i] - target[i]) * ease;
    if (distGoal !== null) { dist += (distGoal - dist) * ease; if (Math.abs(distGoal - dist) < 0.02) distGoal = null; }
    cy = Math.cos(yaw); sy = Math.sin(yaw); cp = Math.cos(pitch); sp = Math.sin(pitch);

    gl.uniform1f(loc.u_t, time);
    gl.uniform4f(loc.u_rot, cy, sy, cp, sp);
    gl.uniform3f(loc.u_cam, dist, FOV_F, aspect);
    gl.uniform3f(loc.u_target, target[0], target[1], target[2]);
    gl.uniform1f(loc.u_px, H * 0.5 * FOV_F);
    gl.uniform1f(loc.u_min, 2.2 * dpr);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, nData + DUST_TIERS[dustTier]);

    // labels and selection ring ride on compositor-only transforms
    // nearest labels claim their space first; overlapping ones further back stay hidden
    for (const s of labelled) { project(s.c, scr); s.sx = scr[0]; s.sy = scr[1]; s.sw = scr[2]; }
    labelled.sort((a, b) => (a === selected ? -1 : b === selected ? 1 : a.sw - b.sw));
    let placed = 0;
    for (const s of labelled) {
      const lw = Math.min(cssW * 0.44, s.title.length * 6.4 + 12);
      let on = s.sw > 0.15 && s.sx > -10 && s.sx < cssW - 24 && s.sy > 70 && s.sy < cssH - 20;
      for (let i = 0; on && i < placed; i++) {
        const o = boxes[i];
        if (s.sx < o.x + o.w && s.sx + lw > o.x && Math.abs(s.sy - o.y) < 15) on = false;
      }
      if (on) { const b = boxes[placed] || (boxes[placed] = {}); b.x = s.sx; b.y = s.sy; b.w = lw; placed++; }
      const o = on ? (selected && selected !== s ? 0.4 : 0.92) : 0;
      if (s.shown !== o) { s.shown = o; s.el.style.opacity = o; }
      if (on) s.el.style.transform = `translate3d(${(s.sx + 9).toFixed(1)}px,${(s.sy - 7).toFixed(1)}px,0)`;
    }
    if (selected) {
      project(starPos(selected, tmp), scr);
      if (selected.kind === 'commit') { targetGoal[0] = selected.c[0]; targetGoal[1] = selected.c[1]; targetGoal[2] = selected.c[2]; }
      ringEl.style.opacity = scr[2] > 0.15 ? 1 : 0;
      ringEl.style.transform = `translate3d(${scr[0].toFixed(1)}px,${scr[1].toFixed(1)}px,0)`;
    }

    // drop background dust if the phone can't hold 60fps
    perfT += dt; perfN++;
    if (perfT >= 1.5) {
      const avg = perfT / perfN * 1000;
      perfT = 0; perfN = 0;
      if (perfSkip) perfSkip = false;
      else if (avg > 21 && dustTier > 0) { dustTier--; perfSkip = true; }
    }
  }
  function run() { if (running) return; running = true; last = performance.now(); perfSkip = true; perfT = perfN = 0; raf = requestAnimationFrame(frame); }
  function halt() { running = false; cancelAnimationFrame(raf); }

  // ---------- Selection ----------
  function select(s) {
    selected = s;
    if (!s) {
      cardEl.classList.remove('open'); ringEl.style.opacity = 0;
      targetGoal[0] = targetGoal[1] = targetGoal[2] = 0;
      return;
    }
    $('kindText').textContent = s.kind;
    $('dot').style.background = `rgb(${s.col.map((v) => Math.round(v * 255)).join(',')})`;
    $('title').textContent = s.title;
    $('sub').textContent = s.sub;
    $('body').textContent = s.body;
    const a = $('open');
    if (s.url && /^https:\/\//.test(s.url)) { a.href = s.url; a.hidden = false; a.textContent = /github\.com/.test(s.url) ? 'Open on GitHub' : 'Open link'; }
    else { a.hidden = true; a.removeAttribute('href'); }
    cardEl.classList.add('open');
    targetGoal[0] = s.c[0]; targetGoal[1] = s.c[1]; targetGoal[2] = s.c[2];
    if (dist > baseDist * 0.5) distGoal = baseDist * 0.42;
    hintEl.classList.remove('show');
  }

  function pick(x, y) {
    let best = null, bestScore = 30;                    // finger-sized hit radius in CSS px
    for (const s of stars) {
      project(starPos(s, tmp), scr);
      if (scr[2] < 0.15) continue;
      const d = Math.hypot(scr[0] - x, scr[1] - y);
      const score = d - (s.kind === 'commit' ? 0 : 9);  // projects win near-ties
      if (d < 34 && score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  // ---------- Input ----------
  const pointers = new Map();
  let downX = 0, downY = 0, downT = 0, moved = false, pinch = 0;
  const pinchDist = () => { const p = [...pointers.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    idle = 0; distGoal = null;
    if (pointers.size === 1) { downX = e.clientX; downY = e.clientY; downT = performance.now(); moved = false; vyaw = vpitch = 0; }
    else { moved = true; pinch = pinchDist(); }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    idle = 0;
    if (pointers.size >= 2) {
      const d = pinchDist();
      if (pinch > 0 && d > 0) dist = Math.max(1.6, Math.min(baseDist * 1.5, dist * pinch / d));
      pinch = d;
      return;
    }
    if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < 8) return;
    moved = true;
    const k = 4.2 / Math.min(cssW, cssH) * Math.min(1, dist / baseDist + 0.25);   // slower when zoomed in
    yaw += dx * k; pitch += dy * k;
    vyaw = vyaw * 0.6 + (dx * k * 60) * 0.4; vpitch = vpitch * 0.6 + (dy * k * 60) * 0.4;
    hintEl.classList.remove('show');
  });
  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinch = 0;
    if (e.type === 'pointerup' && !moved && pointers.size === 0 && performance.now() - downT < 400) select(pick(e.clientX, e.clientY));
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); idle = 0; distGoal = null;
    dist = Math.max(1.6, Math.min(baseDist * 1.5, dist * Math.exp(e.deltaY * 0.0015)));
  }, { passive: false });
  $('close').addEventListener('click', () => select(null));

  for (const ev of ['gesturestart', 'gesturechange', 'contextmenu', 'dblclick'])
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => { if (!cardEl.contains(e.target)) e.preventDefault(); }, { passive: false });

  // ---------- Data ----------
  const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });

  async function fetchLive(name) {                     // public GitHub API, no login needed
    const api = 'https://api.github.com/';
    const list = await getJSON(api + 'users/' + encodeURIComponent(name) + '/repos?per_page=100&sort=pushed&type=owner');
    const repos = list.filter((r) => !r.fork && !r.private).slice(0, LIVE_MAX_REPOS);
    const out = await Promise.all(repos.map(async (r) => {
      let commits = [];
      try { commits = await getJSON(api + 'repos/' + r.full_name + '/commits?per_page=100'); } catch (e) { if (!/ 409$/.test(e.message)) throw e; }
      return { name: r.name, desc: r.description || '', lang: r.language || '', url: r.html_url, created: r.created_at, pushed: r.pushed_at,
        commits: commits.map((c) => ({ sha: c.sha.slice(0, 7), msg: c.commit.message.split('\n')[0].slice(0, 140), date: c.commit.author.date, url: c.html_url })) };
    }));
    return { user: name, generated: new Date().toISOString(), repos: out };
  }

  async function boot() {
    initGL(); resize();
    let data = { repos: [] }, custom = [];
    try { data = await getJSON('data.json'); } catch (e) {}
    try { custom = (await getJSON('stars.json')).stars || []; } catch (e) {}

    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('pg-live') || 'null'); } catch (e) {}
    if (cached && cached.data && cached.data.user === data.user && cached.data.generated > (data.generated || '')) data = cached.data;

    buildGalaxy(data, custom);
    run();
    hintEl.classList.add('show');
    setTimeout(() => hintEl.classList.remove('show'), 5000);

    // pick up new commits in the background; the bundled snapshot covers offline and rate limits
    if (data.user && navigator.onLine !== false && (!cached || Date.now() - cached.at > LIVE_TTL)) {
      try {
        const live = await fetchLive(data.user);
        try { localStorage.setItem('pg-live', JSON.stringify({ at: Date.now(), data: live })); } catch (e) {}
        if (!selected && !pointers.size) buildGalaxy(live, custom);
      } catch (e) {}
    }
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) halt(); else if (gl) run(); });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); halt(); });
  canvas.addEventListener('webglcontextrestored', () => location.reload());

  boot().catch((e) => { statsEl.textContent = e.message || 'Something went wrong.'; });

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
