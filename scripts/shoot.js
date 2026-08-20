/* SEE THE PAGE, NOT THE CODE.
 *
 * The single biggest cost in building these 3D pages has been that I write
 * them and cannot look at them — every wrong angle, every invisible coat, every
 * character facing the wall costs a round trip through Sarah's eyes. This drives
 * the Edge that is already on the machine over the DevTools protocol, loads a
 * page, optionally clicks things and waits, and writes a PNG. Then the picture
 * comes back to me and the loop closes.
 *
 * Uses puppeteer-core against the installed Edge — no 150MB Chromium download.
 *
 *   node scripts/shoot.js <url> <out.png> [--wait 4000] [--click "#b-play"]
 *                          [--after 2500] [--size 1100x760] [--eval "js"]
 *
 * --click may be repeated. --after is how long to wait once the clicks are done
 * (i.e. how far into an animation to shoot). --eval runs JS in the page before
 * shooting, which is how you jump an animation to a particular moment.
 */
const fs = require('fs');
const path = require('path');

/* FIND PUPPETEER WHEREVER IT IS.
   ⚠️ This used to point at one session's scratchpad by absolute path. Those get
   cleaned up, and when it went so did the ability to see anything — the tool
   died with "Cannot find module" pointing at a folder that no longer existed.
   Try the project's own node_modules first (install once with
   `npm install --no-save puppeteer-core`), then any scratchpad given by env. */
let puppeteer = null;
for (const attempt of [
  () => require('puppeteer-core'),
  () => require(path.join(process.cwd(), 'node_modules', 'puppeteer-core')),
  () => require(path.join(process.env.CLAUDE_SCRATCH || '', 'node_modules', 'puppeteer-core')),
]) {
  try { puppeteer = attempt(); break; } catch (e) { /* try the next */ }
}
if (!puppeteer) {
  console.error('puppeteer-core not found. From the project root run: npm install --no-save puppeteer-core');
  process.exit(1);
}

/* somewhere private to keep the browser profile — never the user's own */
const SCRATCH = process.env.CLAUDE_SCRATCH
  || path.join(require('os').tmpdir(), 'shoot-scratch');
try { fs.mkdirSync(SCRATCH, { recursive: true }); } catch (e) {}

/* WHICH BROWSER TO DRIVE, best first.
   ⚠️ Puppeteer's OWN cached Chrome is tried BEFORE the installed Edge. Edge is
   the machine's everyday browser: when it has an update staged, or a profile
   already open, it refuses to start a second instance and exits 0 with no
   output at all — which reads as "the tool is broken" and cost a whole evening
   of working blind. The cached Chrome has neither problem. */
const EDGE_CANDIDATES = [
  ...(() => {
    try {
      const base = path.join(process.env.USERPROFILE || '', '.cache', 'puppeteer', 'chrome');
      return fs.readdirSync(base)
        .map((v) => path.join(base, v, 'chrome-win64', 'chrome.exe'))
        .filter((p) => fs.existsSync(p))
        .sort().reverse();                       // newest build first
    } catch (e) { return []; }
  })(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === '--' + name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

(async () => {
  const url = process.argv[2];
  const out = process.argv[3] || 'shot.png';
  if (!url) { console.error('usage: node scripts/shoot.js <url> <out.png> [--wait ms] [--click sel] [--after ms]'); process.exit(1); }

  const exe = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) { console.error('no Edge or Chrome found'); process.exit(1); }

  const [w, h] = (arg('size', '1100x760')).split('x').map(Number);

  /* ITS OWN PROFILE, ALWAYS.
     Edge (like Chrome) will not start a second instance on a profile that is
     already open — it hands the request to the RUNNING copy and exits 0. From
     puppeteer's side that looks like "Failed to launch the browser process:
     Code: 0" with an empty stderr, which reads as a broken tool and is really
     just Sarah having Edge open. A private profile per run avoids it entirely. */
  const profile = path.join(SCRATCH, 'shoot-profile-' + process.pid);
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    userDataDir: profile,
    args: [
      '--no-sandbox',
      // WebGL in headless needs software rendering to be reliable; without
      // these the canvas comes back blank and everything looks broken.
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-features=IsolateOrigins,site-per-process',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=' + w + ',' + h,
    ],
  });

  /* ALWAYS CLOSE THE BROWSER. Anything that threw between launch and the close
     at the bottom used to leave a headless Edge — and its 6-8 child processes —
     running forever. On an 8GB machine a handful of failed runs ate every spare
     megabyte and then nothing could launch at all, which looks exactly like
     "the tool is broken" and is really "the tool leaked". */
  let closed = false;
  const shut = async () => { if (closed) return; closed = true; try { await browser.close(); } catch (e) {} };
  process.on('exit', () => { try { const p = browser.process(); if (p) p.kill('SIGKILL'); } catch (e) {} });
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { shut().then(() => process.exit(1)); }));

  try {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });

  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 200)); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('requestfailed', (r) => problems.push('failed: ' + r.url().slice(0, 120) + ' — ' + (r.failure() && r.failure().errorText)));

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => problems.push('goto: ' + e.message));
  await new Promise((r) => setTimeout(r, parseInt(arg('wait', '4500'), 10)));

  for (const sel of argAll('click')) {
    try { await page.click(sel); problems.push('clicked ' + sel); }
    catch (e) { problems.push('COULD NOT CLICK ' + sel + ': ' + e.message.split('\n')[0]); }
    await new Promise((r) => setTimeout(r, 350));
  }

  const js = arg('eval', null);
  if (js) {
    try { const v = await page.evaluate(js); problems.push('eval -> ' + JSON.stringify(v).slice(0, 6000)); }
    catch (e) { problems.push('EVAL FAILED: ' + e.message.split('\n')[0]); }
  }

  await new Promise((r) => setTimeout(r, parseInt(arg('after', '1200'), 10)));
  await page.screenshot({ path: out });

  console.log('shot ' + url + ' -> ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB)');
  if (problems.length) console.log(problems.map((p) => '  ' + p).join('\n'));
  } finally {
    await shut();
  }
})().catch((e) => { console.error('SHOOT FAILED: ' + e.message); process.exit(1); });
