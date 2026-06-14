const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');

// ── Config from environment variables ──────────────────────────────────────
const VRM_URL        = process.env.VRM_URL        || 'https://vrm.victronenergy.com/installation/475708/embed/d5b455cc';
const RTSP_URL       = process.env.RTSP_URL        || 'rtsp://mediamtx:8554/victron';
const INTERVAL_MS    = parseInt(process.env.INTERVAL_MS   || '5000');   // ms between frames
const WIDTH          = parseInt(process.env.WIDTH          || '1280');
const HEIGHT         = parseInt(process.env.HEIGHT         || '800');
const WAIT_AFTER_LOAD= parseInt(process.env.WAIT_AFTER_LOAD|| '8000'); // ms to wait for JS render

// ── FPS for the RTSP stream (can be fractional, e.g. 0.2 = 1 frame/5s) ──
const fps = (1000 / INTERVAL_MS).toFixed(4);

console.log(`[vrm-to-video] Starting`);
console.log(`  URL:       ${VRM_URL}`);
console.log(`  RTSP out:  ${RTSP_URL}`);
console.log(`  Interval:  ${INTERVAL_MS}ms  (${fps} fps)`);
console.log(`  Viewport:  ${WIDTH}x${HEIGHT}`);

// ── Launch ffmpeg piping raw BGR frames → H.264 → RTSP ───────────────────
const ffmpegArgs = [
  '-f', 'image2pipe',
  '-framerate', fps,
  '-i', 'pipe:0',                  // receive PNG frames on stdin
  '-vf', `scale=${WIDTH}:${HEIGHT}`,
  '-c:v', 'libx264',
  '-preset', 'ultrafast',
  '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p',
  '-f', 'rtsp',
  '-rtsp_transport', 'tcp',
  RTSP_URL,
];

let ffmpeg = null;
let ffmpegReady = false;

function startFfmpeg() {
  console.log(`[ffmpeg] spawning: ffmpeg ${ffmpegArgs.join(' ')}`);
  ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

  ffmpeg.on('error', (err) => {
    console.error('[ffmpeg] error:', err.message);
  });

  ffmpeg.on('exit', (code, signal) => {
    console.warn(`[ffmpeg] exited code=${code} signal=${signal} — restarting in 3s`);
    ffmpegReady = false;
    setTimeout(startFfmpeg, 3000);
  });

  // Give ffmpeg a moment to connect to the RTSP server
  setTimeout(() => { ffmpegReady = true; }, 2000);
}

startFfmpeg();

// ── Main loop ─────────────────────────────────────────────────────────────
(async () => {
  let browser;

  while (true) {
    try {
      if (!browser) {
        console.log('[puppeteer] launching browser...');
        browser = await puppeteer.launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            `--window-size=${WIDTH},${HEIGHT}`,
          ],
        });

        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();
        await page.setViewport({ width: WIDTH, height: HEIGHT });

        console.log(`[puppeteer] navigating to ${VRM_URL}`);
        await page.goto(VRM_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        console.log(`[puppeteer] waiting ${WAIT_AFTER_LOAD}ms for JS render...`);
        await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD));

        browser._page = page; // stash for reuse
        console.log('[puppeteer] ready, starting capture loop');
      }

      const page = browser._page;

      if (ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        const png = await page.screenshot({ type: 'png', fullPage: false });
        ffmpeg.stdin.write(png);
      }

    } catch (err) {
      console.error('[loop] error:', err.message, '— restarting browser in 5s');
      try { await browser.close(); } catch (_) {}
      browser = null;
    }

    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})();
