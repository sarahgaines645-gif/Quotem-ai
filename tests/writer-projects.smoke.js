// Writer PROJECTS smoke (16 Aug 2026): boots the server on a throwaway port +
// volume, logs in as the bootstrap person and exercises one person holding
// several assignments — index, isolation, header resolution, rename / open /
// remove, reset scoping. No model calls, no network. Run:
//     node tests/writer-projects.smoke.js
// Exits 0 on ALL PASS, 1 otherwise. Prints PASS/FAIL per check.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const REPO = path.join(__dirname, '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'q-writer-smoke-'));
const VOL = path.join(SCRATCH, 'vol-' + process.pid);
fs.mkdirSync(VOL, { recursive: true });
const PORT = 8137 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const logPath = path.join(SCRATCH, 'smoke-' + process.pid + '.log');
const logFd = fs.openSync(logPath, 'w');
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: REPO,
  env: { ...process.env, NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: VOL, PORT: String(PORT), TOGETHER_API_KEY: 'throwaway', Q_AUTH_PEPPER: 'throwaway-pepper-0123456789', SARAH_EMAIL: 'verify@example.test' },
  stdio: ['ignore', logFd, logFd],
});
let failed = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  let up = false;
  for (let i = 0; i < 40; i++) { await sleep(1000); try { const r = await fetch(BASE + '/health'); if (r.ok) { up = true; break; } } catch (_) {} }
  ok(up, 'server up on ' + PORT);
  if (!up) return;
  let pw = null;
  for (let i = 0; i < 20 && !pw; i++) { await sleep(1000); const log = fs.readFileSync(logPath, 'utf8'); const m = log.match(/Password \(shown ONCE[^\n]*\n\s*(\S+)/); if (m) pw = m[1]; }
  ok(!!pw, 'bootstrap password in log');
  if (!pw) return;
  const r = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'verify@example.test', password: pw }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  ok(r.ok && cookie, 'login → cookie (' + r.status + ')');
  const H = (extra) => ({ Cookie: cookie, 'Content-Type': 'application/json', ...(extra || {}) });
  const j = async (method, url, body, extra) => { const rr = await fetch(BASE + url, { method, headers: H(extra), body: body === undefined ? undefined : JSON.stringify(body) }); let d = null; try { d = await rr.json(); } catch (_) {} return { status: rr.status, d }; };

  // 1. brand-new person: no projects, tutor null
  let x = await j('GET', '/writer/projects');
  ok(x.status === 200 && x.d.ok && x.d.projects.length === 0 && x.d.active === 'main', 'GET /writer/projects (fresh) → 0 projects, active main: ' + JSON.stringify(x.d));
  x = await j('GET', '/writer/tutor');
  ok(x.status === 200 && x.d.tutor === null, 'GET /writer/tutor (fresh) → null');

  // 2. write to main (no header) → registers main
  x = await j('POST', '/writer/tutor', { docTitle: 'First essay', docText: 'one two three four five' });
  ok(x.status === 200 && x.d.ok, 'POST /writer/tutor (no header) saves to main');
  x = await j('GET', '/writer/projects');
  ok(x.d.projects.length === 1 && x.d.projects[0].id === 'main' && x.d.projects[0].name === 'First essay' && x.d.projects[0].words === 5, 'main registered, named from docTitle, 5 words: ' + JSON.stringify(x.d.projects));

  // 3. new project → active; tutor for it is empty; main untouched
  x = await j('POST', '/writer/projects', {});
  const pid = x.d && x.d.id;
  ok(x.status === 200 && /^p[a-z0-9]{10}$/.test(pid || '') && x.d.active === pid, 'POST /writer/projects → new id active: ' + pid);
  x = await j('GET', '/writer/tutor');
  ok(x.d.tutor === null, 'GET /writer/tutor (no header, active=new) → null');
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': 'main' });
  ok(x.d.tutor && x.d.tutor.docTitle === 'First essay', 'GET /writer/tutor with header main → First essay');

  // 4. write to the new one WITH header; isolation both ways
  x = await j('POST', '/writer/tutor', { docTitle: 'Second essay', docText: 'a b c' }, { 'X-Writer-Project': pid });
  ok(x.d.ok, 'POST /writer/tutor header=new saves');
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': pid });
  ok(x.d.tutor && x.d.tutor.docTitle === 'Second essay', 'new project reads back Second essay');
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': 'main' });
  ok(x.d.tutor && x.d.tutor.docTitle === 'First essay' && x.d.tutor.docText === 'one two three four five', 'main still First essay (isolation)');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(VOL).filter(f => path.basename(f).startsWith('q-tutor')).map(f => path.relative(VOL, f));
  ok(files.some(f => f.includes('--proj-' + pid)) && files.some(f => path.basename(f).startsWith('q-tutor-index-')), 'files: ' + files.join(', '));

  // 5. bad header → falls back to active (not 500)
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': 'pzzzzzzzzzz' });
  ok(x.status === 200 && x.d.tutor && x.d.tutor.docTitle === 'Second essay', 'unknown header id → active project served');
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': '../../etc' });
  ok(x.status === 200, 'garbage header → 200, ignored');

  // 6. rename / open / remove
  x = await j('POST', '/writer/projects/rename', { id: pid, name: 'CIPD 7 — reward' });
  ok(x.d.ok && x.d.projects.find(p => p.id === pid).name === 'CIPD 7 — reward', 'rename');
  x = await j('POST', '/writer/projects/open', { id: 'main' });
  ok(x.d.ok && x.d.active === 'main', 'open main → active main');
  x = await j('GET', '/writer/tutor');
  ok(x.d.tutor && x.d.tutor.docTitle === 'First essay', 'no-header GET now serves main');
  x = await j('POST', '/writer/projects/open', { id: 'pnotreal000' });
  ok(x.status === 404, 'open unknown → 404');
  x = await j('POST', '/writer/projects/remove', { id: pid });
  ok(x.d.ok && !x.d.projects.some(p => p.id === pid) && x.d.active === 'main', 'remove new → gone from list, main active');
  ok(!!files.find(f => f.includes('--proj-' + pid)) && fs.existsSync(path.join(VOL, files.find(f => f.includes('--proj-' + pid)))), 'removed project file still on disk (nothing deleted)');
  x = await j('POST', '/writer/projects/remove', { id: 'main' });
  ok(x.d.ok && x.d.projects.length === 0 && x.d.active === 'main', 'remove main → empty list, active falls back to main: ' + JSON.stringify(x.d));
  x = await j('POST', '/writer/projects', {});
  ok(x.d.ok && x.d.projects.length === 1, 'new after empty → 1 project');

  // 7. reset within a project only touches that project
  const pid2 = x.d.id;
  await j('POST', '/writer/tutor', { docTitle: 'Third' }, { 'X-Writer-Project': pid2 });
  x = await j('POST', '/writer/tutor', { reset: true }, { 'X-Writer-Project': pid2 });
  ok(x.d.reset === true, 'reset in project');
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': 'main' });
  ok(x.d.tutor && x.d.tutor.docTitle === 'First essay', 'main untouched by reset in other project');

  // 7b. the walk position round-trips (17 Aug: refresh went back to Q1)
  x = await j('POST', '/writer/tutor', { editPos: { kind: 'mark', key: null, index: 3, at: 1 } }, { 'X-Writer-Project': pid2 });
  x = await j('GET', '/writer/tutor', undefined, { 'X-Writer-Project': pid2 });
  ok(x.d.tutor && x.d.tutor.editPos && x.d.tutor.editPos.index === 3, 'editPos saved and read back');

  // 8. new routes with {} → 4xx not 500
  for (const u of ['/writer/projects/open', '/writer/projects/rename', '/writer/projects/remove', '/writer/proofread', '/writer/mark-part']) { x = await j('POST', u, {}); ok(x.status >= 400 && x.status < 500, u + ' {} → ' + x.status); }

  // 9. served page has the switcher + header helper
  const page = await (await fetch(BASE + '/writer', { headers: { Cookie: cookie } })).text();
  ok(page.includes('id="proj-btn"') && page.includes('X-Writer-Project') && page.includes('.q-tip'), 'served /writer has switcher, header helper, tooltip');

  const log = fs.readFileSync(logPath, 'utf8');
  const bad = log.split('\n').filter(l => /TypeError|ReferenceError|Failed to mount|cannot find module/i.test(l));
  ok(bad.length === 0, 'log clean of TypeError/ReferenceError' + (bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''));
}
main().catch(e => { console.log('FAIL exception ' + e.message); failed++; }).finally(() => {
  try { child.kill(); } catch (_) {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'FAILED ' + failed : 'ALL PASS');
  process.exit(failed ? 1 : 0);
});
