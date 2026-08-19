// THE TEACHING BOARD IS Q'S (19 Aug 2026).
//
// Sarah: "theres still nothing on the teaching board" / "why cant Q see the
// teaching board? he should know whats on it he should be the one controling
// it." So Q got two tools — board_note puts a line on the teaching board,
// board_clear takes HIS OWN notes back off it — and the page grew boardForQ()
// so what is on the board rides up with every turn.
//
// This test pins the parts that are cheap to break and expensive to notice:
// the gate (his board tools exist on the writer only), the argument handling
// (a 200-character cap, a default label, an empty note refused), and the one
// rule that protects her work — board_clear removes ONLY the items Q put
// there, never her question, never her answer, never a step's mark.
//
// The page side is lifted straight out of writer.html and run in node — no
// browser, no DOM, NO MODEL IS CALLED BY THIS TEST, ever.
//
// Run:  node tests/writer-board.test.js
// Exits 0 on ALL PASS, 1 otherwise.
'use strict';

const fs = require('fs');
const path = require('path');
const tools = require('../plugins/q-tools');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 68 - t.length)));

// ── the tools exist, and only where they belong ─────────────────────────────
function theGate() {
    section('the gate');
    const defs = tools.TOOL_DEFINITIONS.map(t => t.function && t.function.name);
    ok(defs.includes('board_note'), 'board_note is a tool Q has');
    ok(defs.includes('board_clear'), 'board_clear is a tool Q has');

    const namesFor = (opts) => tools.selectActiveTools('put that on the board for me', opts).map(t => t.function.name);
    const writer = namesFor({ surface: 'writer-coach' });
    ok(writer.includes('board_note') && writer.includes('board_clear'), 'on the writer coach he has both board tools');
    ok(writer.includes('stick_note') && writer.includes('tab_paragraph'), 'and still has the tools he already had there');

    for (const surface of ['chat', 'thread', 'email', undefined]) {
        const n = namesFor(surface ? { surface } : {});
        ok(!n.includes('board_note') && !n.includes('board_clear'),
            'no board tools on surface ' + (surface || '(none)') + ' — the teaching board is the writer\'s');
    }
}

// ── the arguments ───────────────────────────────────────────────────────────
async function theArguments() {
    section('board_note arguments');
    const run = (args) => tools.executeTool('board_note', args, {});

    const empty = await run({ text: '   ' });
    ok(empty && empty.error, 'an empty note is refused: ' + (empty && (empty.error || 'no error')));
    const none = await run({});
    ok(none && none.error, 'no text at all is refused');

    const plain = await run({ text: '  Define  the   term before you use it. ' });
    ok(plain.onBoard === true, 'a real note comes back onBoard');
    ok(plain.text === 'Define the term before you use it.', 'whitespace is squeezed: ' + JSON.stringify(plain.text));
    ok(plain.label === 'note', 'no label given → "note"');
    ok(plain.kind === 'note', 'no kind given → note');

    const long = await run({ text: 'x'.repeat(400) });
    ok(long.text.length === 200, 'text over the cap is trimmed to 200 characters, not refused (' + long.text.length + ')');

    const todo = await run({ text: 'Add a source to P4.', kind: 'todo' });
    ok(todo.kind === 'todo' && todo.label === 'to do', 'kind todo gets the "to do" label by default');
    const q = await run({ text: 'Which two procedures are you comparing?', kind: 'question' });
    ok(q.kind === 'question' && q.label === 'think about', 'kind question gets "think about"');
    const junk = await run({ text: 'Anything.', kind: 'shout' });
    ok(junk.kind === 'note', 'a kind outside note/question/todo falls back to note');

    const tagged = await run({ text: 'Two procedures, not one.', label: '  watch   out  ' });
    ok(tagged.label === 'watch out', 'a label is squeezed and kept: ' + JSON.stringify(tagged.label));
    const bigLabel = await run({ text: 'x', label: 'y'.repeat(60) });
    ok(bigLabel.label.length === 24, 'a runaway label is trimmed to 24 characters (' + bigLabel.label.length + ')');

    section('board_clear arguments');
    const all = await tools.executeTool('board_clear', {}, {});
    ok(all.cleared === true && all.label === '', 'no label = take all of his notes off');
    const one = await tools.executeTool('board_clear', { label: ' to do ' }, {});
    ok(one.cleared === true && one.label === 'to do', 'a label is squeezed and kept: ' + JSON.stringify(one.label));
}

// ── the page side, lifted out of writer.html ────────────────────────────────
function thePage() {
    section('the page: only Q\'s notes ever come off');
    const HTML = fs.readFileSync(path.join(__dirname, '..', 'writer.html'), 'utf8');
    const START = '    function qBoardItems() {';
    const END = '    function clearQBoardNotes(label) {';
    const a = HTML.indexOf(START);
    const b = HTML.indexOf(END);
    if (a < 0 || b < 0) { console.log('FAIL could not find the board functions in writer.html'); process.exit(1); }
    const endOfClear = HTML.indexOf('\r\n    }', b) + '\r\n    }'.length;
    const src = HTML.slice(a, endOfClear);

    const F = new Function(
        "const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');\n"
        + "const state = { boardItems: [], currentCriterionId: 'AC1.1' };\n"
        + 'let persisted = null;\n'
        + 'function persist(p) { persisted = p; }\n'
        + 'function renderBoard() {}\n'
        + "function appendBoardItem({ type, label, text }) { if (!text) return null; const it = { type, label: label || '', text: String(text), quiet: false }; state.boardItems.push(it); return it; }\n"
        + src + '\n'
        + 'return { state, qBoardItems, qBoardHtml, addQBoardNotes, clearQBoardNotes, persisted: () => persisted };'
    )();

    // Her board: the question she was asked, her answer, the mark on it.
    F.state.boardItems.push({ type: 'question', label: 'Q1', text: 'Explain two procedures.' });
    F.state.boardItems.push({ type: 'answer', label: '', text: 'Small claims and judicial review.' });
    F.state.boardItems.push({ type: 'note', label: 'marked', text: 'This question: a pass.' });

    const n = F.addQBoardNotes([
        { text: 'Name the court, not just "the court".', label: 'watch out' },
        { text: 'Add a source to P4.', kind: 'todo' },
        { text: '   ', label: 'nothing' },
    ]);
    ok(n === 2, 'two real notes go up, the empty one does not (' + n + ')');
    ok(F.qBoardItems().length === 2, 'both are marked as his');
    ok(F.state.boardItems.length === 5, 'and hers are untouched underneath');

    const again = F.addQBoardNotes([{ text: 'Add a source to P4.', kind: 'todo' }]);
    ok(again === 0 && F.qBoardItems().length === 2, 'he does not put the same note up twice');

    const over = F.addQBoardNotes([{ text: 'z'.repeat(500) }]);
    ok(over === 1 && F.qBoardItems()[2].text.length === 200, 'the page caps a long note at 200 characters too');
    F.clearQBoardNotes('note');   // that one was only here to test the cap

    const html = F.qBoardHtml();
    ok(/class="tb-qnotes"/.test(html), 'his notes render as their own raised card');
    ok(/class="ex-title">Keep this/.test(html), 'titled "Keep this" — a pink card title, like every other board card');
    ok(!/background/.test(html), 'no fill of any kind in his card — depth comes from the shadow');
    ok(/data-qkind="todo"/.test(html), 'a to-do carries its kind, so its dot can differ');
    ok(html.indexOf('&quot;the court&quot;') > 0, 'his text is escaped, not injected');

    const cleared = F.clearQBoardNotes('watch out');
    ok(cleared === 1, 'clearing one label takes exactly that one off (' + cleared + ')');
    ok(F.state.boardItems.length === 4, 'her three items and his other note are still there');

    const rest = F.clearQBoardNotes();
    ok(rest === 1, 'clearing with no label takes the rest of HIS off (' + rest + ')');
    ok(F.state.boardItems.length === 3, 'and her three items survive it');
    ok(F.state.boardItems.every(it => !it.fromQ), 'nothing of his is left');
    ok(F.state.boardItems.map(it => it.text).join(' | ') === 'Explain two procedures. | Small claims and judicial review. | This question: a pass.',
        'her question, her answer and the mark are exactly as they were');

    const nothing = F.clearQBoardNotes();
    ok(nothing === 0, 'clearing an empty board removes nothing');
    ok(F.qBoardHtml() === '', 'and with no notes of his, no card is drawn');

    const p = F.persisted();
    ok(p && Array.isArray(p.qBoardNotes) && p.qBoardNotes.length === 0, 'the last save wrote an empty list, so a refresh brings none back');
}

(async () => {
    theGate();
    await theArguments();
    thePage();
    console.log(failed ? '\n' + failed + ' FAILED' : '\nALL PASS  (no model was called by this test)');
    process.exit(failed ? 1 : 0);
})();
