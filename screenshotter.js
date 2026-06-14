const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const OTPAuth = require('otpauth');

const VRM_URL        = process.env.VRM_URL         || 'https://vrm.victronenergy.com/installation/475708/share/102cf9ce';
const RTSP_URL       = process.env.RTSP_URL         || 'rtsp://mediamtx:8554/victron';
const INTERVAL_MS    = parseInt(process.env.INTERVAL_MS    || '200');
const WIDTH          = parseInt(process.env.WIDTH          || '1280');
const HEIGHT         = parseInt(process.env.HEIGHT         || '800');
const WAIT_AFTER_LOAD= parseInt(process.env.WAIT_AFTER_LOAD|| '15000');
const VRM_USERNAME   = process.env.VRM_USERNAME;
const VRM_PASSWORD   = process.env.VRM_PASSWORD;
const VRM_TOTP_SECRET= process.env.VRM_TOTP_SECRET;

const DEBUG_PATH = '/media/debug_screenshot.png';
const fps = (1000 / INTERVAL_MS).toFixed(4);

function ts()  { return new Date().toISOString(); }
function log(tag, msg) { console.log(`${ts()} [${tag}] ${msg}`); }
function err(tag, msg) { console.error(`${ts()} [${tag}] ERROR: ${msg}`); }

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'vrmapi.victronenergy.com',
      path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function vrmLogin() {
  if (!VRM_USERNAME || !VRM_PASSWORD) {
    log('auth', 'No credentials — skipping login');
    return null;
  }
  log('auth', `Logging in as ${VRM_USERNAME}...`);
  const res1 = await apiPost('/v2/auth/login', { username: VRM_USERNAME, password: VRM_PASSWORD });
  log('auth', `Login response: ${JSON.stringify(res1)}`);
  if (res1.verification_mode === 'totp') {
    if (!VRM_TOTP_SECRET) throw new Error('2FA required but VRM_TOTP_SECRET not set');
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(VRM_TOTP_SECRET), digits: 6, period: 30 });
    const code = totp.generate();
    log('auth', `Generated TOTP code: ${code}`);
    const res2 = await apiPost('/v2/auth/totp', { username: VRM_USERNAME, password: VRM_PASSWORD, token: code });
    log('auth', `2FA response: ${JSON.stringify(res2)}`);
    if (!res2.token) throw new Error('2FA failed: ' + JSON.stringify(res2));
    log('auth', 'Login + 2FA successful');
    return res2.token;
  }
  if (!res1.token) throw new Error('Login failed: ' + JSON.stringify(res1));
  log('auth', 'Login successful');
  return res1.token;
}

const ffmpegArgs = [
  '-f', 'image2pipe', '-framerate', fps, '-i', 'pipe:0',
  '-vf', `scale=${WIDTH}:${HEIGHT}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p', '-f', 'rtsp', '-rtsp_transport', 'tcp',
  RTSP_URL,
];

let ffmpeg = null;
let ffmpegReady = false;
let frameCount = 0;

function startFfmpeg() {
  log('ffmpeg', `spawning ffmpeg → ${RTSP_URL} @ ${fps}fps`);
  ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  ffmpeg.on('error', (e) => err('ffmpeg', e.message));
  ffmpeg.on('exit', (code, signal) => {
    log('ffmpeg', `exited code=${code} signal=${signal} — restarting in 3s`);
    ffmpegReady = false;
    frameCount = 0;
    setTimeout(startFfmpeg, 3000);
  });
  setTimeout(() => { ffmpegReady = true; log('ffmpeg', 'ready — accepting frames'); }, 2000);
}

startFfmpeg();

(async () => {
  log('vrm-to-video', `Starting — URL: ${VRM_URL}  ${fps}fps  ${WIDTH}x${HEIGHT}`);
  let browser;
  let debugSaved = false;

  while (true) {
    const loopStart = Date.now();
    try {
      if (!browser) {
        const authToken = await vrmLogin();
        log('puppeteer', 'launching browser...');
        browser = await puppeteer.launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
          headless: true,
          args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
            `--window-size=${WIDTH},${HEIGHT}`,
          ],
        });
        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();
        await page.setViewport({ width: WIDTH, height: HEIGHT });
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        if (authToken) {
          log('puppeteer', 'injecting auth token...');
          await page.evaluateOnNewDocument((t) => {
            localStorage.setItem('jwt_token', t);
            localStorage.setItem('token', t);
          }, authToken);
        }
        log('puppeteer', `navigating to ${VRM_URL}`);
        await page.goto(VRM_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        log('puppeteer', `landed on: ${page.url()} — "${await page.title()}"`);
        log('puppeteer', `waiting ${WAIT_AFTER_LOAD}ms for JS render...`);
        await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD));

        // Save debug screenshot ONCE at startup
        const debugPng = await page.screenshot({ type: 'png', fullPage: false });
        try {
          if (fs.existsSync(DEBUG_PATH)) fs.unlinkSync(DEBUG_PATH);
          fs.writeFileSync(DEBUG_PATH, debugPng);
          log('debug', `screenshot saved to ${DEBUG_PATH} — ${(debugPng.length/1024).toFixed(1)} KB`);
        } catch (e) { log('debug', `could not save: ${e.message}`); }
        debugSaved = true;

        browser._page = page;
        log('puppeteer', 'ready, starting capture loop');
      }

      const page = browser._page;
      if (ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        const png = await page.screenshot({ type: 'png', fullPage: false });
        frameCount++;
        ffmpeg.stdin.write(png);
        if (frameCount === 1 || frameCount % 50 === 0) {
          log('capture', `frame #${frameCount} — ${(png.length / 1024).toFixed(1)} KB`);
        }
      }

    } catch (e) {
      err('loop', `${e.message} — restarting in 5s`);
      try { await browser.close(); } catch (_) {}
      browser = null;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const elapsed = Date.now() - loopStart;
    const wait = Math.max(0, INTERVAL_MS - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }
})();
