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
const FETCH_INTERVAL  = parseInt(process.env.FETCH_INTERVAL || '5000');
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
  const records = Array.isArray(res?.records) ? res.records : (res?.records?.data || []);

  if (records.length === 0) {
    log('api-raw', 'empty response: ' + JSON.stringify(res).slice(0, 300));
    return null;
  }

  // Lookup by exact attribute ID
  const byId = {};
  records.forEach(r => { byId[r.idDataAttribute] = r; });

  const getVal = (id) => byId[id]?.rawValue ?? null;

  const gridW    = parseFloat(getVal(379));
  const essW     = parseFloat(getVal(29));
  const pvW      = parseFloat(getVal(802));
  const soc      = parseFloat(getVal(51));
  const batW     = parseFloat(getVal(243));
  const tempC    = parseFloat(getVal(450));

  const batDir   = !isNaN(batW) ? (batW >= 0 ? 'Charging' : 'Discharging') : null;
  const fmtW = (v) => isNaN(v) ? '--' : `${Math.round(v)} W`;
  const fmtPct = (v) => isNaN(v) ? '--' : `${Math.round(v)} %`;
  const fmtTemp = (v) => isNaN(v) ? '--' : `${v.toFixed(1)} °C`;

  return {
    grid:     fmtW(gridW),
    essLoads: fmtW(essW),
    pvPower:  fmtW(pvW),
    soc:      fmtPct(soc),
    batPower: !isNaN(batW) ? `${Math.round(Math.abs(batW))} W` : null,
    batDir,
    temp:     fmtTemp(tempC),
  };
}

// ── HTML render ────────────────────────────────────────────────────────────
function makeHTML(data) {
  const { grid, essLoads, pvPower, soc, batPower, batDir, temp } = data;

  const socNum = parseFloat(soc);
  const socPct = isNaN(socNum) ? 0 : Math.max(0, Math.min(100, socNum));
  const batColor = socPct > 50 ? '#3fb950' : socPct > 20 ? '#d29922' : '#f78166';

  const isCharging    = batDir === 'Charging';
  const isDischarging = batDir === 'Discharging';
  const batDirIT      = isCharging ? 'In carica' : isDischarging ? 'In scarica' : '';
  const batDirColor   = isCharging ? '#3fb950' : isDischarging ? '#f78166' : '#8b949e';
  const batSub        = [batDirIT, batPower].filter(Boolean).join(' · ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${WIDTH}px; height:${HEIGHT}px; background:#0d1117; color:#e6edf3;
  font-family:'Segoe UI',system-ui,sans-serif;
  display:flex; flex-direction:column; justify-content:center; align-items:center; gap:14px; }
.topbar { width:94%; display:flex; align-items:center; justify-content:flex-end; }
.temp-badge { background:#161b22; border:2px solid #8b949e; border-radius:12px; padding:8px 20px;
  font-size:22px; font-weight:700; color:#c9d1d9; }
.temp-badge span { font-size:12px; display:block; color:#484f58; text-transform:uppercase; letter-spacing:1px; margin-bottom:2px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; width:94%; flex:1; max-height:82%; }
.card { background:#161b22; border-radius:16px; padding:28px 32px; border-left:6px solid #58a6ff;
  display:flex; flex-direction:column; justify-content:center; }
.card.green  { border-color:#3fb950; }
.card.orange { border-color:#f78166; }
.card.yellow { border-color:#d29922; }
.lbl { font-size:28px; color:#58a6ff; text-transform:uppercase; letter-spacing:2px; margin-bottom:10px; font-weight:700;
  display:flex; align-items:center; gap:10px; }
.card.green  .lbl { color:#3fb950; }
.card.orange .lbl { color:#f78166; }
.card.yellow .lbl { color:#d29922; }
.lbl .mdi { font-size:32px; }
.lbl2 { font-size:16px; color:#484f58; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; font-weight:600; }
.val { font-size:64px; font-weight:800; color:#fff; line-height:1; }
.sub { font-size:18px; margin-top:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
.bat-bar-wrap { margin-top:12px; background:#0d1117; border-radius:8px; height:12px; width:100%; overflow:hidden; }
.bat-bar-fill { height:100%; border-radius:8px; transition:width .3s; }
.ts { font-size:17px; color:#8b949e; font-weight:600; }
</style></head><body>
<div class="topbar">
  <div class="temp-badge"><span>Temp. Soffitta</span>${temp}</div>
</div>
<div class="grid">
  <div class="card">
    <div class="lbl"><span class="mdi mdi-transmission-tower"></span> Rete</div>
    <div class="val">${grid}</div>
  </div>
  <div class="card green">
    <div class="lbl"><span class="mdi mdi-solar-power-variant"></span> Fotovoltaico</div>
    <div class="lbl2">MPPT Tracker N°1</div>
    <div class="val">${pvPower}</div>
  </div>
  <div class="card orange">
    <div class="lbl"><span class="mdi mdi-home-lightning-bolt-outline"></span> Consumi Casa</div>
    <div class="val">${essLoads}</div>
  </div>
  <div class="card yellow">
    <div class="lbl">🔋 Batteria</div>
    <div class="val">${soc}</div>
    <div class="bat-bar-wrap"><div class="bat-bar-fill" style="width:${socPct}%;background:${batColor};"></div></div>
    <div class="sub" style="color:${batDirColor};">${batSub}</div>
  </div>
</div>
<div class="ts">Aggiornato: ${agoString()}</div>
</body></html>`;
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────
const ffmpegArgs = [
  '-f', 'image2pipe', '-framerate', fps, '-i', 'pipe:0',
  '-vf', `scale=${WIDTH}:${HEIGHT}`,
  '-c:v', 'libx264',
  '-profile:v', 'baseline',
  '-level:v', '3.1',
  '-preset', 'ultrafast',
  '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p',
  '-g', '50',
  '-b:v', '2M', '-maxrate', '2M', '-bufsize', '4M',
  '-x264-params', 'slices=1',
  '-threads', '1',
  '-f', 'rtsp', '-rtsp_transport', 'tcp', RTSP_URL,
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
          const fetched = await fetchTelemetry(authToken);
          if (fetched) {
            values = fetched;
            lastFetch = Date.now();
            lastScrapeTime = Date.now();
          }
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
