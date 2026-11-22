// What a release-pictures script needs, in one place: start the built app hidden on a throwaway profile (in the
// made-up home of scripts/readme-shots.js, against the mock model), capture a rectangle of the window 1600 px wide,
// and stop. Used by scripts/release-shots-0.21.0.js onwards; the older release-shots scripts keep their own copies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./readme-shots.js');
const { launch, sleep } = require('../test/live/rig.js');

const WIDTH = 1600;
const WIN = `process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]`;
const js = JSON.stringify;

/**
 * Starts the app hidden at `size` (CSS pixels) with rig.js launch options (`config`, `env`, `mode`, …), on a new
 * profile and in F.HOME, with F.PROJECT made. Returns { app, inspect, size, profile }.
 */
async function start({ size = { width: 1280, height: 900 }, env = {}, ...opts } = {}) {
  F.makeProject();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-shots-'));
  const inspect = await F.freePort(0);
  const app = await launch({
    args: [`--inspect=${inspect}`],
    profile,
    project: F.PROJECT,
    mock: true,
    size,
    scale: 1,
    ...opts,
    env: { HOME: F.HOME, SILO_HARNESS_CONFIG_DIR: F.CONFIG_DIR, ANTHROPIC_API_KEY: '', ...env },
  });
  // A hidden window only draws while asked to: keep it drawing, at the page's size
  await F.mainEval(inspect, `(() => { const { webContents } = process.mainModule.require('electron'); setInterval(() => { for (const w of webContents.getAllWebContents()) if (!w.isDestroyed()) w.invalidate(); }, 120); ${WIN}.setContentSize(${size.width}, ${size.height}); return true; })()`);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  return { app, inspect, size, profile };
}

/**
 * Writes the rectangle { x, y, width, height } (CSS pixels) of the window to `file`, drawn at 1600 / width device
 * pixels per CSS pixel, so the image is exactly 1600 px wide. Fails if a real or temporary home path is on screen.
 */
async function capture({ app, inspect, size }, { x, y, width, height }, file) {
  const leak = await app.evaluate(`[${js(os.homedir())}, ${js(F.HOME)}, ${js(os.tmpdir())}].some((p) => document.body.innerText.includes(p))`);
  if (leak) throw new Error('a real or temporary home path shows in the window');
  await app.evaluate(`document.activeElement && document.activeElement !== document.body && document.activeElement.blur()`);
  await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: size.width - 2, y: size.height - 2 });
  const scale = WIDTH / width;
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: scale, mobile: false });
  await sleep(300);
  await F.mainEval(inspect, `(async () => { const w = ${WIN}; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await app.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  await sleep(150);
  const cap = await app.cdp('Page.captureScreenshot', { format: 'png' });
  const png = F.cropPng(Buffer.from(cap.data, 'base64'), Math.round(x * scale), Math.round(y * scale), WIDTH, Math.round(height * scale));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  await app.cdp('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  console.log(`wrote ${file} (${Math.round(png.length / 1024)} KB, ${WIDTH} x ${Math.round(height * scale)})`);
}

/** Closes the app and removes its profile and the made-up home. */
async function stop(s) {
  await s?.app?.close();
  if (s?.profile) fs.rmSync(s.profile, { recursive: true, force: true });
  fs.rmSync(F.HOME, { recursive: true, force: true });
}

module.exports = { start, capture, stop, sleep, F, WIDTH };
