const puppeteer = require('puppeteer-core');
const { spawn }  = require('child_process');
const https      = require('https');
const fs         = require('fs');
const OTPAuth    = require('otpauth');

// ── Config ─────────────────────────────────────────────────────────────────
const RTSP_URL       = process.env.RTSP_URL         || 'rtsp://mediamtx:8554/victron';
const FPS            = parseFloat(process.env.FPS   || '15');
const WIDTH          = parseInt(process.env.WIDTH   || '1280');
const HEIGHT         = parseInt(process.env.HEIGHT  || '800');
const INTERVAL_MS    = Math.round(1000 / FPS);
const VRM_SITE_ID    = process.env.VRM_SITE_ID      || '475708';
const VRM_USERNAME   = process.env.VRM_USERNAME;
const VRM_PASSWORD   = process.env.VRM_PASSWORD;
const VRM_TOTP_SECRET= process.env.VRM_TOTP_SECRET;
const DEBUG_PATH     = '/media/debug_screenshot.png';

const fps = FPS.toFixed(4);

function ts()  { return new Date().toISOString(); }
function log(tag, msg) { console.log(`${ts()} [${tag}] ${msg}`); }
function err(tag, msg) { console.error(`${ts()} [${tag}] ERROR: ${msg}`); }

// ── VRM API ────────────────────────────────────────────────────────────────
function apiRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'vrmapi.victronenergy.com',
      path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'x-authorization': `Token ${token}` } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function vrmLogin() {
  if (!VRM_USERNAME || !VRM_PASSWORD) throw new Error('VRM_USERNAME/PASSWORD not set');
  log('auth', `Logging in as ${VRM_USERNAME}...`);
  const res1 = await apiRequest('POST', '/v2/auth/login', { username: VRM_USERNAME, password: VRM_PASSWORD });
  if (res1.verification_mode === 'totp') {
    if (!VRM_TOTP_SECRET) throw new Error('VRM_TOTP_SECRET not set');
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

async function fetchTelemetry(token) {
  const data = await apiRequest('GET', `/v2/installations/${VRM_SITE_ID}/system-overview`, null, token);
  const records = data.records || {};

  // Extract values from system-overview response
  const grid      = records.Pgrid      ?? records.pgrid      ?? null;
  const acLoads   = records.Pac        ?? records.pac        ?? null;
  const essLoads  = records.Pout       ?? records.pout       ?? null;
  const pvPower   = records.Ppv        ?? records.ppv        ?? null;
  const soc       = records.SOC        ?? records.soc        ?? null;
  const batPower  = records.Pbattery   ?? records.pbattery   ?? null;

  return { grid, acLoads, essLoads, pvPower, soc, batPower, raw: records };
}

function makeHTML(t) {
  const fmt = (v, unit='W') => v !== null && v !== undefined ? `${Math.round(v)} ${unit}` : '--';
  const fmtBat = () => {
    if (t.soc === null && t.batPower === null) return '--';
    const soc  = t.soc    !== null ? `${Math.round(t.soc)}%` : '';
    const pwr  = t.batPower !== null ? Math.round(t.batPower) : null;
    const dir  = pwr === null ? '' : pwr >= 0 ? `⚡ charging ${pwr}W` : `🔋 discharging ${Math.abs(pwr)}W`;
    return [soc, dir].filter(Boolean).join('  ·  ');
  };

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:${WIDTH}px; height:${HEIGHT}px;
    background:#1a1a2e; color:#e0e0e0;
    font-family:'Segoe UI',sans-serif;
    display:flex; flex-direction:column;
    justify-content:center; align-items:center; gap:32px;
  }
  .title { font-size:28px; color:#4fc3f7; font-weight:600; margin-bottom:8px; }
  .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; width:90%; }
  .card {
    background:#16213e; border-radius:16px; padding:28px 32px;
    border-left:5px solid #4fc3f7;
  }
  .card.green  { border-color:#66bb6a; }
  .card.orange { border-color:#ffa726; }
  .card.yellow { border-color:#ffee58; }
  .label { font-size:14px; color:#90a4ae; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
  .value { font-size:42px; font-weight:700; color:#fff; }
  .sub   { font-size:16px; color:#90a4ae; margin-top:6px; }
  .ts    { font-size:12px; color:#546e7a; position:absolute; bottom:16px; right:24px; }
</style></head><body>
  <div class="title">🏠 Casa Mia — Victron VRM</div>
  <div class="grid-2">
    <div class="card">
      <div class="label">⚡ Grid</div>
      <div class="value">${fmt(t.grid)}</div>
    </div>
    <div class="card green">
      <div class="label">☀️ PV Charger</div>
      <div class="value">${fmt(t.pvPower)}</div>
    </div>
    <div class="card orange">
      <div class="label">🔌 Essential Loads</div>
      <div class="value">${fmt(t.essLoads ?? t.acLoads)}</div>
    </div>
    <div class="card yellow">
      <div class="label">🔋 Battery</div>
      <div class="value">${t.soc !== null ? Math.round(t.soc)+'%' : '--'}</div>
      <div class="sub">${fmtBat()}</div>
    </div>
  </div>
  <div class="ts">Updated: ${new Date().toLocaleTimeString('it-IT')}</div>
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
    ffmpegReady = false; frameCount = 0;
    setTimeout(startFfmpeg, 3000);
  });
  setTimeout(() => { ffmpegReady = true; log('ffmpeg', 'ready'); }, 2000);
}

startFfmpeg();

// ── Main loop ─────────────────────────────────────────────────────────────
(async () => {
  log('vrm-to-video', `Starting — API mode — ${fps}fps — ${WIDTH}x${HEIGHT}`);

  let authToken  = null;
  let browser    = null;
  let page       = null;
  let telemetry  = { grid: null, acLoads: null, essLoads: null, pvPower: null, soc: null, batPower: null };
  let lastFetch  = 0;
  const FETCH_INTERVAL = 5000; // fetch telemetry every 5s regardless of FPS

  while (true) {
    const loopStart = Date.now();
    try {
      // Login if needed
      if (!authToken) authToken = await vrmLogin();

      // Launch browser once
      if (!browser) {
        log('puppeteer', 'launching browser...');
        browser = await puppeteer.launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
          headless: true,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                 '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`],
        });
        const pages = await browser.pages();
        page = pages[0] || await browser.newPage();
        await page.setViewport({ width: WIDTH, height: HEIGHT });
        log('puppeteer', 'browser ready');
      }

      // Fetch telemetry every FETCH_INTERVAL
      if (Date.now() - lastFetch > FETCH_INTERVAL) {
        try {
          const raw = await fetchTelemetry(authToken);
          telemetry = raw;
          lastFetch = Date.now();
          if (raw.soc === null) {
            log('api', `raw keys: ${Object.keys(raw.raw || {}).join(', ')}`);
          } else {
            log('api', `Grid:${raw.grid}W  ESS:${raw.essLoads ?? raw.acLoads}W  PV:${raw.pvPower}W  SOC:${raw.soc}%  Bat:${raw.batPower}W`);
          }
        } catch (e) {
          err('api', e.message);
          if (e.message.includes('401') || e.message.includes('token')) authToken = null;
        }
      }

      // Render HTML and screenshot
      if (ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        await page.setContent(makeHTML(telemetry), { waitUntil: 'domcontentloaded' });
        const png = await page.screenshot({ type: 'png', fullPage: false });
        frameCount++;
        ffmpeg.stdin.write(png);

        if (frameCount === 1) {
          try { if (fs.existsSync(DEBUG_PATH)) fs.unlinkSync(DEBUG_PATH); fs.writeFileSync(DEBUG_PATH, png); } catch (_) {}
          log('capture', `first frame — ${(png.length/1024).toFixed(1)} KB`);
        }
        if (frameCount % 50 === 0) log('capture', `frame #${frameCount}`);
      }

    } catch (e) {
      err('loop', `${e.message} — restarting in 5s`);
      try { await browser?.close(); } catch (_) {}
      browser = null; page = null; authToken = null;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const elapsed = Date.now() - loopStart;
    await new Promise(r => setTimeout(r, Math.max(0, INTERVAL_MS - elapsed)));
  }
})();
