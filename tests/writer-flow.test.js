// The drawn diagram — parser and layout (19 Aug 2026).
//
// Sarah: "have you expanded the diagram? it is still coming up on the
// whiteboard as pretty basic." A ```diagram fence is now parsed into a graph
// and laid out in code, then drawn as an SVG. This test lifts that section
// straight out of writer.html and runs it in node — no browser, no DOM, no
// network — so the syntax and the layout are pinned:
//   a chain, a fan, a merge, a labelled arrow in all three spellings, a
//   two-way arrow, a reversed arrow, a cycle (which must never hang), the
//   title line, a pipe row, the 40-box cap, and text that is not an arrow —
//   and SECTIONS: a heading is a BAND, never a box (19 Aug).
// Run:  node tests/writer-flow.test.js
// Exits 0 on ALL PASS, 1 otherwise.
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'writer.html'), 'utf8');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };

// ── lift the mind-map + flow section out of the page ────────────────────────
const START = "    const MM_RAILS = [";
const END = "      return wbDiagramHtmlLegacy(lines);";
const a = HTML.indexOf(START);
const b = HTML.indexOf(END);
if (a < 0 || b < 0) { console.log('FAIL could not find the flow section in writer.html'); process.exit(1); }
const section = HTML.slice(a, HTML.indexOf('}', HTML.indexOf('}', b) + 1) + 1);
const callout = (/^\s*const WB_CALLOUT = .*$/m.exec(HTML) || [])[0];
if (!callout) { console.log('FAIL could not find WB_CALLOUT'); process.exit(1); }

const F = new Function(
  "const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');\n"
  + "function wbDiagramHtmlLegacy() { return '<div class=\"wb-dg\">LEGACY</div>'; }\n"
  + callout + "\n" + section + "\n"
  + "return { wbFlowParse, wbFlowSvg, flLayout, flNode, wbDiagramHtml, flTokens, flHeading };"
)();

const P = F.wbFlowParse;
const names = g => (g ? g.nodes.map(n => n.text) : []);
const edgeStr = g => (g ? g.edges.map(e => e.from.text + (e.both ? ' <-> ' : ' -> ') + e.to.text + (e.label ? ' [' + e.label + ']' : '')) : []);

// ── the shapes ──────────────────────────────────────────────────────────────
{
  const g = P(['Primary sector -> Secondary sector -> High turnover']);
  ok(g && g.nodes.length === 3 && g.edges.length === 2, 'a chain: 3 boxes, 2 arrows — ' + JSON.stringify(names(g)));
  ok(edgeStr(g).join(' | ') === 'Primary sector -> Secondary sector | Secondary sector -> High turnover', 'the chain runs in order: ' + edgeStr(g).join(' | '));
}
{
  const g = P(['Employer brand -> Reward, Flexibility, Growth']);
  ok(g.nodes.length === 4 && g.edges.length === 3, 'a fan: one source, three targets — ' + JSON.stringify(names(g)));
  ok(g.edges.every(e => e.from.text === 'Employer brand'), 'every arrow of the fan leaves the same box');
}
{
  const g = P(['Pay -> Retention', 'Culture -> Retention', 'Retention -> Lower hiring cost']);
  ok(g.nodes.length === 4, 'a MERGE: naming Retention twice is one box, not two — ' + JSON.stringify(names(g)));
  ok(g.edges.length === 3, 'and three arrows: ' + edgeStr(g).join(' | '));
}
{
  const g = P(['Retention -> Pay', 'RETENTION. -> Culture']);
  ok(g.nodes.length === 3 && g.nodes[0].text === 'Retention', 'the key ignores case and a trailing stop — ' + JSON.stringify(names(g)));
}
{
  const g = P(['A -[because]-> B', 'B --so then--> C', 'C -> D : and finally']);
  ok(g.edges.length === 3 && g.edges.every(e => e.label), 'all three label spellings land: ' + JSON.stringify(g.edges.map(e => e.label)));
  ok(g.edges[0].label === 'because' && g.edges[1].label === 'so then' && g.edges[2].label === 'and finally', 'and each label is its own words');
}
{
  const g = P(['Deskilled work <-> Upskilled work']);
  ok(g.edges.length === 1 && g.edges[0].both === true, 'a two-way arrow is ONE edge marked both ways');
}
{
  const g = P(['Effect <- Cause']);
  ok(g.edges.length === 1 && g.edges[0].from.text === 'Cause' && g.edges[0].to.text === 'Effect', "'A <- B' is B -> A: " + edgeStr(g).join(''));
}
{
  const g = P(['\u{1F534} Deskilled work -> \u{1F4B0} Reward']);
  ok(g.nodes[0].tone === 'bad' && g.nodes[0].text === 'Deskilled work', 'a callout emoji is the box COLOUR and comes off the words');
  ok(g.nodes[1].icon === '\u{1F4B0}' && g.nodes[1].text === 'Reward', 'any other emoji is the box ICON');
}
{
  const g = P(['# Why they leave', 'Pay -> Absence']);
  ok(g.title === 'Why they leave', "a '# ' first line is the figure's title");
  ok(g.nodes.length === 2, 'and it is not a box');
}
{
  const g = P(['Retained | Promoted | Left early']);
  ok(g.nodes.length === 3 && g.edges.length === 0, 'a pipe row is three boxes and no arrows');
  ok(g.rows.length === 1 && g.rows[0].length === 3, 'and it is remembered as one row');
}
{
  const g = P(['Cost-benefit analysis -> Well-being']);
  ok(g.nodes.length === 2 && g.nodes[0].text === 'Cost-benefit analysis', 'a hyphen inside a word is not an arrow — ' + JSON.stringify(names(g)));
}
{
  ok(P([]) === null && P(['', '   ']) === null, 'nothing to draw returns null (the old pill renderer takes it)');
  ok(/LEGACY/.test(F.wbDiagramHtml(['', '  '])), 'and wbDiagramHtml really falls back');
}
{
  const many = [];
  for (let i = 0; i < 60; i++) many.push('Box ' + i + ' -> Box ' + (i + 1));
  const g = P(many);
  ok(g.nodes.length === 40, 'the cap holds at 40 boxes (' + g.nodes.length + ')');
  ok(g.more === 21, 'and it counts the ' + g.more + ' BOXES it could not fit (not the mentions of them)');
  const svg = F.wbFlowSvg(g, null);
  ok(new RegExp('…and ' + g.more + ' more').test(svg), 'and the figure says so on its face, rather than quietly dropping them');
}

// ── sections: a heading is a BAND, never a box ─────────────────────────
// Sarah's screenshot, 19 Aug: Q wrote THE PROBLEM / THE CONTRAST / THE FIX on
// lines of their own and all three came out as floating boxes with no arrows.
{
  ok(F.flHeading('THE PROBLEM:') === 'THE PROBLEM', 'a heading may be shouted AND end in a colon');
  ok(F.flHeading('THE PROBLEM') === 'THE PROBLEM', 'an ALL CAPS bare line is a heading');
  ok(F.flHeading('WHAT IT COSTS (2026)') === 'WHAT IT COSTS (2026)', 'and it may carry spaces, digits and punctuation');
  ok(F.flHeading('Step one:') === 'Step one', "a bare line ending in ':' is a heading, and the colon comes off");
  ok(F.flHeading('Retention') === '', 'an ordinary Capitalised name is a BOX, not a heading');
  ok(F.flHeading('A') === '', 'one character is a box');
  ok(F.flHeading('Retained | Promoted') === '', 'a pipe row is never a heading');
  ok(F.flHeading('\u{1F534}\u{1F534}') === '' && F.flHeading('---') === '', 'and nor is a line with no letters in it');
}
{
  const g = P(['THE PROBLEM', 'Low pay -> High turnover', 'THE FIX', 'Better pay -> Retention']);
  ok(g.sections.length === 2, 'two bare ALL CAPS headings give two bands (' + g.sections.length + ')');
  ok(g.sections.map(s => s.label).join(' | ') === 'THE PROBLEM | THE FIX', 'each band keeps its name: ' + g.sections.map(s => s.label).join(' | '));
  ok(!names(g).some(t => /^THE /.test(t)), 'and NEITHER heading is a box: ' + JSON.stringify(names(g)));
  ok(g.nodes.length === 4 && g.edges.length === 2, 'four boxes, two arrows — the headings cost nothing');
  ok(g.sections[0].nodes.length === 2 && g.sections[1].nodes.length === 2, 'and the boxes sit in the band they were written under');
}
{
  const g = P(['## The problem', 'Low pay -> High turnover', '### The fix', 'Better pay -> Retention']);
  ok(g.sections.length === 2 && g.sections[0].label === 'The problem' && g.sections[1].label === 'The fix', "'##' and '###' open bands too: " + JSON.stringify(g.sections.map(s => s.label)));
  ok(!names(g).some(t => /problem|fix/i.test(t)), 'and no heading became a box: ' + JSON.stringify(names(g)));
}
{
  const g = P(['Aims:', 'Pay -> Retention', 'Risks:', 'Churn -> Cost']);
  ok(g.sections.map(s => s.label).join('|') === 'Aims|Risks', "a trailing ':' opens a band: " + JSON.stringify(g.sections.map(s => s.label)));
  ok(g.nodes.length === 4, 'and the four boxes are the real ones: ' + JSON.stringify(names(g)));
}
{
  const g = P(['# Why they leave', 'THE PROBLEM', 'Low pay -> High turnover']);
  ok(g.title === 'Why they leave', "a single '#' is STILL the figure's title, not a band");
  ok(g.sections.length === 1 && g.sections[0].label === 'THE PROBLEM', 'and the band under it is its own thing');
}
{
  const g = P(['THE PROBLEM', 'Low pay -> High turnover', 'THE MISSING BIT', 'THE FIX', 'Better pay -> Retention']);
  ok(g.sections.length === 2, 'a heading with nothing under it is DROPPED — never an empty band (' + g.sections.length + ')');
  ok(g.sections.map(s => s.label).join('|') === 'THE PROBLEM|THE FIX', 'the ones that hold something stay: ' + JSON.stringify(g.sections.map(s => s.label)));
  const svg = F.wbFlowSvg(g, { ink: true });
  ok(!/THE MISSING BIT/.test(svg), 'and the empty one is nowhere in the drawing');
}
{
  const g = P(['Low pay -> High turnover', 'High turnover -> Client loss']);
  ok(g.sections.length === 1 && g.sections[0].label === '', 'no heading at all = ONE untitled band, exactly as before');
  const svg = F.wbFlowSvg(g, { ink: true });
  ok(!/class="fl-sec"/.test(svg), 'and nothing is written above it');
}
{
  const g = P(['## Warehouse', 'Fixed shifts -> Low turnover', '## Office', 'Hybrid -> Low turnover']);
  ok(g.nodes.length === 4, "node identity is PER BAND: 'Low turnover' in two bands is two boxes (" + g.nodes.length + ')');
  ok(g.sections[0].nodes.length === 2 && g.sections[1].nodes.length === 2, 'one in each band, not merged across them');
  const g2 = P(['## Warehouse', 'Fixed shifts -> Low turnover', 'No training -> Low turnover']);
  ok(g2.nodes.length === 3, 'and INSIDE a band the merge still happens: ' + JSON.stringify(names(g2)));
}
{
  const many = ['## One'];
  for (let i = 0; i < 25; i++) many.push('A' + i + ' -> B' + i);
  many.push('## Two');
  for (let i = 0; i < 25; i++) many.push('C' + i + ' -> D' + i);
  const g = P(many);
  ok(g.nodes.length === 40, 'the 40-box cap is on the WHOLE figure, bands and all (' + g.nodes.length + ')');
  ok(g.more === 60, 'and it still counts the ' + g.more + ' boxes it could not fit');
  ok(/…and 60 more/.test(F.wbFlowSvg(g, { ink: true })), 'and says so on the figure');
}
{
  // Sarah's fence, near enough word for word.
  const g = P(['THE PROBLEM', '\u{1F534} Low pay -> High turnover', 'No progression -> High turnover',
    'High turnover -> \u{1F7E1} Driver shortages, Agency reliance', 'Driver shortages -> Missed deliveries',
    'Missed deliveries -> Client loss', 'Missed deliveries -> Low pay',
    'THE CONTRAST', 'Office staff -> Hybrid, Training, Career path', 'Hybrid -> Low turnover',
    'Warehouse staff -> Fixed shifts, No training', 'No training -> High churn',
    'THE FIX', 'Employer brand -> Better pay, Career paths, Upskilling', 'Better pay -> Retention']);
  ok(g.sections.length === 3, 'her three sections are three bands');
  const svg = F.wbFlowSvg(g, { ink: true });
  ok(!/NaN|Infinity|undefined/.test(svg), 'the drawing has no NaN / Infinity / undefined in it');
  const secs = (svg.match(/class="fl-sec"[^>]*>([^<]*)</g) || []).map(s => s.replace(/^[\s\S]*>/, '').replace(/<$/, ''));
  ok(secs.join('|') === 'THE PROBLEM|THE CONTRAST|THE FIX', 'every band name is written on the figure, once each: ' + JSON.stringify(secs));
  ok(!/<rect[^>]*class="fl-sec"/.test(svg) && !/fl-sec[^>]*fill="(?!#|rgb)/.test(svg), 'a band name is TEXT — no box, no fill behind it');
  ok((svg.match(/class="fl-n"/g) || []).length === g.nodes.length, 'one drawn box per real node (' + (svg.match(/class="fl-n"/g) || []).length + ' of ' + g.nodes.length + ')');
  ok(g.sections.every(s => F.flLayout(s, 'serif').box.every(b => isFinite(b.x) && isFinite(b.y))), 'each band lays out on its own with real coordinates');
  // The bands stack: read every drawn box back off the svg and assert that
  // nothing in the whole figure overlaps anything else.
  const rects = [];
  const re = /<rect class="fl-n" x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
  let m; while ((m = re.exec(svg))) rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
  ok(rects.length === g.nodes.length, 'read ' + rects.length + ' drawn boxes back off the svg');
  let clash = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a2 = rects[i], b2 = rects[j];
    if (a2.x < b2.x + b2.w && b2.x < a2.x + a2.w && a2.y < b2.y + b2.h && b2.y < a2.y + a2.h) clash++;
  }
  ok(clash === 0, 'and NO box overlaps another anywhere in the figure (' + clash + ')');
  const lefts = (svg.match(/class="fl-sec" x="([-\d.]+)"/g) || []).map(s => +(/x="([-\d.]+)"/.exec(s)[1]));
  ok(lefts.length === 3 && lefts.every(v => Math.abs(v - lefts[0]) < 0.6), 'the bands share one left edge: ' + JSON.stringify(lefts));
  const ys = (svg.match(/class="fl-sec" x="[-\d.]+" y="([-\d.]+)"/g) || []).map(s => +(/y="([-\d.]+)"$/.exec(s)[1]));
  ok(ys.length === 3 && ys[0] < ys[1] && ys[1] < ys[2], 'and they run DOWN the figure, one under the next: ' + JSON.stringify(ys));
  const board = F.wbFlowSvg(g, null);
  ok(/Space Grotesk/.test(board) && !/NaN|Infinity/.test(board), 'the whiteboard draws the same bands in the app typeface');
}
// ── the layout ──────────────────────────────────────────────────────────────
const finite = (o) => Object.keys(o).every(k => typeof o[k] !== 'number' || isFinite(o[k]));
{
  const g = P(['Recruitment -> Selection -> Onboarding -> Early leaving -> Recruitment', 'Selection -[bias risk]-> Early leaving']);
  const t0 = Date.now();
  const L = F.flLayout(g, 'sans-serif');
  ok(Date.now() - t0 < 2000, 'a CYCLE lays out and does not hang (' + (Date.now() - t0) + 'ms)');
  ok(Object.keys(L.backs).length === 1, 'exactly one arrow is found to run backwards');
  ok(L.box.every(finite), 'every box has real coordinates');
  const xs = L.box.map(x => x.x);
  ok(new Set(L.layer).size === 4, 'four layers, left to right: ' + JSON.stringify(L.layer));
  ok(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] < xs[3], 'and the boxes step to the right: ' + JSON.stringify(xs.map(Math.round)));
}
{
  const g = P(['Employer brand -> Reward, Flexibility, Growth']);
  const L = F.flLayout(g, 'sans-serif');
  const kids = [1, 2, 3].map(i => L.box[i]);
  ok(kids.every(k => Math.abs(k.x - L.box[0].x) > 40), 'the fan sits in the next layer, not on top of its source');
  const ys = kids.map(k => k.y).sort((p, q) => p - q);
  ok(ys[1] - ys[0] > 20 && ys[2] - ys[1] > 20, 'and the branches are spread apart: ' + JSON.stringify(ys.map(Math.round)));
  const mid = (ys[0] + ys[2]) / 2;
  ok(Math.abs(mid - L.box[0].y) < 6, 'centred on the source (' + Math.round(mid) + ' vs ' + Math.round(L.box[0].y) + ')');
}
{
  const n = F.flNode({ text: 'A really quite long label that has to wrap several times over', icon: '' }, 'sans-serif');
  ok(n.lines.length <= 3, 'a long label wraps to at most three lines: ' + JSON.stringify(n.lines));
  ok(n.lines.every(l => l.length <= 29), 'and no line runs away: ' + JSON.stringify(n.lines.map(l => l.length)));
  ok(n.h >= n.lines.length * n.lh, 'the box is tall enough for its lines');
}

// ── the drawing ─────────────────────────────────────────────────────────────
{
  const g = P(['# Why they leave', 'Pay freeze -> Absence -> Overtime bill', '\u{1F534} Poor culture -[trust goes]-> Absence', 'Absence -> Agency cover, Missed deadlines', 'Missed deadlines -> Pay freeze']);
  const svg = F.wbFlowSvg(g, { ink: true });
  ok(/^<svg class="q-fl"/.test(svg), 'ink mode draws an svg.q-fl');
  ok(/viewBox="[-\d.]+ [-\d.]+ \d+ \d+"/.test(svg), 'with a real viewBox: ' + (/viewBox="[^"]*"/.exec(svg) || [])[0]);
  ok(!/NaN|Infinity|undefined/.test(svg), 'and no NaN / Infinity / undefined anywhere in it');
  ok((svg.match(/class="fl-n"/g) || []).length === g.nodes.length, 'one drawn box per node (' + (svg.match(/class="fl-n"/g) || []).length + ')');
  ok((svg.match(/<path /g) || []).length >= g.edges.length, 'at least one path per arrow');
  ok(/class="fl-lab"/.test(svg) && /trust goes/.test(svg), "the arrow's label is drawn");
  ok(/stroke-dasharray=/.test(svg), 'and the line is broken for it rather than painted over');
  ok(/font-family="Lora, Georgia, serif"/.test(svg), 'the document serif on the page, never the UI font');
  ok(!/Space Grotesk/.test(svg), 'Space Grotesk is nowhere near the page figure');
  ok(!/fill="[^"]*" opacity="0.07"/.test(svg), 'no tinted fills in ink — line work only');

  const board = F.wbFlowSvg(g, null);
  ok(/^<svg class="wb-fl"/.test(board), 'the whiteboard draws an svg.wb-fl');
  ok(/Space Grotesk/.test(board), 'and it uses the app typeface there');
  ok(!/NaN|Infinity/.test(board), 'no NaN on the board either');
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
