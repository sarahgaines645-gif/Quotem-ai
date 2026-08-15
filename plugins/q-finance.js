'use strict';

/**
 * Q FINANCE — personal finance engine
 *
 * Per-user finance data stored as flat JSON on the Railway volume.
 * All paths are keyed to personEmail — GDPR-safe by construction,
 * no cross-user data bleed possible.
 *
 * Files under data/users/{email-slug}/finance/
 *   transactions.json  — array of Transaction objects
 *   assignments.json   — { "merchantKey": { label, bucket } }
 *   problems.json      — array of Problem objects (debts, disputes, letters)
 *
 * Transaction schema:
 *   { id, date, description, amount, category, bucket, merchant, recurring, flagged }
 *
 * Problem schema:
 *   { id, type, title, provider, amount, dueDate, status, documents, addedAt }
 */

const fs   = require('fs');
const path = require('path');
const { Q_CONFIG }       = require('../config');
const { userDataPath }   = require('./user-data');
const { cleanModelOutput } = require('./cjk-filter');

// Call Together AI via plain fetch — same pattern as q-email-writer.js
// Pass extra = { response_format, ... } for JSON mode etc.
async function togetherChat({ model, messages, temperature = 0, max_tokens = 4000, ...extra }) {
    // Hard 90s timeout. Without this, a hung Together AI connection makes the
    // whole request hang forever and the UI sits on "reading…" indefinitely.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res;
    try {
        res = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, messages, temperature, max_tokens, ...extra }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('Together AI timed out after 90s — the statement was not read');
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Together AI ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    return msg.content || msg.reasoning_content || msg.reasoning || '';
}

// Real Gemini vision via REST — mirrors the proven call in the surveying
// app (server/services/ai.js). No SDK/dependency. 90s hard timeout like
// togetherChat so it can never hang. Returns the model's text, or throws.
async function geminiVision({ prompt, base64, mimeType = 'image/jpeg', maxTokens = 8192 }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res;
    try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: base64 } },
                ] }],
                generationConfig: { temperature: 0.0, maxOutputTokens: maxTokens },
            }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('Gemini timed out after 90s');
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const cand = json?.candidates?.[0];
    if (cand?.finishReason === 'MAX_TOKENS') {
        console.warn('[finance] Gemini hit MAX_TOKENS — output truncated; very large statement may be incomplete (CSV export is exact)');
    }
    const parts = cand?.content?.parts;
    return Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
}

// One vision entry point. Real Gemini when GEMINI_API_KEY is set (it reads
// documents/statements far better than Kimi), with Kimi-via-Together as the
// automatic fallback so reliability can only improve, never regress.
// Fully reversible: unset GEMINI_API_KEY → straight back to Kimi.
// Text-only Gemini call (categorisation, freeform-text parsing). Same
// transport/timeout/parse as geminiVision — just no image. This is how
// the WHOLE finance import runs on Gemini; Together is never touched
// until Q (chat) sees the finished data.
async function geminiText(prompt, { maxTokens = 8000, thinkingBudget } = {}) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res;
    try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                // 2.5-flash is a thinking model: on big mechanical jobs
                // (categorising 120 rows) the thinking eats the whole output
                // budget and the JSON truncates. Callers doing sorting-not-
                // reasoning pass thinkingBudget: 0 to switch thinking off.
                generationConfig: {
                    temperature: 0.0, maxOutputTokens: maxTokens,
                    ...(thinkingBudget != null && { thinkingConfig: { thinkingBudget } }),
                },
            }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('Gemini timed out after 90s');
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const cand = json?.candidates?.[0];
    if (cand?.finishReason === 'MAX_TOKENS') console.warn('[finance] Gemini text MAX_TOKENS — output truncated');
    const parts = cand?.content?.parts;
    return Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
}

// Finance vision is Gemini ONLY — never Together/Kimi. Customer bank
// documents must not leave to Together (GDPR), and Gemini does the job.
// On failure return '' so callers degrade to an honest "couldn't read"
// message — never silently route bank data elsewhere.
async function visionRead({ prompt, base64, mimeType = 'image/jpeg', maxTokens = 8000 }) {
    if (!process.env.GEMINI_API_KEY) return '';
    try {
        const out = await geminiVision({ prompt, base64, mimeType, maxTokens });
        if (out && out.trim()) { console.log('[finance] vision via Gemini'); return cleanModelOutput(out); }
        console.warn('[finance] vision: Gemini returned empty');
    } catch (e) {
        console.warn(`[finance] vision: Gemini failed (${e.message})`);
    }
    return '';
}

// ── File helpers ──────────────────────────────────────────────────

function finPath(email, filename) {
    return userDataPath(email, `finance/${filename}`);
}

function loadJSON(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { /* corrupt file — return fallback */ }
    return fallback;
}

function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}


// ── Transactions ──────────────────────────────────────────────────

function getTransactions(email) {
    return loadJSON(finPath(email, 'transactions.json'), []);
}

function saveTransactions(email, transactions) {
    saveJSON(finPath(email, 'transactions.json'), transactions);
}

function getAssignments(email) {
    return loadJSON(finPath(email, 'assignments.json'), {});
}

function saveAssignments(email, assignments) {
    saveJSON(finPath(email, 'assignments.json'), assignments);
}

function getProblems(email) {
    return loadJSON(finPath(email, 'problems.json'), []);
}

function saveProblems(email, problems) {
    saveJSON(finPath(email, 'problems.json'), problems);
}


// ── Statement parsing ─────────────────────────────────────────────

// Sarah's prompt. The old robotic "You are a parser, return ONLY JSON"
// version made V4 push back by narrating. This asks normally — the same
// way it already works in chat — and the assistant prefill enforces the
// shape. Do NOT re-add response_format here (documented V4 trap).
const PARSE_SYSTEM = `Here's a bank statement. Pull out every transaction — date, description, amount, and a cleaned-up merchant name. Format it as JSON with a rows array.

Include every transaction exactly as it appears. Do not skip, merge, summarise, or guess. If you can't read a line clearly, flag it — don't invent it.

Amount is negative for money out, positive for money in. UK date formats. Skip opening/closing balance rows and headers.`;

async function parseStatementText(rawText) {
    const text = rawText.replace(/£/g, '').slice(0, 30000);
    console.log(`[finance] parseStatementText: ${text.length} chars, first 300: ${text.slice(0, 300).replace(/\n/g, '↵')}`);

    let raw = '';
    try {
        raw = cleanModelOutput(await geminiText(`${PARSE_SYSTEM}\n\n${text}`, { maxTokens: 8192 }));
    } catch (e) {
        console.warn(`[finance] parseStatementText Gemini failed (${e.message}) — 0 rows`);
    }
    console.log(`[finance] model reply (first 300): ${raw.slice(0, 300).replace(/\n/g, '↵')}`);

    const rowsFrom = (v) => Array.isArray(v?.rows) ? v.rows
                          : Array.isArray(v?.transactions) ? v.transactions
                          : Array.isArray(v) ? v
                          : null;
    const tryRows = (s) => { try { return rowsFrom(JSON.parse(s)); } catch { return null; } };

    const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    let rows = tryRows(cleaned);
    if (!rows) { const m = cleaned.match(/\{[\s\S]*\}/); if (m) rows = tryRows(m[0]); }
    if (!rows) { const m = cleaned.match(/\[[\s\S]*\]/); if (m) { try { const x = JSON.parse(m[0]); if (Array.isArray(x)) rows = x; } catch { /* none */ } } }
    rows = rows || [];
    console.log(`[finance] parseStatementText: ${rows.length} transactions${rows.length ? '' : ' — parse failed, raw: ' + raw.slice(0, 200).replace(/\n/g, '↵')}`);
    return rows;
}

const CATEGORISE_SYSTEM = `You are a personal finance categoriser. Given a list of bank transactions, assign a category to each one.

Categories:
  food_groceries   — supermarkets, groceries (Tesco, Aldi, Lidl, etc.)
  food_dining      — restaurants, takeaways, cafés (McDonald's, Deliveroo, Greggs, etc.)
  transport        — fuel, rail, bus, Uber, parking
  subscriptions    — recurring digital services (Netflix, Spotify, Amazon Prime, gym, etc.)
  utilities        — gas, electric, water, broadband, phone
  housing          — rent, mortgage, council tax
  shopping         — clothing, Amazon (non-Prime), general retail
  health           — pharmacy, GP, dentist, optician
  children         — school meals, kids' activities, kids' clothing
  holidays         — flights, hotels, travel bookings
  savings_transfer — transfers to savings, ISA contributions, moves to/from the person's OWN pots or own other accounts (e.g. a "pot", the account holder's own name, "MONEY" top-ups between own banks)
  income           — wages, HMRC credits, benefits, refunds
  fees_charges     — bank charges, overdraft fees, late fees
  other            — anything that doesn't fit above

Self-transfers matter: money moved between the person's own accounts or pots is savings_transfer in BOTH directions (out AND back in) — it is never income and never real spending. People often upload statements from SEVERAL of their own banks: a top-up arriving from the person's own name, "MONEY", or another of their banks is savings_transfer, not income.

Return a JSON array — same order as input — each item:
{ "id": "<the id field from input>", "category": "<category>", "recurring": true|false }

recurring = true if this looks like a regular subscription or standing order.
Return ONLY the JSON array.`;

async function categoriseTransactions(transactions) {
    if (!transactions.length) return transactions;

    // Rows the parser already labelled from the bank's own data (e.g. Monzo
    // "Pot transfer" → savings_transfer) are ground truth — never re-guessed.
    const todo = transactions.filter(t => !t.category || t.category === 'other');

    // Batch — one giant call over a 3-month statement (565 txns) blew the
    // 90s timeout and the throw discarded the WHOLE import. Small batches
    // each finish fast, and a failed batch only loses that batch's
    // categories (left as 'other'), never the transactions themselves.
    const BATCH = 120;   // Gemini is fast & reliable — bigger batches, far fewer calls
    const catMap = {};

    for (let i = 0; i < todo.length; i += BATCH) {
        const slice = todo.slice(i, i + BATCH);
        const input = slice.map(t => ({
            id:          t.id,
            description: t.description,
            merchant:    t.merchant,
            amount:      t.amount,
        }));
        try {
            // thinkingBudget 0: this is sorting, not reasoning. With thinking
            // on, 2.5-flash burned the whole 8000-token budget deliberating
            // and truncated the JSON (MAX_TOKENS) on nearly every batch.
            const raw = cleanModelOutput(await geminiText(`${CATEGORISE_SYSTEM}\n\n${JSON.stringify(input)}`, { maxTokens: 8000, thinkingBudget: 0 }));
            // Salvage object-by-object rather than requiring one complete
            // array — a truncated response still yields every whole item.
            let got = 0;
            for (const objStr of (raw.match(/\{[^{}]*\}/g) || [])) {
                try { const c = JSON.parse(objStr); if (c && c.id) { catMap[c.id] = c; got++; } } catch { /* partial trailing object */ }
            }
            if (got < slice.length) console.warn(`[finance] categorise batch ${i}-${i + slice.length}: ${got}/${slice.length} labelled — rest stay 'other'`);
        } catch (e) {
            console.warn(`[finance] categorise batch ${i}-${i + slice.length} failed (${e.message}) — those rows stay 'other'`);
        }
    }

    return transactions.map(t => (t.category && t.category !== 'other')
        ? t
        : {
            ...t,
            category:  catMap[t.id]?.category  || 'other',
            recurring: catMap[t.id]?.recurring || false,
        });
}


// ── Deterministic bank-CSV parser ─────────────────────────────────
// A real bank CSV is already structured. Sending it to the AI to "parse"
// is what hangs/times out. This reads the HEADER ROW and maps columns by
// name so it works across UK bank formats — and never picks the Balance
// column as the amount (the trap a naive last-number parser falls into).

// Split one CSV line, honouring "quoted, fields" that contain commas.
function splitCsvLine(line) {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
}

// Date normaliser → YYYY-MM-DD. ISO is unambiguous. D/M/Y vs M/D/Y is not:
// these are UK statements so UK (day-first) is preferred — BUT a past
// transaction cannot be months in the future, so if the UK reading lands
// absurdly ahead while the US reading is sane, the source was day/month
// swapped and the US reading is taken. A small future grace is allowed
// because statements legitimately list scheduled items a few weeks out.
const DATE_FUTURE_GRACE_MS = 45 * 24 * 60 * 60 * 1000;

function _ymd(y, mo, d) {
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normDate(s) {
    s = String(s || '').trim();

    // ISO YYYY-MM-DD or YYYY/MM/DD — unambiguous.
    let m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) {
        const mo = +m[2], d = +m[3];
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return _ymd(+m[1], mo, d);
    }

    // D/M/Y or M/D/Y — ambiguous. Build both valid readings.
    m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) {
        let y = m[3]; if (y.length === 2) y = '20' + y; y = +y;
        const a = +m[1], b = +m[2];
        const uk = (a >= 1 && a <= 31 && b >= 1 && b <= 12) ? _ymd(y, b, a) : null; // a=day  b=month
        const us = (a >= 1 && a <= 12 && b >= 1 && b <= 31) ? _ymd(y, a, b) : null; // a=month b=day
        const tooFuture = d => d && (Date.parse(d) - Date.now()) > DATE_FUTURE_GRACE_MS;
        if (uk && !tooFuture(uk)) return uk;
        if (us && !tooFuture(us)) return us;
        return uk || us || null;
    }

    // "01 May 2026" / "1 May 26"
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})/);
    if (m) {
        const mo = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 }[m[2].slice(0, 3).toLowerCase()];
        if (mo) { let y = m[3]; if (y.length === 2) y = '20' + y;
            return _ymd(+y, mo, +m[1]); }
    }
    return null;
}

// "£1,234.56" → 1234.56 ; "(12.34)" → -12.34
function parseAmount(s) {
    if (s == null) return null;
    let str = String(s).trim().replace(/[£$€,]/g, '');
    if (!str) return null;
    let neg = false;
    if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1); }
    const n = parseFloat(str);
    if (Number.isNaN(n)) return null;
    return neg ? -Math.abs(n) : n;
}

// Returns rows[] for a recognisable bank CSV, or null if it isn't one
// (caller then falls back to the AI parser for freeform/pasted text).
function parseCsvStatement(text) {
    const lines = String(text || '').replace(/```(?:csv)?/gi, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null;

    let headerIdx = -1, cols = null;
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
        const c = splitCsvLine(lines[i]).map(h => h.toLowerCase());
        const hasDate = c.some(h => /date/.test(h));
        const hasAmt  = c.some(h => /amount|debit|credit|paid\s*(in|out)|money\s*(in|out)|withdrawn|deposit|value/.test(h));
        if (hasDate && hasAmt) { headerIdx = i; cols = c; break; }
    }
    if (headerIdx === -1) return null;

    const idxDate   = cols.findIndex(h => /date/.test(h));
    const idxAmt    = cols.findIndex(h => /^amount|^value|amount\s*\(/.test(h));   // single signed col — never "balance"
    const idxDebit  = cols.findIndex(h => /debit|paid\s*out|money\s*out|withdrawn/.test(h));
    const idxCredit = cols.findIndex(h => /credit|paid\s*in|money\s*in|deposit/.test(h));
    const idxDesc   = cols.findIndex(h => /description|details|narrative|reference|counter\s*party|payee|particulars|memo|name/.test(h));
    // The bank's own transaction-type column (Monzo "Type", others
    // "Transaction Type"). Ground truth for self-transfers: a pot transfer is
    // the user moving their OWN money, and counting it as spending AND income
    // is exactly what made the headline totals read as lies.
    const idxType   = cols.findIndex(h => /^type$|transaction\s*type/.test(h));

    const hasSingle = idxAmt !== -1;
    const hasSplit  = idxDebit !== -1 && idxCredit !== -1;
    if (idxDate === -1 || (!hasSingle && !hasSplit)) return null;

    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const f = splitCsvLine(lines[i]);
        const date = normDate(f[idxDate]);
        if (!date) continue;
        let amount;
        if (hasSingle) {
            amount = parseAmount(f[idxAmt]);
        } else {
            const dr = parseAmount(f[idxDebit]);
            const cr = parseAmount(f[idxCredit]);
            if (cr != null && cr !== 0) amount = Math.abs(cr);
            else if (dr != null && dr !== 0) amount = -Math.abs(dr);
        }
        if (amount == null || Number.isNaN(amount)) continue;
        const desc = (idxDesc !== -1 && f[idxDesc] ? f[idxDesc]
            : f.filter((_, j) => ![idxDate, idxAmt, idxDebit, idxCredit].includes(j)).join(' ')).trim();
        const row = { date, description: desc, merchant: desc, amount };
        // Narrow on purpose: only the unambiguous self-move type. "Faster
        // payment" / "Monzo-to-Monzo" can be real payments to real people —
        // those stay with the AI categoriser.
        if (idxType !== -1 && /pot\s*transfer/i.test(f[idxType] || '')) {
            row.category = 'savings_transfer';
            row.recurring = false;
        }
        rows.push(row);
    }
    return rows.length ? rows : null;
}


/**
 * Parse + categorise raw statement text, merge with existing user transactions
 * (deduplication by date+merchant+amount), and save.
 * Returns { added, total } counts.
 *
 * A recognisable bank CSV is parsed deterministically (no AI, no hang).
 * Only freeform/pasted text that isn't CSV falls back to the AI parser.
 */
// Which statement a row came from ("Monzo Data Export", "halifax aug") —
// the thread that lets cross-account transfers be recognised and lets the
// page say which account a charge leaves. Filename first (most readable),
// then a header signature, then a plain fallback.
function deriveSource(filename, rawText) {
    if (filename) {
        const base = String(filename).replace(/\.[a-z0-9]+$/i, '').replace(/[_\-()]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (base) return base.slice(0, 28);
    }
    const head = String(rawText || '').split(/\r?\n/).slice(0, 3).join(' ').toLowerCase();
    if (head.includes('money out') && head.includes('transaction id')) return 'Monzo';
    return 'statement';
}

async function importStatement(email, rawText, opts = {}) {
    const source = deriveSource(opts.filename, rawText);
    const csvRows = parseCsvStatement(rawText);
    if (csvRows && csvRows.length) {
        console.log(`[finance] importStatement: ${csvRows.length} rows via deterministic CSV parser (no AI) — source "${source}"`);
        return saveRows(email, csvRows.map(r => ({ ...r, source })));
    }
    const parsed = await parseStatementText(rawText);
    return saveRows(email, parsed.map(r => ({ ...r, source })));
}

// Categorise + apply merchant assignments + dedup against existing + save.
// Shared by the text path (parseStatementText → rows) and the image path
// (csvToRows → rows). Returns { added, total }.
// A single personal transaction is never this large. A bigger "amount" is
// the running balance or a reference/account number the reader mistook for
// the transaction value — one such row poisons every total (the £-trillions
// income bug). Used to reject poison at the only point every import path
// funnels through, and to keep already-poisoned stored data out of the totals.
const MAX_TXN_AMOUNT = 1000000;

async function saveRows(email, parsed) {
    if (!parsed.length) return { added: 0, total: 0 };

    // Drop impossible amounts BEFORE anything is persisted. This is the single
    // chokepoint every import path (text, CSV, image, PDF) passes through, so
    // corruption can never reach the store from here on.
    const sane = parsed.filter(t => {
        const ok = Number.isFinite(t.amount) && Math.abs(t.amount) <= MAX_TXN_AMOUNT;
        if (!ok) console.warn(`[finance] dropped impossible row at import — ${t.date} ${t.amount} "${String(t.description || '').slice(0, 40)}"`);
        return ok;
    });
    if (!sane.length) return { added: 0, total: 0 };
    parsed = sane;

    // Stamp each parsed row with an id before categorising
    const stamped = parsed.map(t => ({ ...t, id: uid(), bucket: null, flagged: false }));

    // SAVE FIRST. Categorisation is an AI pass that can be slow or flaky;
    // holding the save hostage to it is what produced the false "Import
    // failed: unknown error" — the phone gave up while the server was still
    // labelling batches. Rows land immediately (parser-set categories kept,
    // the rest 'other'), the response returns at once, and the labels fill
    // themselves in in the background. A statement is NEVER lost or delayed
    // because of categorisation.
    const uncategorised = stamped.map(t => ({
        ...t,
        category:  t.category  || 'other',
        recurring: t.recurring || false,
    }));

    // Apply existing merchant assignments
    const assignments = getAssignments(email);
    const withBuckets = uncategorised.map(t => {
        const key = merchantKey(t.merchant || t.description);
        const asgn = assignments[key];
        return asgn ? { ...t, bucket: asgn.label } : t;
    });

    // Deduplicate against existing transactions
    const existing = getTransactions(email);
    const existingKeys = new Set(existing.map(t => dedupKey(t)));
    const fresh = withBuckets.filter(t => !existingKeys.has(dedupKey(t)));
    const merged = [...existing, ...fresh];
    merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    saveTransactions(email, merged);

    // Background label pass over the rows that just landed as 'other'.
    // Patches by id, and only where the row is STILL 'other' — a category
    // the user or the parser has set is never overwritten.
    const toLabel = fresh.filter(t => !t.category || t.category === 'other');
    if (toLabel.length) {
        (async () => {
            try {
                const labelled = await categoriseTransactions(toLabel);
                const byId = new Map(labelled.filter(t => t.category && t.category !== 'other').map(t => [t.id, t]));
                if (byId.size) {
                    const current = getTransactions(email);
                    const updated = current.map(t => (byId.has(t.id) && (!t.category || t.category === 'other'))
                        ? { ...t, category: byId.get(t.id).category, recurring: byId.get(t.id).recurring || false }
                        : t);
                    saveTransactions(email, updated);
                }
                console.log(`[finance] background categorise done — ${byId.size}/${toLabel.length} rows labelled`);
            } catch (e) {
                console.warn(`[finance] background categorise failed (${e.message}) — rows stay 'other' (Sort categories can rerun it)`);
            }
        })();
    }

    return { added: fresh.length, total: merged.length };
}

// Re-run the label pass over every stored row still sitting in 'other'.
// Powers the "Sort categories" button — for imports whose background pass
// was interrupted (deploy, restart) or that predate the save-first change.
// Only rows still 'other' are touched; user-set categories are safe.
async function recategoriseOther(email) {
    const all = getTransactions(email);
    const todo = all.filter(t => !t.category || t.category === 'other');
    if (!todo.length) return { updated: 0, remaining_other: 0, total: all.length };
    const labelled = await categoriseTransactions(todo);
    const byId = new Map(labelled.filter(t => t.category && t.category !== 'other').map(t => [t.id, t]));
    let updated = 0;
    const next = getTransactions(email).map(t => {
        if (byId.has(t.id) && (!t.category || t.category === 'other')) {
            updated++;
            return { ...t, category: byId.get(t.id).category, recurring: byId.get(t.id).recurring || false };
        }
        return t;
    });
    if (updated) saveTransactions(email, next);
    const remaining = next.filter(t => !t.category || t.category === 'other').length;
    console.log(`[finance] recategorise — ${updated} rows labelled, ${remaining} still 'other'`);
    return { updated, remaining_other: remaining, total: next.length };
}

function dedupKey(t) {
    return `${t.date}|${Number(t.amount).toFixed(2)}|${merchantKey(t.merchant || t.description)}`;
}

function merchantKey(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
}


// ── Bill / document extraction via vision ─────────────────────────

const BILL_PROMPT = `You are a document reader extracting data from a utility bill, debt letter, or financial document photo/PDF.

Return STRICT JSON only — no markdown fences:
{
  "type":        "bill" | "debt_letter" | "final_demand" | "court_notice" | "refund" | "statement" | "other",
  "provider":    "company name (e.g. 'British Gas', 'Vodafone', 'HMRC')",
  "category":    "gas" | "electric" | "water" | "broadband" | "phone" | "council_tax" | "debt" | "insurance" | "other",
  "amount_gbp":  123.45 or null,
  "due_date":    "YYYY-MM-DD or null",
  "reference":   "account or reference number if visible, else null",
  "urgency":     "low" | "medium" | "high" | "urgent",
  "headline":    "one short sentence describing what this document is and what action is needed",
  "notes":       "any important extra detail (payment plan offers, discount schemes mentioned, etc.) or null",
  "full_text":   "the COMPLETE verbatim text of the document — every line, every figure, every date, every name and reference number, exactly as written. Do NOT summarise, shorten or omit anything. This is what Q reads to help with the matter."
}
If you cannot read the document, return { "error": "Cannot read document" }.`;

const STATEMENT_IMAGE_PROMPT = `You are reading a bank statement document. Extract EVERY transaction you can see.
Return them as plain CSV with a header row and one transaction per line:
date,description,amount

Rules:
- date: YYYY-MM-DD format
- description: exact text from the statement
- amount: NEGATIVE number for money leaving the account (payments/debits), POSITIVE for money coming in (credits/income)
- The amount is ONLY the money value of that one transaction. It is NEVER the
  running balance, an account number, a sort code, a payment reference, a
  customer/NI number, or a date or year. Those belong in the description, not
  the amount.
- Write the amount as a plain decimal only — e.g. -45.20 or 1200.00 or 0.05.
  Never glue any other digits (a year like 2026, a reference) onto it.
- description and amount are SEPARATE comma-separated fields. Keep every
  reference/year/number inside the description field; the third field must be
  the money value alone.
- If a line has no clear single money amount, skip that line entirely.
- Do NOT include balance columns, opening/closing balance totals, or header/footer rows
- If multiple pages are visible, extract ALL of them
- Return ONLY the CSV. No explanation, no markdown.`;

// Deterministic CSV → rows. The vision model already returns clean
// `date,description,amount` CSV — re-feeding that through a second model to
// "parse" it was the redundant call that doubled per-page latency and made
// pages blow the timeout. Parsing it here is instant and never times out.
// Robust to commas inside descriptions (date is the first field, amount the
// trailing number) and to UK date drift (DD/MM/YYYY → YYYY-MM-DD).
function csvToRows(csv) {
    const clean = String(csv || '').replace(/```(?:csv)?/gi, '').trim();
    const out = [];
    for (const line of clean.split(/\r?\n/)) {
        const l = line.trim();
        if (!l || /^"?date"?\s*,/i.test(l)) continue;          // blank or header row

        // Amount = the LAST comma-separated field, validated as a clean money
        // token. The old "last number anywhere on the line" grabbed reference
        // numbers and the statement year when they sat next to the amount —
        // a DWP reference read as £3.7tn, "Interest …2026" as £20,260.05.
        const fields = splitCsvLine(l);
        let amount = null;
        if (fields.length >= 3) {
            const tok = fields[fields.length - 1].replace(/[£$€\s]/g, '');
            if (/^-?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^-?\d{1,9}(\.\d{1,2})?$/.test(tok)) {
                amount = parseFloat(tok.replace(/,/g, ''));
            }
        }
        if (amount === null) {                                  // non-CSV freeform fallback
            const amtM = l.match(/(-?\d[\d,]*(?:\.\d+)?)\s*$/);
            if (amtM) {
                const v = parseFloat(amtM[1].replace(/,/g, ''));
                if (!Number.isNaN(v) && Math.abs(v) <= 99999999) amount = v;
            }
        }
        if (amount === null || Number.isNaN(amount)) continue;
        // Date from field 0 (consistent with amount = last field). Whole-line
        // fallback only for non-CSV/malformed input. normDate auto-corrects a
        // day/month-swapped read that would otherwise land in the future.
        let date = (fields.length >= 3) ? normDate(fields[0]) : null;
        if (!date) date = normDate(l);
        if (!date) continue;
        let desc;
        if (fields.length >= 3) {
            // everything between the date (field 0) and the amount (last field)
            desc = fields.slice(1, -1).join(' ').replace(/^[\s,"]+|[\s,"]+$/g, '').trim();
        } else {
            desc = l.replace(/^[^,]*,/, '')                       // drop leading date field
                    .replace(/-?\d[\d,]*(?:\.\d+)?\s*$/, '')      // drop trailing amount
                    .replace(/^[\s,"]+|[\s,"]+$/g, '')
                    .trim();
        }
        out.push({ date, description: desc, merchant: desc, amount });
    }
    return out;
}

async function importStatementFromImage(email, imageBase64, mimeType, filename) {
    const raw = await visionRead({
        prompt:   STATEMENT_IMAGE_PROMPT,
        base64:   imageBase64,
        mimeType: mimeType || 'image/jpeg',
        maxTokens: 8000,
    });
    if (!raw || raw.trim().length < 20) return { added: 0, total: 0 };
    const source = deriveSource(filename, '');
    const rows = csvToRows(raw).map(r => ({ ...r, source }));
    console.log(`[finance] importStatementFromImage: vision ${raw.length} chars → ${rows.length} rows (no re-parse)`);
    return saveRows(email, rows);
}

// Gemini 2.0 Flash caps OUTPUT at ~8192 tokens (~300 CSV rows). A 3-month
// statement has more, so one call truncates. Split the PDF into small page
// ranges so each call stays well under the ceiling, read them sequentially
// (sequential = no rate-limit storm, unlike the old per-page loop), then
// stitch. Any range that fails is reported, never silently dropped.
const PDF_CHUNK_PAGES = 4;

async function pdfToCsvChunked(fileBase64, onProgress) {
    const { PDFDocument } = require('pdf-lib');
    const src = await PDFDocument.load(Buffer.from(fileBase64, 'base64'), { ignoreEncryption: true });
    const pageCount = src.getPageCount();

    const readChunk = (b64) => geminiVision({
        prompt: STATEMENT_IMAGE_PROMPT, base64: b64, mimeType: 'application/pdf', maxTokens: 8192,
    }).then(cleanModelOutput);

    // Small statement → one call, no added latency.
    if (pageCount <= PDF_CHUNK_PAGES) {
        const csvOne = await readChunk(fileBase64);
        try { onProgress && onProgress(pageCount, pageCount); } catch {}
        return { csv: csvOne, failed: [], pageCount };
    }

    let csv = '';
    const failed = [];
    for (let start = 0; start < pageCount; start += PDF_CHUNK_PAGES) {
        const end = Math.min(start + PDF_CHUNK_PAGES, pageCount);
        const label = `${start + 1}-${end}`;
        try {
            const sub = await PDFDocument.create();
            const idxs = Array.from({ length: end - start }, (_, k) => start + k);
            (await sub.copyPages(src, idxs)).forEach(p => sub.addPage(p));
            const subB64 = Buffer.from(await sub.save()).toString('base64');
            csv += '\n' + await readChunk(subB64);
            console.log(`[finance] PDF chunk pages ${label}/${pageCount} read`);
        } catch (e) {
            console.error(`[finance] PDF chunk pages ${label} failed: ${e.message}`);
            failed.push(label);
        }
        try { onProgress && onProgress(end, pageCount); } catch {}
    }
    return { csv, failed, pageCount };
}

// PDF → split into page-range chunks, each read by Gemini (reads PDFs
// natively), stitched and de-duped. Replaces the old per-page-image loop
// (fragmented/collapsed) and the single-call version (truncated at ~300
// rows). For everyone, any size, any device — no "go export CSV" ask.
// Images → vision model as before.
async function importStatementFromFile(email, fileBase64, mimeType, onProgress, filename) {
    if (mimeType === 'application/pdf') {
        const total = getTransactions(email).length;
        if (!process.env.GEMINI_API_KEY) {
            return { added: 0, total, hint: 'PDF reading is temporarily unavailable — please try again shortly.' };
        }
        let chunked;
        try {
            chunked = await pdfToCsvChunked(fileBase64, onProgress);
        } catch (e) {
            console.error('[finance] PDF→Gemini failed:', e.message);
            return { added: 0, total, hint: 'Could not read this PDF — try uploading it again, or a clearer copy.' };
        }
        const source = deriveSource(filename, '');
        const rows = csvToRows(chunked.csv).map(r => ({ ...r, source }));
        console.log(`[finance] PDF→Gemini chunked: ${chunked.pageCount} pages → ${rows.length} rows; failed: ${chunked.failed.join(', ') || 'none'}`);
        if (!rows.length) {
            return { added: 0, total, hint: 'Could not read transactions from this PDF — try uploading a clearer copy.' };
        }
        const result = await saveRows(email, rows);
        if (chunked.failed.length) {
            result.hint = `Imported ${result.added} transactions, but page(s) ${chunked.failed.join(', ')} of ${chunked.pageCount} couldn't be read — upload the same PDF again to retry those.`;
        }
        return result;
    }
    // Actual image (JPEG, PNG, WebP, etc.)
    return importStatementFromImage(email, fileBase64, mimeType || 'image/jpeg', filename);
}


// ── Async import job ──────────────────────────────────────────────
// A multi-page PDF takes minutes (sequential Gemini reads + categorise).
// That outlives the HTTP request — the browser/proxy times out and shows a
// false "couldn't read it" while the server is in fact still working and
// succeeds. So the upload starts a background job and returns at once; the
// page polls this record for progress. Persisted per-user on the volume so
// it survives a page refresh or a device switch (a phone user does both).
const IMPORT_JOB = 'import-job.json';
const IMPORT_STALE_MS = 25 * 60 * 1000;

function getImportJob(email) {
    const j = loadJSON(finPath(email, IMPORT_JOB), null);
    if (j && j.status === 'running'
        && Date.now() - Date.parse(j.updatedAt || j.createdAt || 0) > IMPORT_STALE_MS) {
        const stale = { ...j, status: 'error', phase: 'error',
            error: 'The import stopped unexpectedly. Please try uploading again.',
            updatedAt: new Date().toISOString() };
        saveJSON(finPath(email, IMPORT_JOB), stale);
        return stale;
    }
    return j;
}

function _setImportJob(email, patch) {
    const cur = loadJSON(finPath(email, IMPORT_JOB), {}) || {};
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    saveJSON(finPath(email, IMPORT_JOB), next);
    return next;
}

// Starts the import in the background and returns immediately. The job
// record is the single source of truth the page polls — same fire-and-
// forget philosophy as the scheduler's worker.
function startImportJob(email, fileBase64, mimeType, filename) {
    const id = 'imp' + Date.now().toString(36);
    _setImportJob(email, {
        id, status: 'running', phase: 'reading',
        pagesDone: 0, pagesTotal: 0,
        added: 0, total: getTransactions(email).length,
        hint: null, error: null,
        createdAt: new Date().toISOString(),
    });

    (async () => {
        try {
            const onProgress = (done, totalPages) => {
                _setImportJob(email, {
                    pagesDone: done, pagesTotal: totalPages,
                    phase: (totalPages && done >= totalPages) ? 'saving' : 'reading',
                });
            };
            const result = await importStatementFromFile(email, fileBase64, mimeType, onProgress, filename);
            _setImportJob(email, {
                status: 'done', phase: 'done',
                added: result.added || 0,
                total: result.total != null ? result.total : getTransactions(email).length,
                hint: result.hint || null,
            });
            console.log(`[finance] import job ${id} done — added:${result.added} total:${result.total}`);
        } catch (e) {
            console.error(`[finance] import job ${id} failed:`, e.message);
            _setImportJob(email, { status: 'error', phase: 'error',
                error: e.message || 'Import failed' });
        }
    })();

    return { jobId: id, status: 'running' };
}


async function extractDocument(imageBase64, mimeType = 'image/jpeg') {
    const raw = await visionRead({
        prompt:    BILL_PROMPT,
        base64:    imageBase64,
        mimeType,
        // 8192 is the proven-safe cap. NOTE: raising it to 32000 made LARGE PDF
        // reads (e.g. a 3-month bank statement) fail with a Gemini 400 — a big
        // image/PDF input PLUS a big output reservation tips the request over a
        // per-request limit (32000 is fine on its own / for text). At 8192 these
        // big docs still process; they just hit MAX_TOKENS and truncate — which
        // the salvage below now recovers as partial text instead of 0 chars.
        // (Full transcription of very long statements needs page-chunking — TODO.)
        maxTokens: 8192,
    });
    if (!raw || !raw.trim()) return { error: 'empty' };
    // Clean, complete JSON — the normal path (keeps the structured bill fields).
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
    } catch { /* truncated or invalid JSON — salvage below rather than lose it */ }
    // Salvage: Gemini truncated the JSON (no closing brace/quote) or returned
    // non-JSON. Don't throw the document away — pull the full_text value out,
    // even if its closing quote is missing, and unescape it so Q still reads it.
    const m2 = raw.match(/"full_text"\s*:\s*"((?:\\.|[^"\\])*)/);
    const salvaged = (m2 ? m2[1] : raw)
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        .trim();
    console.warn(`[finance] extractDocument salvaged ${salvaged.length} chars from a truncated/non-JSON read`);
    return salvaged ? { full_text: salvaged, truncated: true } : { error: 'Parse failed', raw };
}

// Describe video footage (CCTV, enforcement camera, dashcam) as plain text.
// Gemini 2.5 Flash accepts video via inline_data for files up to ~20MB raw.
// Returns a detailed plain-text description Q can reason over.
async function extractVideo(base64, mimeType = 'video/mp4') {
    const prompt = `This is enforcement camera, CCTV, or dashcam footage. Watch it and describe EVERYTHING you observe:
- Every timestamp shown (exact date and time, frame by frame if they change)
- Every vehicle registration plate — read every character exactly
- Make, model, and colour of each vehicle
- Every road sign and its EXACT wording
- Road markings, bollards, restrictions
- Actions: which vehicles enter/exit the zone, direction of travel, any stops
- Pedestrians and their positions
- Any camera reference numbers, GPS coordinates, or location overlays shown on screen
- Any other on-screen text or graphics

Be precise. Miss nothing. Lay it out clearly so a legal reader can follow the timeline.`;
    try {
        const text = await visionRead({ prompt, base64, mimeType, maxTokens: 4096 });
        return text || '';
    } catch (e) {
        if (/too large|size|limit/i.test(e.message)) {
            const mb = Math.round(base64.length * 0.75 / 1024 / 1024);
            return `(Video is ~${mb}MB — too large for inline processing. Compress it below 20MB and re-upload, or describe the key moments in the chat.)`;
        }
        throw e;
    }
}


// Read a form PDF and return the list of fillable fields.
// Gemini identifies every blank, checkbox, or signature space and returns
// a JSON array: [{name, label, context, type}] ready for extractFieldValues.
async function scanFormFields(pdfBase64) {
    if (!process.env.GEMINI_API_KEY) return { error: 'vision_unavailable', fields: [] };
    const prompt = `You are reading a document that may or may not be a form. Identify EVERY place where a human needs to provide information, including:
- Blank lines or underscores after labels (e.g. "Name: ________")
- Empty boxes, cells, or tables waiting to be filled
- Checkboxes or circles to tick/select
- Numbered or lettered items with blank space for a response
- Any labelled space that looks empty or incomplete
- Signature or date areas

Be generous — if something looks like it might need filling, include it.

For each, return:
- name: camelCase key (e.g. fullName, dateOfBirth, vehicleRegistration)
- label: clear 2-6 word description (e.g. "Full name", "Date of contravention")
- context: 5-10 surrounding words from the document
- type: text | date | checkbox | signature | address | number | textarea

If the document has absolutely NO spaces for user input, return [].
Return ONLY a valid JSON array. No explanation, no markdown.`;
    try {
        const raw = await visionRead({ prompt, base64: pdfBase64, mimeType: 'application/pdf', maxTokens: 4096 });
        const match = (raw || '').match(/\[[\s\S]*\]/);
        if (!match) return { error: null, fields: [] };
        const fields = JSON.parse(match[0]);
        return { error: null, fields: Array.isArray(fields) ? fields : [] };
    } catch (e) {
        console.warn('[finance] scanFormFields failed:', e.message);
        return { error: e.message, fields: [] };
    }
}

// ── Merchant assignment ───────────────────────────────────────────

/**
 * Tag a merchant to a bucket label (e.g. "Charlie", "Car", "Business").
 * Updates all existing transactions with that merchant and saves.
 */
function assignMerchant(email, merchant, label) {
    const key = merchantKey(merchant);
    const assignments = getAssignments(email);
    if (label) {
        assignments[key] = { label, original: merchant, updatedAt: new Date().toISOString() };
    } else {
        delete assignments[key]; // null/empty label = remove assignment
    }
    saveAssignments(email, assignments);

    // Backfill existing transactions
    const txns = getTransactions(email);
    const updated = txns.map(t => {
        if (merchantKey(t.merchant || t.description) === key) {
            return { ...t, bucket: label || null };
        }
        return t;
    });
    saveTransactions(email, updated);
    return { ok: true, affected: updated.filter(t => merchantKey(t.merchant || t.description) === key).length };
}


// One-shot, idempotent data repair. Imports made before the parser was
// hardened stored rows where a reference number or the statement year was
// read as the amount (a DWP reference as £3.7tn; "Interest …2026" as
// £20,260.05). One such row wrecks every total. Remove the provably-
// impossible rows — but back the whole file up first so nothing is ever
// truly lost, and log every removal. Idempotent: once clean it does nothing.
function isCorruptAmount(t) {
    if (!Number.isFinite(t.amount)) return true;
    if (Math.abs(t.amount) > MAX_TXN_AMOUNT) return true;
    // The year-prefix transcription bug: a genuine interest credit is pennies
    // or a few pounds — tens of thousands means the year was mashed onto it.
    if (Math.abs(t.amount) >= 1000 && /\binterest\b/i.test(String(t.description || ''))) return true;
    return false;
}

// A stored date that sits months in the future is a day/month-swapped read
// (a past transaction can't be ahead of today). If swapping the month/day
// yields a sane non-future date, that was the true date. Only ever touches
// a provably-future date — good dates are left exactly as they are.
function fixFutureDate(d) {
    if (!d || typeof d !== 'string') return d;
    const t = Date.parse(d);
    if (!Number.isFinite(t) || (t - Date.now()) <= DATE_FUTURE_GRACE_MS) return d;
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(d);
    if (!m) return d;
    const mo = +m[2], day = +m[3];
    if (day >= 1 && day <= 12) {                       // swap only yields a valid month
        const swapped = `${m[1]}-${String(day).padStart(2, '0')}-${String(mo).padStart(2, '0')}`;
        const st = Date.parse(swapped);
        if (Number.isFinite(st) && (st - Date.now()) <= DATE_FUTURE_GRACE_MS) return swapped;
    }
    return d;   // can't safely recover — leave as-is rather than guess
}

function repairTransactions(email) {
    const txns = getTransactions(email);
    if (!txns.length) return { removed: 0, dateFixed: 0 };

    const corrupt = txns.filter(isCorruptAmount);
    let dateFixed = 0;
    const repaired = txns.filter(t => !isCorruptAmount(t)).map(t => {
        const fixed = fixFutureDate(t.date);
        if (fixed !== t.date) { dateFixed++; return { ...t, date: fixed }; }
        return t;
    });

    // Nothing to do → no write, no backup. Keeps this idempotent on every
    // graph load (it runs there).
    if (!corrupt.length && !dateFixed) return { removed: 0, dateFixed: 0 };

    const bak = `transactions.corrupt-backup-${Date.now()}.json`;
    saveJSON(finPath(email, bak), txns);                 // full backup BEFORE mutating
    for (const t of corrupt) {
        console.warn(`[finance] repair removed corrupt row — ${t.date} ${t.amount} "${String(t.description || '').slice(0, 40)}"`);
    }
    saveTransactions(email, repaired);
    const ds = repaired.map(t => t.date).filter(Boolean).sort();
    console.warn(`[finance] repair: removed ${corrupt.length} corrupt, fixed ${dateFixed} future dates; range ${ds[0]}..${ds[ds.length - 1]}; backup=${bak}; ${repaired.length} remain`);
    return { removed: corrupt.length, dateFixed, backup: bak };
}

// Independent fact-check pass on Q's case-mode replies. Uses Gemini (a
// different vendor, different model) so it's not Q rubber-stamping Q —
// which is the whole reason his self-verifier can't catch his own
// errors. Extracts every specific factual claim Q made (statute, case
// number, date, figure, multiplier, named official, named policy) and
// labels each verified / incorrect / unverifiable — and is explicitly
// instructed that "unverifiable" is the right answer when in doubt,
// never to guess "verified". Returns { checks: [...] }; never throws.
const CASE_VERIFIER_PROMPT = `You are a strict, independent citation checker for a UK legal / council-tax dispute. You receive an AI assistant's draft reply to a user, plus the case material the assistant was working from. Your ONE job is to extract every specific FACTUAL claim the draft asserts and check it.

CHECK ONLY (ignore opinion, strategy and tone):
- Statute citations (Act + section / schedule)
- Case reference numbers (Ombudsman, court decisions)
- Specific dates, and any date differences / durations / "X days" / "Y times longer" the draft computes
- Specific figures of money, percentages, multipliers, day-counts
- Specific named officials / bodies and the actions attributed to them
- Named external policies / charters / standards (e.g. a council's customer charter)

For each, return ONE of:
- "verified" — confident it is correct (matches the case material, or matches reliable knowledge of UK law)
- "incorrect" — confident it is wrong (contradicts the case material; or the cite/figure is demonstrably wrong; or arithmetic is wrong — give the correct number in the note)
- "unverifiable" — you cannot confirm it from the case material or your own reliable knowledge. THIS IS THE CORRECT ANSWER WHEN UNSURE. Never guess "verified". A real verification means you actually know.

RULES — hard:
- A specific case reference number (e.g. "LGSCO 20 012 892") is "verified" ONLY if you know that exact decision exists AND concerns what is claimed. Otherwise "unverifiable".
- A statute section must be a real section that actually says what is claimed.
- For day-counts and multipliers, recompute from the dates the draft itself uses; show the calculation in the note.
- Do not include verifications of vague claims, opinions, or strategy. Only specific, checkable facts.
- Be sparing with "verified" — when in doubt, "unverifiable".

OUTPUT — STRICT JSON ONLY, no prose around it:
{ "checks": [ { "claim": "<short verbatim fragment>", "status": "verified|incorrect|unverifiable", "note": "<one short line>" } ] }

If there are no specific factual claims to check, return { "checks": [] }.`;

async function verifyCaseReply({ userMessage, draftReply, caseContext } = {}) {
    if (!process.env.GEMINI_API_KEY) return { checks: [], error: 'no-key' };
    if (!draftReply || typeof draftReply !== 'string' || draftReply.trim().length < 20) {
        return { checks: [] };
    }
    const prompt = `${CASE_VERIFIER_PROMPT}

--- USER QUESTION ---
${String(userMessage || '').slice(0, 3000)}

--- DRAFT REPLY (the AI's answer — check this) ---
${draftReply.slice(0, 12000)}

--- CASE MATERIAL (what the AI was working from) ---
${String(caseContext || '(none provided)').slice(0, 30000)}`;
    try {
        const raw = await geminiText(prompt, { maxTokens: 4096 });
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { checks: [] };
        const parsed = JSON.parse(m[0]);
        const ok = new Set(['verified', 'incorrect', 'unverifiable']);
        const checks = Array.isArray(parsed.checks)
            ? parsed.checks
                .filter(c => c && typeof c.claim === 'string' && ok.has(c.status))
                .map(c => ({
                    claim:  String(c.claim).slice(0, 240),
                    status: c.status,
                    note:   String(c.note || '').slice(0, 400),
                }))
                .slice(0, 20)
            : [];
        return { checks };
    } catch (e) {
        console.warn('[verify] verifyCaseReply failed:', e.message);
        return { checks: [], error: e.message };
    }
}

// ── Spending graphs ───────────────────────────────────────────────

// Cross-account transfer pairing. With statements from several of the
// user's own banks in one list, their own money hopping between accounts
// shows as a debit in one statement and an equal credit in another — which
// read as "spending" and "income" and made the totals lies. Pair them:
// exact amount, opposite signs, within 4 days, each row used once, and
// never two rows from the same statement (same-source pairs are more
// likely a purchase+refund, which nets out anyway via categories).
// Computed at read time — the stored rows are never rewritten.
function pairInternalTransfers(txns) {
    const paired = new Set();
    const credits = txns.filter(t => t.amount > 0 && t.category !== 'savings_transfer' && Math.abs(t.amount) >= 5);
    const debits  = txns.filter(t => t.amount < 0 && t.category !== 'savings_transfer' && Math.abs(t.amount) >= 5);
    const usedCredits = new Set();
    for (const d of debits) {
        const dT = Date.parse(d.date || '');
        if (!Number.isFinite(dT)) continue;
        const match = credits.find(c => !usedCredits.has(c.id)
            && Math.abs(c.amount + d.amount) < 0.005
            && Number.isFinite(Date.parse(c.date || ''))
            && Math.abs(Date.parse(c.date) - dT) <= 4 * 86400000
            && !(d.source && c.source && d.source === c.source));
        if (match) { usedCredits.add(match.id); paired.add(d.id); paired.add(match.id); }
    }
    return paired;
}

function getSpendingGraphData(email) {
    repairTransactions(email);   // clean any pre-hardening poison before totals
    const all = getTransactions(email);
    // Data imported before the guard above contains rows where a balance or
    // reference number was stored as the amount (the £-trillions total on the
    // page). Until those rows are cleaned from the store, exclude impossible
    // amounts from every figure so what the user sees is real. Each one is
    // logged so the exact poison rows show up in the live log for cleanup.
    const txns = all.filter(t => {
        const ok = Number.isFinite(t.amount) && Math.abs(t.amount) <= MAX_TXN_AMOUNT;
        if (!ok) console.warn(`[finance] excluded impossible stored row from totals — ${t.date} ${t.amount} "${String(t.description || '').slice(0, 40)}"`);
        return ok;
    });

    const debits    = txns.filter(t => t.amount < 0); // outgoings only

    // Rows that are two halves of a move between the user's own accounts.
    // They render as "Own transfers" in the breakdown and stay out of the
    // headline totals — same treatment as savings_transfer.
    const pairedIds = pairInternalTransfers(txns);
    const viewCat = t => pairedIds.has(t.id) ? 'savings_transfer' : (t.category || 'other');

    // Graph 1: category breakdown
    const byCategory = {};
    for (const t of debits) {
        const cat = viewCat(t);
        byCategory[cat] = (byCategory[cat] || 0) + Math.abs(t.amount);
    }

    // Graph 2: bucket/person breakdown (only assigned transactions)
    const byBucket = {};
    for (const t of debits) {
        if (t.bucket) {
            byBucket[t.bucket] = (byBucket[t.bucket] || 0) + Math.abs(t.amount);
        }
    }

    // Subscription list: recurring transactions grouped by merchant
    const subMap = {};
    for (const t of debits.filter(t => t.recurring)) {
        const k = merchantKey(t.merchant || t.description);
        if (!subMap[k]) {
            subMap[k] = { merchant: t.merchant || t.description, category: t.category, amount: Math.abs(t.amount), count: 0, lastDate: '' };
        }
        subMap[k].count++;
        if ((t.date || '') > subMap[k].lastDate) subMap[k].lastDate = t.date;
    }
    const subscriptions = Object.values(subMap).sort((a, b) => b.amount - a.amount);

    // Self-transfers — savings_transfer rows AND detected cross-account
    // pairs — are the user's own money moving between their own places:
    // pots, savings, their other banks. Counting them made the headline
    // figures lies. Visible in the breakdown, excluded from the headline
    // totals, which must be TRUE.
    const isSelfMove  = t => viewCat(t) === 'savings_transfer';
    const totalSpend  = debits.filter(t => !isSelfMove(t)).reduce((s, t) => s + Math.abs(t.amount), 0);
    const totalIncome = txns.filter(t => t.amount > 0 && !isSelfMove(t)).reduce((s, t) => s + t.amount, 0);
    const selfTransfers = debits.filter(isSelfMove).reduce((s, t) => s + Math.abs(t.amount), 0);
    // The period the imported data actually covers — without it, 5 months of
    // statement history reads as "what I've spent lately" and looks wrong.
    const dates = txns.map(t => t.date).filter(Boolean).sort();

    return {
        by_category:    sortObj(byCategory),
        by_bucket:      sortObj(byBucket),
        subscriptions,
        summary: {
            total_spend:  Math.round(totalSpend  * 100) / 100,
            total_income: Math.round(totalIncome * 100) / 100,
            net:          Math.round((totalIncome - totalSpend) * 100) / 100,
            transaction_count: txns.length,
            // One figure for all own-money movement (pots, savings, and
            // between the user's own banks). moved_to_savings kept as an
            // alias for anything already reading it.
            self_transfers:    Math.round(selfTransfers * 100) / 100,
            moved_to_savings:  Math.round(selfTransfers * 100) / 100,
            period_from: dates[0] || null,
            period_to:   dates[dates.length - 1] || null,
        },
    };
}

function sortObj(obj) {
    const sorted = {};
    Object.entries(obj)
        .sort(([, a], [, b]) => b - a)
        .forEach(([k, v]) => { sorted[k] = Math.round(v * 100) / 100; });
    return sorted;
}


// ── Problem queue ─────────────────────────────────────────────────

// Resolved-but-recoverable. Resolve only sets status='resolved'; it never
// deletes. This returns the resolved set so the page can show them again
// and the user can un-resolve anything that got hidden by a misclick.
function getResolvedProblems(email) {
    return getProblems(email)
        .filter(p => p.status === 'resolved')
        .sort((a, b) => {
            const aT = Date.parse(a.resolvedAt || a.updatedAt || a.createdAt || 0);
            const bT = Date.parse(b.resolvedAt || b.updatedAt || b.createdAt || 0);
            return bT - aT;          // most recently resolved first
        });
}

function getProblemQueue(email) {
    return getProblems(email)
        .filter(p => p.status !== 'resolved')
        .sort((a, b) => {
            const urgencyOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
            return (urgencyOrder[a.urgency] || 3) - (urgencyOrder[b.urgency] || 3);
        });
}

function addProblem(email, problem) {
    const problems = getProblems(email);
    const entry = {
        id:       uid(),
        type:     problem.type     || 'other',
        title:    problem.title    || 'Unnamed problem',
        provider: problem.provider || null,
        amount:   problem.amount   || null,
        dueDate:  problem.dueDate  || null,
        urgency:  problem.urgency  || 'medium',
        status:   'open',
        notes:    problem.notes    || null,
        documents: [],
        addedAt:  new Date().toISOString(),
    };
    problems.push(entry);
    saveProblems(email, problems);
    return entry;
}

function updateProblem(email, id, updates) {
    const problems = getProblems(email);
    const idx = problems.findIndex(p => p.id === id);
    if (idx === -1) return null;
    problems[idx] = { ...problems[idx], ...updates, id };
    saveProblems(email, problems);
    return problems[idx];
}

function addDocumentToProblem(email, problemId, doc) {
    const problems = getProblems(email);
    const idx = problems.findIndex(p => p.id === problemId);
    if (idx === -1) return null;
    problems[idx].documents = problems[idx].documents || [];
    problems[idx].documents.push({ id: uid(), ...doc, addedAt: new Date().toISOString() });
    problems[idx].updatedAt = new Date().toISOString();
    saveProblems(email, problems);
    return problems[idx];
}


// ── Q advice (APS mode) ───────────────────────────────────────────

const ADVICE_SYSTEM = `You are Q, a personal finance advisor with sharp instincts and genuine care. You look at a person's real spending data and find things that are actually leaking money.

Be SPECIFIC — name real amounts, real merchants, real patterns you see in the data.
Be PRACTICAL — tell them exactly what to do (not vague advice).
Be HUMAN — you're not a spreadsheet. You notice when someone is struggling and you say so plainly.

Look for:
1. Subscriptions that look unused (paid every month, not matched against usage patterns)
2. Spending that looks like it could qualify for disability discounts, social tariffs, or benefit top-ups (Warm Home Discount, social broadband tariffs, council tax reductions, etc.)
3. The biggest single leaks (top 3 categories by spend)
4. Debts with the highest urgency (from the problem queue)
5. Any "forgot" patterns (irregular payments that suggest missed direct debits)

Format your response as clear sections with emoji headers. Be direct and friendly — not corporate.`;

async function getAdvice(email) {
    const graphData  = getSpendingGraphData(email);
    const problems   = getProblemQueue(email);
    const txns       = getTransactions(email);
    const assignments = getAssignments(email);

    const context = {
        spending_summary:    graphData.summary,
        top_categories:      Object.entries(graphData.by_category).slice(0, 12).map(([k, v]) => ({ category: k, total: v })),
        bucket_breakdown:    Object.entries(graphData.by_bucket).map(([k, v]) => ({ bucket: k, total: v })),
        subscriptions:       graphData.subscriptions,
        open_problems:       problems.slice(0, 10).map(p => ({ type: p.type, title: p.title, provider: p.provider, amount: p.amount, urgency: p.urgency })),
        total_transactions:  txns.length,
        merchant_labels:     Object.entries(assignments).slice(0, 20).map(([k, v]) => ({ key: k, label: v.label })),
    };

    return cleanModelOutput(await togetherChat({
        model:       Q_CONFIG.model,
        temperature: 0.3,
        max_tokens:  2000,
        messages: [
            { role: 'system', content: ADVICE_SYSTEM },
            { role: 'user',   content: `Here is my financial data:\n\n${JSON.stringify(context, null, 2)}\n\nGive me your honest assessment.` },
        ],
    })) || 'No advice generated.';
}


// ── Transaction update ────────────────────────────────────────────

function updateTransaction(email, txnId, updates) {
    const txns = getTransactions(email);
    const idx  = txns.findIndex(t => t.id === txnId);
    if (idx === -1) return null;
    // Only allow safe fields to be updated
    const allowed = ['category', 'bucket', 'flagged', 'merchant'];
    for (const k of allowed) {
        if (k in updates) txns[idx][k] = updates[k];
    }
    saveTransactions(email, txns);
    return txns[idx];
}

function deleteTransactions(email) {
    saveTransactions(email, []);
    saveAssignments(email, {});
}


// ── Detect subscriptions ──────────────────────────────────────────

function detectSubscriptions(email) {
    const txns = getTransactions(email);
    // A row belongs here if the labeller flagged it recurring OR categorised
    // it 'subscriptions'. Requiring the recurring flag alone hid rows the
    // user could SEE labelled subscriptions in their list — the box looked
    // blind to its own category.
    const debits = txns.filter(t => t.amount < 0 && (t.recurring || t.category === 'subscriptions'));
    const byMerchant = {};
    for (const t of debits) {
        const k = merchantKey(t.merchant || t.description);
        if (!byMerchant[k]) byMerchant[k] = [];
        byMerchant[k].push(t);
    }
    return Object.entries(byMerchant)
        .filter(([, entries]) => entries.length >= 2 || entries[0].category === 'subscriptions')
        .map(([, entries]) => {
            entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            return {
                merchant:    entries[0].merchant || entries[0].description,
                amount:      Math.abs(entries[0].amount),
                category:    entries[0].category,
                bucket:      entries[0].bucket,
                last_seen:   entries[0].date,
                source:      entries[0].source || null,   // which statement it leaves from
                count:       entries.length,
                total_paid:  Math.round(entries.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
            };
        })
        .sort((a, b) => b.amount - a.amount);
}


// Income sources — credits grouped the way subscriptions are, with
// self-transfers (pots, savings, cross-account pairs) excluded so a top-up
// from the user's own other bank never masquerades as income.
function detectIncome(email) {
    const txns = getTransactions(email);
    const paired = pairInternalTransfers(txns);
    const credits = txns.filter(t => t.amount > 0 && t.category !== 'savings_transfer' && !paired.has(t.id));
    const byMerchant = {};
    for (const t of credits) {
        const k = merchantKey(t.merchant || t.description);
        (byMerchant[k] = byMerchant[k] || []).push(t);
    }
    return Object.values(byMerchant)
        // Income means income — not every credit. Friends paying back a
        // meal, refunds, one-off fivers: those stay in Transactions.
        // A payer shows here when labelled income, when a one-off is
        // meaningful (£150+, e.g. a first UC payment), or when repeat
        // payments add up to something real (£100+). A credit the user
        // labelled as anything else (dining, shopping…) never shows —
        // that's the direct way to evict a mate's repayments.
        .filter(entries => {
            if (entries.some(t => t.category === 'income')) return true;
            if (entries.every(t => t.category && t.category !== 'other' && t.category !== 'income')) return false;
            const total = entries.reduce((s, t) => s + t.amount, 0);
            if (total >= 150) return true;
            return entries.length >= 2 && total >= 100;
        })
        .map(entries => {
            entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            return {
                merchant:       entries[0].merchant || entries[0].description,
                amount:         Math.abs(entries[0].amount),
                last_seen:      entries[0].date,
                source:         entries[0].source || null,
                count:          entries.length,
                total_received: Math.round(entries.reduce((s, t) => s + t.amount, 0) * 100) / 100,
            };
        })
        .sort((a, b) => b.total_received - a.total_received);
}

// The money rhythm — what comes in and goes out weekly / monthly, plus
// bills that repeat without a clean cadence. Deterministic: cadence from
// the median gap between a merchant's transactions. Self-transfers are
// excluded on both sides. Frequent shop visits (median gap under 5 days —
// Tesco three times a week) are noise, not a rhythm, and are skipped
// unless they're a bills-type category.
const BILL_CATEGORIES = new Set(['utilities', 'subscriptions', 'housing', 'fees_charges']);
function detectRegulars(email) {
    const txns = getTransactions(email);
    const paired = pairInternalTransfers(txns);
    const live = txns.filter(t => t.category !== 'savings_transfer' && !paired.has(t.id) && t.date);
    const groups = {};
    for (const t of live) {
        const k = (t.amount < 0 ? 'out:' : 'in:') + merchantKey(t.merchant || t.description);
        (groups[k] = groups[k] || []).push(t);
    }
    const rhythm = { in: { weekly: [], monthly: [], bills: [] }, out: { weekly: [], monthly: [], bills: [] } };
    for (const [k, entries] of Object.entries(groups)) {
        if (entries.length < 2) continue;
        entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const gaps = [];
        for (let i = 1; i < entries.length; i++) {
            const g = (Date.parse(entries[i].date) - Date.parse(entries[i - 1].date)) / 86400000;
            if (Number.isFinite(g) && g >= 0) gaps.push(g);
        }
        gaps.sort((a, b) => a - b);
        const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
        const dir = k.startsWith('in:') ? 'in' : 'out';
        const latest = entries[entries.length - 1];
        const amount = Math.abs(latest.amount);
        let target = null, cadence = null, monthlyEquiv = null;
        if (median != null && median >= 5 && median <= 10)       { target = 'weekly';  cadence = 'weekly';      monthlyEquiv = amount * 4.33; }
        else if (median != null && median >= 11 && median <= 18) { target = 'weekly';  cadence = 'fortnightly'; monthlyEquiv = amount * 2.17; }
        else if (median != null && median >= 24 && median <= 38) { target = 'monthly'; cadence = 'monthly';     monthlyEquiv = amount; }
        else if (BILL_CATEGORIES.has(latest.category))           { target = 'bills';   cadence = 'irregular'; }
        if (!target) continue;
        rhythm[dir][target].push({
            merchant:      latest.merchant || latest.description,
            amount:        Math.round(amount * 100) / 100,
            cadence,
            monthly_equiv: monthlyEquiv != null ? Math.round(monthlyEquiv * 100) / 100 : null,
            count:         entries.length,
            last_seen:     latest.date,
            source:        latest.source || null,
            category:      latest.category || 'other',
            total:         Math.round(entries.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
        });
    }
    for (const dir of ['in', 'out']) {
        for (const g of ['weekly', 'monthly', 'bills']) {
            rhythm[dir][g].sort((a, b) => (b.monthly_equiv || b.total) - (a.monthly_equiv || a.total));
        }
    }
    return rhythm;
}

module.exports = {
    // Transactions
    importStatement,
    getTransactions,
    saveTransactions,
    updateTransaction,
    deleteTransactions,
    categoriseTransactions,
    recategoriseOther,
    parseCsvStatement,

    // Documents / vision
    extractDocument,
    extractVideo,
    scanFormFields,
    verifyCaseReply,
    importStatementFromImage,
    importStatementFromFile,
    startImportJob,
    getImportJob,

    // Assignments
    assignMerchant,
    getAssignments,

    // Subscriptions + income + rhythm
    detectSubscriptions,
    detectIncome,
    detectRegulars,

    // Graphs
    getSpendingGraphData,

    // Problem queue
    getProblemQueue,
    getResolvedProblems,
    addProblem,
    updateProblem,
    addDocumentToProblem,

    // Advice
    getAdvice,
};
