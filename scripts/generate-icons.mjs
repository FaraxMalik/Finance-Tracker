/**
 * Regenerates the app icon, adaptive-icon layers, splash images and favicon in assets/images.
 *
 * The mark is a serif "F" over a short rule (the "total line" in a ledger), in the app's ink and paper colours.
 * Rendering uses a real browser so the letter is set in Fraunces exactly as designed.
 *
 *   npm i --no-save puppeteer-core     # and have Google Chrome installed
 *   node scripts/generate-icons.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const INK = '#181712';
const PAPER = '#F5F4F0';
const OUT = resolve(import.meta.dirname, '../assets/images');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** One image: a square canvas with the mark centred, scaled by `scale`. */
function page({ size, bg, fg, scale, radius = 0 }) {
  return `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=block" rel="stylesheet">
<style>
  html,body{margin:0;background:transparent}
  .canvas{width:${size}px;height:${size}px;background:${bg};border-radius:${radius}px;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .mark{display:flex;flex-direction:column;align-items:center;transform:translateY(-${size * 0.024}px) scale(${scale});transform-origin:center}
  .f{font-family:'Fraunces';font-weight:600;font-size:${size * 0.66}px;line-height:.8;color:${fg};letter-spacing:-0.02em;padding-top:${size * 0.02}px}
  .rule{width:${size * 0.3}px;height:${size * 0.026}px;border-radius:${size}px;background:${fg};margin-top:${size * 0.032}px}
</style>
<div class="canvas"><div class="mark"><div class="f">F</div><div class="rule"></div></div></div>`;
}

const jobs = [
  // Launcher icon (opaque). Android uses the adaptive layers below; this is the fallback and the store/web icon.
  { file: 'icon.png', size: 1024, bg: INK, fg: PAPER, scale: 1.12 },
  // Adaptive icon foreground: transparent, kept well inside the central safe zone (Android crops to a circle/squircle).
  { file: 'android-icon-foreground.png', size: 1024, bg: 'transparent', fg: PAPER, scale: 0.85 },
  // Themed (monochrome) icon: Android tints this single-colour silhouette.
  { file: 'android-icon-monochrome.png', size: 1024, bg: 'transparent', fg: '#000000', scale: 0.85 },
  // Splash: the mark alone, transparent. Light and dark variants. (Android 12+ masks the splash icon to a circle.)
  { file: 'splash-icon.png', size: 1024, bg: 'transparent', fg: INK, scale: 0.9 },
  { file: 'splash-icon-dark.png', size: 1024, bg: 'transparent', fg: PAPER, scale: 0.9 },
  { file: 'favicon.png', size: 192, bg: INK, fg: PAPER, scale: 1.1, radius: 40 },
];

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
for (const job of jobs) {
  const p = await browser.newPage();
  await p.setViewport({ width: job.size, height: job.size, deviceScaleFactor: 1 });
  await p.setContent(page(job), { waitUntil: 'networkidle0' });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: resolve(OUT, job.file), omitBackground: true });
  await p.close();
  console.log('wrote', job.file);
}
await browser.close();
