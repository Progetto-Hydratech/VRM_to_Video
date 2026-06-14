const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const https     = require('https');
const fs        = require('fs');
const OTPAuth   = require('otpauth');

const RTSP_URL        = process.env.RTSP_URL       || 'rtsp://mediamtx:8554/victron';
const FPS             = parseFloat(process.env.FPS || '5');
const WIDTH           = parseInt(process.env.WIDTH  || '1280');
const HEIGHT          = parseInt(process.env.HEIGHT || '800');
const INTERVAL_MS     = Math.round(1000 / FPS);
const FETCH_INTERVAL  = parseInt(process.env.FETCH_INTERVAL || '15000');
const SITE_ID         = process.env.VRM_SITE_ID    || '475708';
const VRM_TOKEN       = process.env.VRM_TOKEN;
const VRM_USERNAME    = process.env.VRM_USERNAME;
const VRM_PASSWORD    = process.env.VRM_PASSWORD;
const VRM_TOTP_SECRET = process.env.VRM_TOTP_SECRET;
const DEBUG_PATH      = '/media/debug_screenshot.png';

const fps = FPS.toFixed(4);
let lastScrapeTime = Date.now();

function ts()  { return new Date().toISOString(); }
function log(tag, msg) { console.log(`${ts()} [${tag}] ${msg}`); }
function err(tag, msg) { console.error(`${ts()} [${tag}] ERROR: ${msg}`); }

function agoString() {
  const sec = Math.round((Date.now() - lastScrapeTime) / 1000);
  if (sec < 60) return sec + 's fa';
  return Math.round(sec / 60) + 'm fa';
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'vrmapi.victronenergy.com', path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'X-Authorization': `Token ${token}` } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── VRM Login ──────────────────────────────────────────────────────────────
async function vrmLogin() {
  if (VRM_TOKEN) {
    log('auth', 'Using static access token');
    return VRM_TOKEN;
  }
  log('auth', `Logging in as ${VRM_USERNAME}...`);
  const res1 = await apiRequest('POST', '/v2/auth/login', { username: VRM_USERNAME, password: VRM_PASSWORD });
  if (res1.verification_mode === 'totp') {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(VRM_TOTP_SECRET), digits: 6, period: 30 });
    const code = totp.generate();
    log('auth', `TOTP: ${code}`);
    const res2 = await apiRequest('POST', '/v2/auth/totp', { username: VRM_USERNAME, password: VRM_PASSWORD, token: code });
    if (!res2.token) throw new Error('2FA failed: ' + JSON.stringify(res2));
    log('auth', 'Login + 2FA OK');
    return res2.token;
  }
  if (!res1.token) throw new Error('Login failed: ' + JSON.stringify(res1));
  log('auth', 'Login OK');
  return res1.token;
}

// ── VRM API fetch ──────────────────────────────────────────────────────────
async function fetchTelemetry(token) {
  const res = await apiRequest('GET', `/v2/installations/${SITE_ID}/diagnostics`, null, token);
  const records = res?.records?.data || [];

  if (records.length > 0 && !fetchTelemetry._logged) {
    fetchTelemetry._logged = true;
    log('api', 'Available attributes:');
    records.forEach(r => log('api', `  [${r.idDataAttribute}] ${r.description}: ${r.rawValue} ${r.unit||''}`));
  }

  const find = (keywords) => {
    for (const kw of keywords) {
      const r = records.find(r => r.description && r.description.toLowerCase().includes(kw.toLowerCase()));
      if (r) return { value: r.rawValue, unit: r.unit || '', raw: r };
    }
    return null;
  };

  const grid    = find(['grid', 'ac input', 'mains']);
  const essLoad = find(['ac consumption', 'essential loads', 'ac loads', 'load']);
  const pv      = find(['pv power', 'solar charger power', 'pv - ac', 'solar power', 'pv charger']);
  const soc     = find(['state of charge', 'battery soc', 'soc']);
  const batPow  = find(['battery power', 'battery current']);

  // Determine charging/discharging from battery power sign
  let batDir = null;
  if (batPow) {
    const v = parseFloat(batPow.value);
    if (!isNaN(v)) batDir = v >= 0 ? 'Charging' : 'Discharging';
  }

  const fmt = (r) => r ? `${r.value} ${r.unit}`.trim() : '--';

  return {
    grid:     fmt(grid),
    essLoads: fmt(essLoad),
    pvPower:  fmt(pv),
    soc:      soc ? `${soc.value} ${soc.unit}`.trim() : '--',
    batPower: batPow ? `${Math.abs(parseFloat(batPow.value))} ${batPow.unit}`.trim() : null,
    batDir,
  };
}

// ── HTML render ────────────────────────────────────────────────────────────
function makeHTML(data) {
  const { grid, essLoads, pvPower, soc, batPower, batDir } = data;
  const batSub = [batDir, batPower].filter(Boolean).join(' ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${WIDTH}px; height:${HEIGHT}px; background:#0d1117; color:#e6edf3;
  font-family:'Segoe UI',system-ui,sans-serif;
  display:flex; flex-direction:column; justify-content:center; align-items:center; gap:20px; }
h1 { font-size:30px; color:#58a6ff; font-weight:700; letter-spacing:.5px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; width:94%; height:72%; }
.card { background:#161b22; border-radius:16px; padding:32px 36px; border-left:6px solid #58a6ff;
  display:flex; flex-direction:column; justify-content:center; }
.card.green  { border-color:#3fb950; }
.card.orange { border-color:#f78166; }
.card.yellow { border-color:#d29922; }
.lbl { font-size:22px; color:#58a6ff; text-transform:uppercase; letter-spacing:2px; margin-bottom:14px; font-weight:700; }
.card.green  .lbl { color:#3fb950; }
.card.orange .lbl { color:#f78166; }
.card.yellow .lbl { color:#d29922; }
.val { font-size:72px; font-weight:800; color:#fff; line-height:1; }
.sub { font-size:22px; color:#3fb950; margin-top:12px; font-weight:600; text-transform:uppercase; letter-spacing:1px; }
.ts  { font-size:13px; color:#484f58; }
</style></head><body>
<h1>🏠 Casa Mia — Victron VRM</h1>
<div class="grid">
  <div class="card"><div class="lbl">⚡ Grid</div><div class="val">${grid}</div></div>
  <div class="card green"><div class="lbl">☀️ PV Charger</div><div class="val">${pvPower}</div></div>
  <div class="card orange"><div class="lbl">🔌 Essential Loads</div><div class="val">${essLoads}</div></div>
  <div class="card yellow"><div class="lbl">🔋 Battery</div><div class="val">${soc}</div><div class="sub">${batSub}</div></div>
</div>
<div class="ts">Aggiornato: ${agoString()}</div>
</body></html>`;
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────
const ffmpegArgs = [
  '-f', 'image2pipe', '-framerate', fps, '-i', 'pipe:0',
  '-vf', `scale=${WIDTH}:${HEIGHT}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p', '-f', 'rtsp', '-rtsp_transport', 'tcp', RTSP_URL,
];
let ffmpeg = null, ffmpegReady = false, frameCount = 0;

function startFfmpeg() {
  log('ffmpeg', `spawning → ${RTSP_URL} @ ${fps}fps`);
  ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  ffmpeg.on('error', e => err('ffmpeg', e.message));
  ffmpeg.on('exit', (code, signal) => {
    log('ffmpeg', `exited ${code}/${signal} — restarting in 3s`);
    ffmpegReady = false; frameCount = 0; setTimeout(startFfmpeg, 3000);
  });
  setTimeout(() => { ffmpegReady = true; log('ffmpeg', 'ready'); }, 2000);
}
startFfmpeg();

// ── Main loop ──────────────────────────────────────────────────────────────
(async () => {
  log('vrm-to-video', `Starting — API mode — ${fps}fps — fetch every ${FETCH_INTERVAL}ms`);

  let browser = null, renderPage = null, authToken = null, tokenExpiry = 0;
  let values = { grid: '--', essLoads: '--', pvPower: '--', soc: '--', batPower: null, batDir: null };
  let lastFetch = 0;

  while (true) {
    const loopStart = Date.now();
    try {
      // Init browser (render-only, no VRM navigation)
      if (!browser) {
        browser = await puppeteer.launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
          headless: true,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                 '--disable-gpu',`--window-size=${WIDTH},${HEIGHT}`],
        });
        const pages = await browser.pages();
        renderPage = pages[0] || await browser.newPage();
        await renderPage.setViewport({ width: WIDTH, height: HEIGHT });
        log('puppeteer', 'render browser ready');
      }

      // Refresh auth token if needed (every 23h, or never if static token)
      if (!authToken || (!VRM_TOKEN && Date.now() > tokenExpiry)) {
        authToken = await vrmLogin();
        tokenExpiry = Date.now() + 23 * 3600 * 1000;
      }

      // Fetch telemetry from API
      if (Date.now() - lastFetch > FETCH_INTERVAL) {
        try {
          values = await fetchTelemetry(authToken);
          lastFetch = Date.now();
          lastScrapeTime = Date.now();
          log('api', `grid=${values.grid} ess=${values.essLoads} pv=${values.pvPower} soc=${values.soc}`);
        } catch(e) {
          err('api', e.message);
          if (e.message.includes('401') || e.message.includes('auth')) {
            authToken = null; // force re-login
          }
        }
      }

      // Render frame
      if (ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        await renderPage.setContent(makeHTML(values), { waitUntil: 'domcontentloaded' });
        const png = await renderPage.screenshot({ type: 'png', fullPage: false });
        frameCount++;
        ffmpeg.stdin.write(png);

        if (frameCount === 1) {
          try { fs.writeFileSync(DEBUG_PATH, png); } catch(_) {}
          log('capture', `first frame — ${(png.length/1024).toFixed(1)} KB`);
        }
        if (frameCount % 100 === 0) log('capture', `frame #${frameCount}`);
      }

    } catch(e) {
      err('loop', `${e.message} — restarting in 5s`);
      try { await browser?.close(); } catch(_) {}
      browser = null; renderPage = null;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    const elapsed = Date.now() - loopStart;
    await new Promise(r => setTimeout(r, Math.max(0, INTERVAL_MS - elapsed)));
  }
})();
