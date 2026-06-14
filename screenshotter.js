const puppeteer = require('puppeteer-core');
const { spawn }  = require('child_process');
const https      = require('https');
const fs         = require('fs');
const OTPAuth    = require('otpauth');

const RTSP_URL       = process.env.RTSP_URL         || 'rtsp://mediamtx:8554/victron';
const FPS            = parseFloat(process.env.FPS   || '5');
const WIDTH          = parseInt(process.env.WIDTH   || '1280');
const HEIGHT         = parseInt(process.env.HEIGHT  || '800');
const INTERVAL_MS    = Math.round(1000 / FPS);
const VRM_URL        = process.env.VRM_URL          || 'https://vrm.victronenergy.com/installation/475708/share/102cf9ce';
const WAIT_AFTER_LOAD= parseInt(process.env.WAIT_AFTER_LOAD || '15000');
const VRM_USERNAME   = process.env.VRM_USERNAME;
const VRM_PASSWORD   = process.env.VRM_PASSWORD;
const VRM_TOTP_SECRET= process.env.VRM_TOTP_SECRET;
const DEBUG_PATH     = '/media/debug_screenshot.png';

const fps = FPS.toFixed(4);

function ts()  { return new Date().toISOString(); }
function log(tag, msg) { console.log(`${ts()} [${tag}] ${msg}`); }
function err(tag, msg) { console.error(`${ts()} [${tag}] ERROR: ${msg}`); }

// ── VRM login via API ──────────────────────────────────────────────────────
function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'vrmapi.victronenergy.com', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let raw = ''; res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function vrmLogin() {
  if (!VRM_USERNAME || !VRM_PASSWORD) { log('auth', 'No credentials'); return null; }
  log('auth', `Logging in as ${VRM_USERNAME}...`);
  const res1 = await apiPost('/v2/auth/login', { username: VRM_USERNAME, password: VRM_PASSWORD });
  if (res1.verification_mode === 'totp') {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(VRM_TOTP_SECRET), digits: 6, period: 30 });
    const code = totp.generate();
    log('auth', `TOTP: ${code}`);
    const res2 = await apiPost('/v2/auth/totp', { username: VRM_USERNAME, password: VRM_PASSWORD, token: code });
    if (!res2.token) throw new Error('2FA failed');
    log('auth', 'Login + 2FA OK'); return res2.token;
  }
  if (!res1.token) throw new Error('Login failed');
  log('auth', 'Login OK'); return res1.token;
}

// ── Scrape values from VRM dashboard DOM ───────────────────────────────────
async function scrapeDashboard(page) {
  return await page.evaluate(() => {
    function getText(selector) {
      const el = document.querySelector(selector);
      return el ? el.innerText.trim() : null;
    }
    function findCardValue(label) {
      const els = Array.from(document.querySelectorAll('*'));
      for (const el of els) {
        if (el.children.length === 0 && el.innerText && el.innerText.toLowerCase().includes(label.toLowerCase())) {
          // Look for sibling or parent that contains the value
          const parent = el.closest('[class*="card"], [class*="widget"], [class*="tile"], section, article, div[class]');
          if (parent) {
            const valueEl = parent.querySelector('[class*="value"], [class*="power"], [class*="watt"], h1, h2, h3, strong');
            if (valueEl) return valueEl.innerText.trim();
          }
        }
      }
      return null;
    }

    // Try to extract all text content with W and % values
    const allText = document.body.innerText;
    const lines = allText.split('\n').map(l => l.trim()).filter(Boolean);

    return { lines, url: window.location.href, title: document.title };
  });
}

let lastScrapeTime = Date.now();

function agoString() {
  const sec = Math.round((Date.now() - lastScrapeTime) / 1000);
  if (sec < 60) return sec + 's fa';
  return Math.round(sec / 60) + 'm fa';
}

function makeHTML(data) {
  const { grid, essLoads, pvPower, soc, batPower, batDir } = data;
  const fmt = v => v !== null && v !== undefined ? v : '--';
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
.val { font-size:72px; font-weight:800; color:#fff; line-height:1; }
.sub { font-size:22px; color:#3fb950; margin-top:12px; font-weight:600; text-transform:uppercase; letter-spacing:1px; }
.ts  { font-size:13px; color:#484f58; }
</style></head><body>
<h1>🏠 Casa Mia — Victron VRM</h1>
<div class="grid">
  <div class="card"><div class="lbl">⚡ Grid</div><div class="val">${fmt(grid)}</div></div>
  <div class="card green"><div class="lbl">☀️ PV Charger</div><div class="val">${fmt(pvPower)}</div></div>
  <div class="card orange"><div class="lbl">🔌 Essential Loads</div><div class="val">${fmt(essLoads)}</div></div>
  <div class="card yellow"><div class="lbl">🔋 Battery</div><div class="val">${fmt(soc)}</div><div class="sub">${batSub}</div></div>
</div>
<div class="ts">Aggiornato: ${agoString()}</div>
</body></html>`;
}

function parseValues(lines) {
  console.log('[scrape] lines:', JSON.stringify(lines.slice(0, 40)));

  const findNext = (keywords) => {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      if (keywords.some(k => l === k || l.startsWith(k))) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          if (/[\d]/.test(lines[j])) return lines[j];
        }
      }
    }
    return null;
  };

  // Battery: look for "Charging" or "Discharging" label
  // Lines layout: "Charging"/"Discharging" → "311 W" → "81.0 %"
  let batDir = null, batPower = null, soc = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l === 'charging' || l === 'discharging') {
      batDir = lines[i];
      if (i + 1 < lines.length && /\d/.test(lines[i+1])) batPower = lines[i+1];
      if (i + 2 < lines.length && lines[i+2].includes('%')) soc = lines[i+2];
      else if (i + 2 < lines.length && /\d/.test(lines[i+2])) soc = lines[i+2];
      break;
    }
  }

  return {
    grid:     findNext(['grid']),
    essLoads: findNext(['essential loads', 'essential']),
    pvPower:  findNext(['pv charger']),
    soc,
    batPower,
    batDir,
    time:     new Date().toLocaleTimeString('it-IT'),
  };
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

// ── Main loop ─────────────────────────────────────────────────────────────
(async () => {
  log('vrm-to-video', `Starting — scrape mode — ${fps}fps`);
  let browser = null, dashPage = null, renderPage = null;
  let values = { grid: null, essLoads: null, pvPower: null, soc: null, batPower: null, batDir: null };
  let lastScrape = 0;
  const SCRAPE_INTERVAL = 10000;

  while (true) {
    const loopStart = Date.now();
    try {
      if (!browser) {
        const authToken = await vrmLogin();
        log('puppeteer', 'launching browser...');
        browser = await puppeteer.launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
          headless: true,
          args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                 '--disable-gpu','--use-gl=swiftshader','--enable-webgl',
                 `--window-size=${WIDTH},${HEIGHT}`],
        });
        // Page 1: VRM dashboard for scraping
        const pages = await browser.pages();
        dashPage = pages[0] || await browser.newPage();
        await dashPage.setViewport({ width: WIDTH, height: HEIGHT });
        await dashPage.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        if (authToken) {
          await dashPage.evaluateOnNewDocument(t => {
            localStorage.setItem('jwt_token', t); localStorage.setItem('token', t);
          }, authToken);
        }
        log('puppeteer', `navigating to ${VRM_URL}`);
        await dashPage.goto(VRM_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        log('puppeteer', `landed: ${dashPage.url()} — "${await dashPage.title()}"`);
        log('puppeteer', `waiting ${WAIT_AFTER_LOAD}ms for JS render...`);
        await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD));

        // Page 2: blank page for rendering our HTML card
        renderPage = await browser.newPage();
        await renderPage.setViewport({ width: WIDTH, height: HEIGHT });

        log('puppeteer', 'ready');
      }

      // Reload page every RELOAD_INTERVAL to get fresh websocket data
      const RELOAD_INTERVAL = parseInt(process.env.RELOAD_INTERVAL || '120000');
      if (Date.now() - lastScrape > RELOAD_INTERVAL) {
        try {
          log('scrape', 'reloading VRM page for fresh data...');
          await dashPage.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(r => setTimeout(r, 5000));
          const raw = await scrapeDashboard(dashPage);
          values = parseValues(raw.lines);
          lastScrape = Date.now();
          lastScrapeTime = Date.now();
          log('scrape', `grid=${values.grid} ess=${values.essLoads} pv=${values.pvPower} soc=${values.soc}`);
        } catch(e) { err('scrape', e.message); }
      } else if (Date.now() - lastScrapeTime > 10000) {
        try {
          const raw = await scrapeDashboard(dashPage);
          values = parseValues(raw.lines);
          lastScrapeTime = Date.now();
          log('scrape', `grid=${values.grid} ess=${values.essLoads} pv=${values.pvPower} soc=${values.soc}`);
        } catch(e) { err('scrape', e.message); }
      }

      // Render and stream
      if (ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        await renderPage.setContent(makeHTML(values), { waitUntil: 'domcontentloaded' });
        const png = await renderPage.screenshot({ type: 'png', fullPage: false });
        frameCount++;
        ffmpeg.stdin.write(png);

        if (frameCount === 1) {
          try { if (fs.existsSync(DEBUG_PATH)) fs.unlinkSync(DEBUG_PATH); fs.writeFileSync(DEBUG_PATH, png); } catch(_) {}
          log('capture', `first frame — ${(png.length/1024).toFixed(1)} KB`);
        }
        if (frameCount % 50 === 0) log('capture', `frame #${frameCount}`);
      }

    } catch(e) {
      err('loop', `${e.message} — restarting in 5s`);
      try { await browser?.close(); } catch(_) {}
      browser = null; dashPage = null; renderPage = null;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    const elapsed = Date.now() - loopStart;
    await new Promise(r => setTimeout(r, Math.max(0, INTERVAL_MS - elapsed)));
  }
})();
