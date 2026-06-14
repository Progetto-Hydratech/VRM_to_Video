const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');

const VRM_URL        = process.env.VRM_URL        || 'https://vrm.victronenergy.com/installation/475708/share/102cf9ce';
const RTSP_URL       = process.env.RTSP_URL        || 'rtsp://mediamtx:8554/victron';
const INTERVAL_MS    = parseInt(process.env.INTERVAL_MS    || '5000');
const WIDTH          = parseInt(process.env.WIDTH          || '1280');
const HEIGHT         = parseInt(process.env.HEIGHT         || '800');
const WAIT_AFTER_LOAD= parseInt(process.env.WAIT_AFTER_LOAD|| '8000');

const fps = (1000 / INTERVAL_MS).toFixed(4);

function ts() { return new Date().toISOString(); }
function log(tag, msg) { console.log(`${ts()} [${tag}] ${msg}`); }
function err(tag, msg) { console.error(`${ts()} [${tag}] ERROR: ${msg}`); }

log('vrm-to-video', 'Starting');
log('vrm-to-video', `  URL:       ${VRM_URL}`);
log('vrm-to-video', `  RTSP out:  ${RTSP_URL}`);
log('vrm-to-video', `  Interval:  ${INTERVAL_MS}ms  (${fps} fps)`);
log('vrm-to-video', `  Viewport:  ${WIDTH}x${HEIGHT}`);
log('vrm-to-video', `  Wait:      ${WAIT_AFTER_LOAD}ms`);

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
  log('ffmpeg', `spawning: ffmpeg ${ffmpegArgs.join(' ')}`);
  ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  ffmpeg.on('error', (e) => err('ffmpeg', e.message));
  ffmpeg.on('exit', (code, signal) => {
    log('ffmpeg', `exited code=${code} signal=${signal} — restarting in 3s`);
    ffmpegReady = false;
    frameCount = 0;
    setTimeout(startFfmpeg, 3000);
  });
  setTimeout(() => {
    ffmpegReady = true;
    log('ffmpeg', 'ready — accepting frames');
  }, 2000);
}

startFfmpeg();

(async () => {
  let browser;

  while (true) {
    try {
      if (!browser) {
        log('puppeteer', 'launching browser...');
        browser = await puppeteer.launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
          headless: true,
          args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--use-gl=swiftshader',          // software WebGL
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            `--window-size=${WIDTH},${HEIGHT}`,
            '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ],
        });

        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();
        await page.setViewport({ width: WIDTH, height: HEIGHT });
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        log('puppeteer', `navigating to ${VRM_URL}`);
        await page.goto(VRM_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const finalUrl = page.url();
        const title = await page.title();
        log('puppeteer', `landed on: ${finalUrl}`);
        log('puppeteer', `page title: "${title}"`);
        if (finalUrl !== VRM_URL) {
          log('puppeteer', `WARNING: redirect detected!`);
        }

        log('puppeteer', `waiting ${WAIT_AFTER_LOAD}ms for JS render...`);
        await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD));

        // Save debug screenshot on first load
        const debugPng = await page.screenshot({ type: 'png', fullPage: false });
        fs.writeFileSync('/tmp/debug_screenshot.png', debugPng);
        log('puppeteer', `debug screenshot saved to /tmp/debug_screenshot.png (${(debugPng.length/1024).toFixed(1)} KB)`);

        browser._page = page;
        log('puppeteer', 'ready, starting capture loop');
      }

      const page = browser._page;

      if (ffmpegReady && ffmpeg && ffmpeg.stdin.writable) {
        const png = await page.screenshot({ type: 'png', fullPage: false });
        frameCount++;
        ffmpeg.stdin.write(png);
        if (frameCount === 1 || frameCount % 10 === 0) {
          log('capture', `frame #${frameCount} — ${(png.length / 1024).toFixed(1)} KB → ffmpeg`);
        }
      } else {
        log('capture', `skipping frame — ffmpegReady=${ffmpegReady} writable=${ffmpeg?.stdin?.writable}`);
      }

    } catch (e) {
      err('loop', `${e.message} — restarting browser in 5s`);
      try { await browser.close(); } catch (_) {}
      browser = null;
    }

    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})();
