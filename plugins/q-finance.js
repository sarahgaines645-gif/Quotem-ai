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
const { logUsage }       = require('../cost-tracker');

// Call Together AI via plain fetch — same pattern as q-email-writer.js
// Pass extra = { response_format, ... } for JSON mode etc.
async function togetherChat({ model, messages, temperature = 0, max_tokens = 4000, ...extra }) {
    // Hard 90s timeout. Without this, a hung Together AI connection makes the
    // whole request hang forever and the UI sits on "reading…" indefinitely.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    const started = Date.now();
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
        logUsage({ skill: 'finance', provider: 'together', model, started, success: false, error: `HTTP ${res.status}` });
        throw new Error(`Together AI ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = await res.json();
    logUsage({ skill: 'finance', provider: 'together', model, data: json, started });
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
    const started = Date.now();
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
    if (!res.ok) {
        logUsage({ skill: 'finance', provider: 'gemini', model: 'gemini-2.5-flash', started, success: false, error: `HTTP ${res.status}` });
        throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    logUsage({ skill: 'finance', provider: 'gemini', model: 'gemini-2.5-flash', data: json, started });
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
    const started = Date.now();
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
    if (!res.ok) {
        logUsage({ skill: 'finance', provider: 'gemini', model: 'gemini-2.5-flash', started, success: false, error: `HTTP ${res.status}` });
        throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    logUsage({ skill: 'finance', provider: 'gemini', model: 'gemini-2.5-flash', data: json, started });
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
  income           — wages, HMRC credits, benefits, child maintenance. NOT refunds. NOT one-off payments from private individuals (a friend paying money over once = other)
  fees_charges     — bank charges, overdraft fees, late fees
  other            — anything that doesn't fit above

A refund, reversal or dispute credit is NEVER income — give it the category of what it refunds (an Adobe refund → subscriptions, a Tesco refund → food_groceries).

Read the NATURE of a payment, not just the name:
- a small one-off to a council (£1–£10) is parking → transport; a large monthly one to a council is council tax → housing
- streaming, software, apps, gyms, insurance, phone plans are subscriptions from their FIRST payment — don't wait for repeats
- recurring = true whenever the payment is the kind that repeats (subscriptions, utilities, rent), even if you only see it once

Self-transfers matter: money moved between the person's own accounts or pots is savings_transfer in BOTH directions (out AND back in) — it is never income and never real spending. People often upload statements from SEVERAL of their own banks: a top-up arriving from the person's own name, "MONEY", or another of their banks is savings_transfer, not income.

Credit cards: a payment RECEIVED onto a credit card ("PAYMENT RECEIVED — THANK YOU", "DIRECT DEBIT PAYMENT", a payment from the person's own bank) is savings_transfer, never income — it is the person paying their own card. A purchase on the card is categorised by what was bought, exactly like a debit card.

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


// ── Account recognition ───────────────────────────────────────────
// A filename is not an account. "halifax aug.csv" told the app nothing —
// it could not say which bank a charge left, and cross-bank pairing had
// only a string to compare. Recognising the ACCOUNT from the statement's
// own evidence is what makes every figure on the page attributable, and
// it is the hook the benefits engine hangs on (a Club Lloyds fee line is
// how the app learns she has a Club Lloyds account).

// UK banks by the names that actually appear in statement headers, CSV
// preambles and export filenames. Longest/most specific first — "lloyds"
// must not swallow "club lloyds", and "halifax" must be tested before the
// Lloyds Banking Group boilerplate that appears in Halifax footers.
const BANK_FINGERPRINTS = [
    { slug: 'monzo',       name: 'Monzo',            re: /\bmonzo\b/i },
    { slug: 'starling',    name: 'Starling Bank',    re: /\bstarling\b/i },
    { slug: 'halifax',     name: 'Halifax',          re: /\bhalifax\b/i },
    { slug: 'bankofscot',  name: 'Bank of Scotland', re: /\bbank of scotland\b/i },
    { slug: 'lloyds',      name: 'Lloyds Bank',      re: /\blloyds\b/i },
    { slug: 'barclaycard', name: 'Barclaycard',      re: /\bbarclaycard\b/i },
    { slug: 'barclays',    name: 'Barclays',         re: /\bbarclays\b/i },
    { slug: 'firstdirect', name: 'first direct',     re: /\bfirst\s?direct\b/i },
    { slug: 'hsbc',        name: 'HSBC',             re: /\bhsbc\b/i },
    { slug: 'natwest',     name: 'NatWest',          re: /\bnatwest|national westminster\b/i },
    { slug: 'rbs',         name: 'Royal Bank of Scotland', re: /\broyal bank of scotland\b/i },
    { slug: 'santander',   name: 'Santander',        re: /\bsantander\b/i },
    { slug: 'nationwide',  name: 'Nationwide',       re: /\bnationwide\b/i },
    { slug: 'tsb',         name: 'TSB',              re: /\btsb\b/i },
    { slug: 'coop',        name: 'The Co-operative Bank', re: /\bco-?operative bank|\bco-?op bank\b/i },
    { slug: 'metro',       name: 'Metro Bank',       re: /\bmetro bank\b/i },
    { slug: 'virgin',      name: 'Virgin Money',     re: /\bvirgin money\b/i },
    { slug: 'revolut',     name: 'Revolut',          re: /\brevolut\b/i },
    { slug: 'chase',       name: 'Chase',            re: /\bchase\b/i },
    { slug: 'monument',    name: 'Monument',         re: /\bmonument bank\b/i },
    { slug: 'kroo',        name: 'Kroo',             re: /\bkroo\b/i },
    { slug: 'zopa',        name: 'Zopa',             re: /\bzopa\b/i },
    { slug: 'marcus',      name: 'Marcus',           re: /\bmarcus by goldman\b/i },
    { slug: 'tide',        name: 'Tide',             re: /\btide (?:business|platform|bank)\b/i },
    { slug: 'mettle',      name: 'Mettle',           re: /\bmettle\b/i },
    { slug: 'wise',        name: 'Wise',             re: /\bwise (?:account|business|payments)\b|\btransferwise\b/i },
    // Business and challenger banks. Sarah runs business accounts alongside
    // her personal ones; a business account that goes unrecognised is money
    // sitting outside the picture entirely.
    { slug: 'anna',        name: 'ANNA Money',       re: /\banna money\b|\banna business\b/i },
    { slug: 'countingup',  name: 'Countingup',       re: /\bcountingup\b/i },
    { slug: 'cashplus',    name: 'Cashplus',         re: /\bcashplus\b/i },
    { slug: 'zempler',     name: 'Zempler Bank',     re: /\bzempler\b/i },
    { slug: 'allica',      name: 'Allica Bank',      re: /\ballica\b/i },
    { slug: 'oaknorth',    name: 'OakNorth',         re: /\boaknorth\b/i },
    { slug: 'shawbrook',   name: 'Shawbrook',        re: /\bshawbrook\b/i },
    { slug: 'aldermore',   name: 'Aldermore',        re: /\baldermore\b/i },
    { slug: 'unitytrust',  name: 'Unity Trust Bank', re: /\bunity trust\b/i },
    { slug: 'handelsbank', name: 'Handelsbanken',    re: /\bhandelsbanken\b/i },
    { slug: 'cynergy',     name: 'Cynergy Bank',     re: /\bcynergy\b/i },
    { slug: 'triodos',     name: 'Triodos',          re: /\btriodos\b/i },
    { slug: 'recognise',   name: 'Recognise Bank',   re: /\brecognise bank\b/i },
    { slug: 'gbbank',      name: 'GB Bank',          re: /\bgb bank\b/i },
    { slug: 'atom',        name: 'Atom Bank',        re: /\batom bank\b/i },
    { slug: 'paypal',      name: 'PayPal',           re: /\bpaypal\b/i },
    { slug: 'amex',        name: 'American Express', re: /\bamerican express\b|\bamex\b/i },
    { slug: 'capitalone',  name: 'Capital One',      re: /\bcapital one\b/i },
    { slug: 'vanquis',     name: 'Vanquis',          re: /\bvanquis\b/i },
    { slug: 'mbna',        name: 'MBNA',             re: /\bmbna\b/i },
    { slug: 'tescobank',   name: 'Tesco Bank',       re: /\btesco bank\b/i },
    { slug: 'sainsburys',  name: "Sainsbury's Bank", re: /\bsainsbury'?s bank\b/i },
    { slug: 'postoffice',  name: 'Post Office Money', re: /\bpost office money\b/i },
    // Card-only issuers. Their name in a bank debit's description IS the
    // evidence that the debit is a card payment (see CARD_ONLY_ISSUERS).
    { slug: 'newday',      name: 'NewDay',           re: /\bnewday\b|\baqua card\b|\bmarbles card\b|\bfluid card\b/i },
    { slug: 'jaja',        name: 'Jaja',             re: /\bjaja\b/i },
    { slug: 'zable',       name: 'Zable',            re: /\bzable\b/i },
    { slug: 'johnlewis',   name: 'John Lewis Money', re: /\bjohn lewis (?:money|finance|partnership card)\b/i },
];

// Named account products. Recognising the PRODUCT — not just the bank — is
// what lets the app say "your Club Lloyds account includes Disney+". Kept
// deliberately small and exact: a guess here would put a false entitlement
// in front of someone, which is worse than saying nothing.
const ACCOUNT_PRODUCTS = [
    { bank: 'lloyds',     product: 'Club Lloyds',              re: /\bclub lloyds\b/i },
    { bank: 'halifax',    product: 'Ultimate Reward',          re: /\bultimate reward\b/i },
    { bank: 'halifax',    product: 'Reward Current Account',   re: /\breward current account\b/i },
    { bank: 'nationwide', product: 'FlexPlus',                 re: /\bflexplus\b/i },
    { bank: 'nationwide', product: 'FlexDirect',               re: /\bflexdirect\b/i },
    { bank: 'nationwide', product: 'FlexAccount',              re: /\bflexaccount\b/i },
    { bank: 'santander',  product: 'Edge Explorer',            re: /\bedge explorer\b/i },
    { bank: 'santander',  product: 'Edge Up',                  re: /\bedge up\b/i },
    { bank: 'santander',  product: 'Edge',                     re: /\bsantander edge\b/i },
    { bank: 'natwest',    product: 'Reward',                   re: /\bnatwest reward\b/i },
    { bank: 'barclays',   product: 'Blue Rewards',             re: /\bblue rewards\b/i },
    { bank: 'coop',       product: 'Everyday Extra',           re: /\beveryday extra\b/i },
];

// An account type changes what the figures MEAN — a credit card's "credit"
// is a repayment, not income. Detected from the header, never assumed.
function detectAccountType(text) {
    if (/\bcredit card\b|\bcard statement\b|\bminimum payment\b|\bcredit limit\b/i.test(text)) return 'credit_card';
    if (/\bsavings account\b|\bisa\b|\beasy access\b|\bfixed rate saver\b/i.test(text))        return 'savings';
    if (/\bbusiness (?:current )?account\b/i.test(text))                                      return 'business';
    return 'current';
}

// The last 4 of the account number, when the statement shows one. Sort code
// is deliberately NOT stored — it identifies a branch, adds nothing the user
// can read, and is one more sensitive number sitting on disk for no gain.
function detectLast4(text) {
    // A printed account number, in full — take its last four and keep only
    // those. "Account number: 12345678" → 5678.
    let m = text.match(/account\s*(?:number|no\.?|#)?\s*[:\-]?\s*(\d{6,10})\b/i);
    if (m) return m[1].slice(-4);
    // Already masked by the bank: "Account ending ****4417", "•••• 5678".
    m = text.match(/account\s*(?:number|no\.?|#|ending)?\s*[:\-]?\s*(?:\*|x|•|·|\s){2,12}(\d{4})\b(?!\d)/i);
    if (m) return m[1];
    m = text.match(/(?:\*{2,}|x{2,}|•{2,}|·{2,})\s*(\d{4})\b(?!\d)/i);
    if (m) return m[1];
    // A bare 8-digit account number sitting next to a sort code.
    m = text.match(/\b\d{2}[-\s]\d{2}[-\s]\d{2}\b[^\d]{0,30}\b\d{4}(\d{4})\b/);
    if (m) return m[1];
    return null;
}

// ── Credit cards ──────────────────────────────────────────────────
// A credit card is where the SAME POUND is most easily counted twice: the
// purchase is spending on the card statement, and the payment that clears it
// is a debit on the bank statement. Loaded together, both count. The rule
// mirrors the transfer rule — paying a card you hold is moving your own money
// to cover spending that is already recorded — and every piece of it below is
// keyed off the accounts the user has actually loaded, never a guessed list.

// A payment landing ON a card, in the card's own words.
const CARD_PAYMENT_RECEIVED_RE = /\bpayment\s*(?:received|recvd|-\s*thank\s*you|thank\s*you)|\bthank\s*you\b[^a-z]{0,6}\bpayment|\bdirect\s*debit\s*(?:payment|received|collected)|\bpayment\s+by\s+(?:direct\s+debit|faster\s+payment|bank\s+transfer)|\bdd\s+payment\b|\bpayment\s+in\b/i;

// Issuers who only do cards — their name alone in a bank debit says "card
// payment". Every other bank on the list also runs current and savings
// accounts, so for those the description must ALSO say it is a card ("LLOYDS
// BANK CARD", "HALIFAX CREDIT CARD DD"), or a £5 "CLUB LLOYDS" fee, or a move
// to a Lloyds savings pot, would be filed as a card payment.
const CARD_ONLY_ISSUERS = new Set(['barclaycard', 'amex', 'capitalone', 'vanquis', 'mbna', 'newday', 'jaja', 'zable', 'johnlewis']);
const CARD_WORD_RE = /\b(?:credit\s*card|card|c\/card|cc|visa|mastercard|m\/card)\b/i;

function isCardPaymentReceived(t) {
    return t.amount > 0 && CARD_PAYMENT_RECEIVED_RE.test(String(t.merchant || t.description || ''));
}

// Card statements print purchases as plain figures and payments as "CR" —
// the opposite of a bank statement — so a reader that copies what is printed
// files every purchase as INCOME. The prompt says which way round; this is
// the check that the read obeyed it, from the statement's OWN evidence, in
// order of strength: (1) the payment lines — money arriving on a card can only
// be positive; (2) the printed opening/closing balances, which only add up one
// way round. No evidence → left alone and said so in the log, never guessed.
// Also stamps a payment received onto the card as savings_transfer — ground
// truth from the statement, so it is never sent to the categoriser as a
// candidate for "income".
function normaliseCardRows(rows, acct, bal) {
    if (!acct || acct.type !== 'credit_card' || !rows.length) return { rows, flipped: false, evidence: null };
    const desc = r => String(r.merchant || r.description || '');
    let flip = null, evidence = null;
    const payLines = rows.filter(r => CARD_PAYMENT_RECEIVED_RE.test(desc(r)) && Number.isFinite(r.amount) && r.amount !== 0);
    if (payLines.length) {
        const neg = payLines.filter(r => r.amount < 0).length;
        const pos = payLines.length - neg;
        if (neg !== pos) { flip = neg > pos; evidence = `payment lines ${flip ? 'negative' : 'positive'} (${payLines.length})`; }
    }
    if (flip === null && bal && bal.opening != null && bal.closing != null) {
        const read     = Math.round(rows.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;
        const expected = Math.round((bal.closing - bal.opening) * 100) / 100;
        if (Math.abs(read - expected) < 0.005)       { flip = false; evidence = 'balance arithmetic'; }
        else if (Math.abs(-read - expected) < 0.005) { flip = true;  evidence = 'balance arithmetic'; }
    }
    if (flip === null) console.log(`[finance] credit card "${acct.label}" — no payment line and no usable balances, so the sign convention could not be checked; rows kept as read`);
    else if (flip) console.log(`[finance] credit card "${acct.label}" — read with the card's own signs (evidence: ${evidence}); flipped ${rows.length} rows so purchases are money out`);
    let out = flip ? rows.map(r => ({ ...r, amount: -r.amount })) : rows;
    out = out.map(r => (!r.category && isCardPaymentReceived(r)) ? { ...r, category: 'savings_transfer' } : r);
    return { rows: out, flipped: !!flip, evidence };
}

// A card's printed balance is what is OWED, so in this app it is negative
// (law: never net what she has against what she owes — a card debt sits with
// the overdrafts, never in "You have"). Only an explicit "CR" makes it money
// in her favour. Applied to the statement's #BALANCE figures before they are
// used for reconciliation or stored on the account.
function normaliseCardBalance(bal, acct) {
    if (!bal || !acct || acct.type !== 'credit_card') return bal;
    const owed = (v, cr) => (v == null) ? null : (cr ? Math.abs(v) : -Math.abs(v));
    return { ...bal, opening: owed(bal.opening, bal.openingCr), closing: owed(bal.closing, bal.closingCr) };
}

// Bank debits that are payments to a card the user holds, plus payments
// received on the card itself. Read-time, like transfer pairing — the stored
// rows are never rewritten. Two conditions, both from her own data:
//   1. the card is a loaded account (type credit_card), and the debit names
//      its issuer (a card-only issuer by name; any other bank only with a
//      card word alongside);
//   2. the card's own rows COVER that date (± a week). A card statement for
//      June must not turn every card payment from March into "not spending" —
//      for months the card is not loaded, the payment is still the truest
//      figure the app has for what was spent on it.
function cardPaymentIds(txns, accounts) {
    const out = new Set();
    const cards = (accounts || []).filter(a => a && a.type === 'credit_card');
    if (!cards.length) return out;
    const cardIds = new Set(cards.map(c => c.id));
    const WEEK = 7 * 86400000;
    const cover = new Map();
    for (const c of cards) {
        const ts = txns.filter(t => t.account === c.id).map(t => Date.parse(t.date || '')).filter(Number.isFinite);
        if (ts.length) cover.set(c.id, [Math.min(...ts) - WEEK, Math.max(...ts) + WEEK]);
    }
    const desc = t => String(t.merchant || t.description || '');
    for (const t of txns) {
        if (cardIds.has(t.account)) {
            if (isCardPaymentReceived(t)) out.add(t.id);
            continue;
        }
        if (!(t.amount < 0)) continue;
        const dT = Date.parse(t.date || '');
        if (!Number.isFinite(dT)) continue;
        const d = desc(t);
        for (const c of cards) {
            const win = cover.get(c.id);
            if (!win || dT < win[0] || dT > win[1]) continue;
            const fp = BANK_FINGERPRINTS.find(b => b.slug === c.bankSlug);
            if (!fp || !fp.re.test(d)) continue;
            if (!CARD_ONLY_ISSUERS.has(c.bankSlug) && !CARD_WORD_RE.test(d)) continue;
            out.add(t.id);
            break;
        }
    }
    return out;
}

/**
 * Recognise the account a statement belongs to, from the statement's own
 * evidence plus the filename. Returns null when there is no real evidence —
 * an invented account is worse than none, because every later figure would
 * be attributed to a bank the user does not bank with.
 *
 * @returns {{id,bank,bankSlug,product,type,last4,label}|null}
 */
function detectAccount(rawText, filename) {
    // Preamble ONLY — the text above the transactions. A CSV export's first
    // lines ARE transactions, so scanning them would match a bank's name in a
    // payee ("TFR TO BARCLAYS") and file the whole export under the wrong
    // bank. Cut at the column-header row when there is one; a Monzo-style CSV
    // whose header is line 1 therefore contributes nothing but its filename,
    // which is the honest outcome.
    const lines = String(rawText || '').split(/\r?\n/);
    let cut = Math.min(lines.length, 40);
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
        const c = splitCsvLine(lines[i]).map(h => h.toLowerCase());
        if (c.some(h => /date/.test(h))
            && c.some(h => /amount|debit|credit|paid\s*(in|out)|money\s*(in|out)|withdrawn|deposit|value/.test(h))) {
            cut = i;
            break;
        }
    }
    const head = lines.slice(0, cut).join('\n');
    const hay  = `${head}\n${String(filename || '').replace(/[_\-()]+/g, ' ')}`;

    const bank = BANK_FINGERPRINTS.find(b => b.re.test(hay));
    if (!bank) return null;

    const product = (ACCOUNT_PRODUCTS.find(p => p.bank === bank.slug && p.re.test(hay)) || {}).product || null;
    const last4   = detectLast4(head);
    const type    = detectAccountType(hay);

    // Stable id: the same bank+last4 re-uploaded next month lands on the same
    // account rather than creating a second one. Without a last4 the bank's
    // primary account is assumed — re-uploads still merge, which is the
    // behaviour that matters.
    const id = `${bank.slug}${last4 ? '-' + last4 : ''}`;

    return {
        id,
        bank:     bank.name,
        bankSlug: bank.slug,
        product,
        type,
        last4,
        label:    `${bank.name}${product ? ' ' + product : ''}${last4 ? ' ····' + last4 : ''}`,
    };
}

const ACCOUNTS_FILE = 'accounts.json';

function getAccounts(email) {
    return loadJSON(finPath(email, ACCOUNTS_FILE), []);
}

function saveAccounts(email, accounts) {
    saveJSON(finPath(email, ACCOUNTS_FILE), accounts);
}

// Record (or refresh) an account at import. Never overwrites a field the app
// already knows with a null — a scanned PDF that yields no last4 must not
// wipe the last4 a CSV import established.
function upsertAccount(email, acct, source) {
    if (!acct || !acct.id) return null;
    const all = getAccounts(email);
    // Match on the id first. Failing that, match an existing record for the
    // SAME BANK — because the two records are the same account seen with
    // different amounts of detail: one import knew the last 4, another (a
    // filename, or an account she added by hand) did not. Creating a second
    // card would split her money across two halves of one account. The
    // EXISTING id always wins so the rows already stamped with it stay
    // attached; the new detail is merged into it.
    let idx = all.findIndex(a => a.id === acct.id);
    if (idx === -1) {
        // Same bank AND same type. Sarah holds personal and business accounts
        // at the same banks, so a business account must never be merged into
        // a personal one just because the brand matches — that would hide a
        // whole account's money inside another.
        const sameBank = all.filter(a => a.bankSlug === acct.bankSlug
            && (a.type === acct.type || !a.type || !acct.type));
        // Only when it is unambiguous: one candidate, and one of the two is
        // missing its last 4. Two known-different last 4s are two real
        // accounts and must stay apart.
        if (sameBank.length === 1 && (!sameBank[0].last4 || !acct.last4)) {
            idx = all.indexOf(sameBank[0]);
        }
    }
    const now = new Date().toISOString();
    if (idx === -1) {
        const entry = { ...acct, sources: source ? [source] : [], firstSeen: now, lastSeen: now };
        all.push(entry);
        saveAccounts(email, all);
        console.log(`[finance] new account recognised — ${entry.label}`);
        return entry;
    }
    const cur = all[idx];
    const next = {
        ...cur,
        bank:     acct.bank    || cur.bank,
        product:  acct.product || cur.product,
        last4:    acct.last4   || cur.last4,
        type:     acct.type    || cur.type,
        label:    acct.product || !cur.product ? acct.label : cur.label,
        lastSeen: now,
        sources:  [...new Set([...(cur.sources || []), ...(source ? [source] : [])])].slice(0, 40),
    };
    all[idx] = next;
    saveAccounts(email, all);
    return next;
}

// ── Balances from a screenshot ────────────────────────────────────────
// Typing a balance per account is a chore, and a chore is the thing that
// doesn't get done. A screenshot of the banking app's home screen already
// shows every account and what's in it — so read that instead.
const BALANCE_SCREENSHOT_PROMPT = `You are looking at a screenshot from someone's mobile banking app or online banking. Read the ACCOUNTS and their BALANCES.

Return STRICT JSON only, no markdown fences:
{ "accounts": [ { "bank": "...", "product": "...", "last4": "...", "balance": 0.00 } ] }

Rules:
- bank: the bank or building society brand shown (e.g. "Monzo", "NatWest", "Lloyds Bank", "Halifax"). If the brand is not visible anywhere on the screen, use null — do NOT infer it from the colours or the style of the app.
- product: the account's name as printed ("Club Lloyds", "Current Account", "Ultimate Reward", "Everyday Saver") or null.
- last4: the last four digits of the account number if shown, else null.
- balance: the CURRENT balance as a plain number. Money the person HAS is positive; an overdrawn or owed balance is NEGATIVE. A credit card balance the person owes is NEGATIVE.
- Include every account visible on the screen, including savings accounts and pots. One object each.
- Never guess a figure that is cut off, blurred, or hidden behind a "show balance" toggle — omit that account entirely instead.
- If you cannot read any account at all, return { "accounts": [] }.`;

/**
 * Read balances from a screenshot of a banking app.
 * The vision reader's answer is never trusted on its own: the bank it claims
 * is put back through the same fingerprints a statement goes through, so a
 * misread or invented brand cannot create an account that isn't hers.
 * @returns {{updated: Array, skipped: number}}
 */
async function importBalancesFromScreenshot(email, imageBase64, mimeType) {
    const raw = await visionRead({
        prompt:    BALANCE_SCREENSHOT_PROMPT,
        base64:    imageBase64,
        mimeType:  mimeType || 'image/jpeg',
        maxTokens: 2048,
    });
    if (!raw || !raw.trim()) return { updated: [], skipped: 0, error: 'Could not read that screenshot.' };

    let parsed;
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : null;
    } catch { parsed = null; }
    const list = Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [];
    if (!list.length) return { updated: [], skipped: 0, error: 'No account balances were readable on that screenshot.' };

    const updated = [];
    let skipped = 0;
    for (const row of list) {
        const bal = Number(row && row.balance);
        // A balance we cannot read is not a balance. Skip rather than store 0,
        // which would silently claim the account is empty.
        if (!Number.isFinite(bal)) { skipped++; continue; }
        // Gate the claimed bank through the real fingerprints.
        const acct = detectAccount(
            [row.bank, row.product, row.last4 ? `account number ${row.last4}` : ''].filter(Boolean).join('\n'),
            null,
        );
        if (!acct) { skipped++; continue; }
        const saved = upsertAccount(email, acct, 'screenshot');
        if (!saved) { skipped++; continue; }
        const withBal = setAccountBalance(email, saved.id, bal);
        if (withBal) updated.push(withBal); else skipped++;
    }
    console.log(`[finance] balance screenshot — ${updated.length} account(s) updated, ${skipped} skipped`);
    return { updated, skipped };
}

// Record the balance the user can see in their banking app. The statements
// themselves carry no balance (Monzo's CSV export has 18 columns and not one
// of them is a balance), so this single number is what turns a list of
// movements into "what have I actually got" — and it doubles as the only
// real audit of whether an import was complete.
function setAccountBalance(email, id, balance, asAt) {
    const all = getAccounts(email);
    const idx = all.findIndex(a => a.id === id);
    if (idx === -1) return null;
    const n = Number(balance);
    if (!Number.isFinite(n) || Math.abs(n) > MAX_TXN_AMOUNT) return null;
    all[idx] = {
        ...all[idx],
        balance:   Math.round(n * 100) / 100,
        balanceAt: asAt || new Date().toISOString().slice(0, 10),
    };
    saveAccounts(email, all);
    return all[idx];
}

// Accounts with their live figures, for the page's account cards. Computed
// from the rows themselves — nothing is stored that could drift out of step
// with the transactions.
//
// ⚠️ These figures obey the SAME rule as the headline totals: money the user
// moved between their own pots and their own banks is NOT spending and NOT
// income. A first version summed every debit and every credit, and a Monzo
// account full of pot transfers read as £23.9k out / £26k in — gross flow,
// which Sarah recognised instantly as not her life. Self-moves are shown as
// their own figure instead of being hidden or double-counted.
function getAccountsWithTotals(email) {
    const accounts = getAccounts(email);
    if (!accounts.length) return [];
    const txns = getTransactions(email);
    // Pairing is cross-account by definition, so it must be computed over the
    // whole set, not per account.
    const paired = pairInternalTransfers(txns, getAccounts(email));
    const isSelfMove = t => t.category === 'savings_transfer' || paired.has(t.id);
    return accounts.map(a => {
        const rows  = txns.filter(t => t.account === a.id);
        const dates = rows.map(t => t.date).filter(Boolean).sort();
        const real  = rows.filter(t => !isSelfMove(t));
        const moves = rows.filter(isSelfMove);
        // Net movement is EVERY row, self-moves included — a pot transfer
        // doesn't count as spending but it absolutely moves the balance.
        // This is the one figure that must not exclude anything.
        const netMovement = Math.round(rows.reduce((s, t) => s + t.amount, 0) * 100) / 100;
        // Given a balance the user has told us, what must the balance have
        // been at the start of the imported period? If that number is wrong
        // to her, transactions are missing — this is the completeness test.
        const impliedOpening = (a.balance != null)
            ? Math.round((a.balance - netMovement) * 100) / 100
            : null;
        return {
            ...a,
            net_movement:    netMovement,
            implied_opening: impliedOpening,
            transaction_count: rows.length,
            money_out: Math.round(real.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
            money_in:  Math.round(real.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
            // Own money in and out of pots / her other banks — real, but never
            // spending. Shown so the card adds up rather than seeming to lose money.
            self_transfers_out: Math.round(moves.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
            self_transfers_in:  Math.round(moves.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
            period_from: dates[0] || null,
            period_to:   dates[dates.length - 1] || null,
        };
    }).sort((a, b) => b.transaction_count - a.transaction_count);
}

async function importStatement(email, rawText, opts = {}) {
    const source = deriveSource(opts.filename, rawText);
    // Recognise the account before anything is saved, so every row this
    // import produces carries which account it belongs to.
    const acct = detectAccount(rawText, opts.filename);
    if (acct) upsertAccount(email, acct, source);
    const stamp = r => ({ ...r, source, ...(acct && { account: acct.id }) });

    const csvRows = parseCsvStatement(rawText);
    if (csvRows && csvRows.length) {
        console.log(`[finance] importStatement: ${csvRows.length} rows via deterministic CSV parser (no AI) — source "${source}"${acct ? `, account "${acct.label}"` : ', account not recognised'}`);
        return saveRows(email, csvRows.map(stamp), opts);
    }
    const parsed = await parseStatementText(rawText);
    return saveRows(email, parsed.map(stamp), opts);
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

// True when a merchant name is the account holder themselves — "S Gaines",
// "GAINES SL", "Sarah Gaines" for a person named Sarah Gaines — so their
// transfers between their own banks are recognised BY THE APP, for every
// user, with no one hand-labelling anything. Deliberately tight: surname
// alone or a different initial (a relative) never matches.
function isOwnName(name, ownerName) {
    if (!ownerName) return false;
    const clean = s => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    const n = clean(name), o = clean(ownerName);
    if (!n || !o) return false;
    if (n === o) return true;
    const op = o.split(' ');
    if (op.length < 2) return false;
    const first = op[0], last = op[op.length - 1];
    const np = n.split(' ');
    if (!np.includes(last)) return false;
    const rest = np.filter(w => w !== last).join('');
    if (!rest) return false;                              // surname alone — too weak
    return rest === first || (rest[0] === first[0] && rest.length <= 3);  // initials, incl. middle
}

async function saveRows(email, parsed, opts = {}) {
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
        category:  t.category
            || (isOwnName(t.merchant || t.description, opts.ownerName) ? 'savings_transfer' : 'other'),
        recurring: t.recurring || false,
    }));

    // Apply existing merchant assignments
    const assignments = getAssignments(email);
    const withBuckets = uncategorised.map(t => {
        const key = merchantKey(t.merchant || t.description);
        const asgn = assignments[key];
        return asgn ? { ...t, bucket: asgn.label } : t;
    });

    // Deduplicate against existing transactions — but a duplicate is not
    // useless: it may carry what the stored row is missing. Re-uploading a
    // statement backfills the source stamp (which bank) and the own-name
    // recognition onto rows that predate those features, so an upload is
    // never silently pointless.
    const existing = getTransactions(email);
    const existingByKey = new Map(existing.map(t => [dedupKey(t), t]));
    const fresh = [];
    let backfilled = 0;
    for (const t of withBuckets) {
        const hit = existingByKey.get(dedupKey(t));
        if (!hit) { fresh.push(t); continue; }
        let touched = false;
        if (t.source && !hit.source) { hit.source = t.source; touched = true; }
        // The account stamp is the whole point of a re-upload for rows that
        // predate account recognition — backfill it the same way.
        if (t.account && !hit.account) { hit.account = t.account; touched = true; }
        if (t.category === 'savings_transfer' && (!hit.category || hit.category === 'other')) {
            hit.category = 'savings_transfer';
            touched = true;
        }
        if (touched) backfilled++;
    }
    const merged = [...existing, ...fresh];
    merged.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    if (backfilled) console.log(`[finance] dedupe backfill — ${backfilled} existing rows gained source/own-name info`);
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

    return { added: fresh.length, total: merged.length, backfilled };
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

FIRST, if the document shows which account it belongs to, write ONE line before
anything else, exactly in this form:
#ACCOUNT: <bank name> | <account/product name or blank> | <account number or blank>
Copy what is printed — do not guess a bank, a product or a number. If the
document does not show it, omit this line entirely.

SECOND, if the document shows the balance at the start and/or end of the
statement period (often printed as "Balance on 01 August 2026" and "Balance on
15 August 2026", or "Opening balance" / "Closing balance"), write ONE line:
#BALANCE: <opening balance> | <opening date> | <closing balance> | <closing date>
Amounts exactly as printed, keeping the minus sign for an overdrawn balance.
Dates in YYYY-MM-DD. Leave a field blank if it is not shown. Omit the whole
line if no balance appears anywhere. NEVER calculate a balance yourself — only
copy one that is printed.

THEN return the transactions as plain CSV with a header row and one
transaction per line:
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
- CREDIT CARD statements run the other way from a bank account and you must
  NOT copy their sign convention: a purchase, cash withdrawal, interest line or
  fee is money LEAVING and must be NEGATIVE even though the card prints it as a
  plain figure; a payment received, a refund or any "CR" line is money coming
  in and must be POSITIVE. In the #BALANCE line for a credit card, a balance
  the person OWES is written with a minus sign (-450.00) and a balance in
  credit is written with CR after it (12.50 CR).
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
        if (!l || l.startsWith('#') || /^"?date"?\s*,/i.test(l)) continue;   // blank, #ACCOUNT header, or column header

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

// The reader is asked to copy the account header ("#ACCOUNT: Lloyds | Club
// Lloyds | 12345678") ahead of the CSV. Pull those lines out as plain text
// for detectAccount — which still applies its own fingerprints, so a reader
// that hallucinates a bank name it never saw cannot invent an account.
function accountHeaderText(csv) {
    return String(csv || '')
        .split(/\r?\n/)
        .filter(l => l.trim().startsWith('#ACCOUNT'))
        .join('\n')
        .replace(/\|/g, ' ');
}

// The opening and closing balance a statement prints on its own front page.
// This is what makes an import auditable: opening + everything that moved
// must equal closing, and any gap is exactly the money the reader missed.
// Only ever a figure COPIED from the page — the prompt forbids calculating
// one, because a calculated balance would agree with a broken read by
// construction and the check would always pass.
function parseBalanceHeader(csv) {
    // ⚠️ A long PDF is read in 4-page chunks and every chunk is given the
    // same prompt, so a multi-page statement produces SEVERAL #BALANCE lines
    // — one per chunk. Taking the first line's pair would compare page 1's
    // opening against page 1's closing and declare a 40-page statement
    // "short" on every import. The statement's true opening is the first
    // opening seen; its true closing is the last closing seen.
    const lines = String(csv || '').split(/\r?\n/).filter(l => l.trim().startsWith('#BALANCE'));
    if (!lines.length) return null;
    const num = s => {
        if (!s) return null;
        const v = parseAmount(s);
        return (Number.isFinite(v) && Math.abs(v) <= MAX_TXN_AMOUNT) ? v : null;
    };
    const cr = s => /\bCR\b/i.test(String(s || ''));           // credit card "in credit" marker
    const parsed = lines.map(l => {
        const rawP = l.replace(/^#BALANCE\s*:?\s*/i, '').split('|');
        const p = rawP.map(s => s.trim().replace(/\s*\bCR\b\s*/i, ''));
        return { opening: num(p[0]), openingDate: normDate(p[1]), closing: num(p[2]), closingDate: normDate(p[3]),
                 openingCr: cr(rawP[0]), closingCr: cr(rawP[2]) };
    });
    const firstWithOpening = parsed.find(p => p.opening != null);
    const lastWithClosing  = [...parsed].reverse().find(p => p.closing != null);
    if (!firstWithOpening && !lastWithClosing) return null;
    return {
        opening:     firstWithOpening ? firstWithOpening.opening : null,
        openingDate: firstWithOpening ? firstWithOpening.openingDate : null,
        openingCr:   firstWithOpening ? firstWithOpening.openingCr : false,
        closing:     lastWithClosing ? lastWithClosing.closing : null,
        closingDate: lastWithClosing ? lastWithClosing.closingDate : null,
        closingCr:   lastWithClosing ? lastWithClosing.closingCr : false,
        chunks:      parsed.length,
    };
}

/**
 * Does the statement's own arithmetic agree with what we read off it?
 * closing - opening is what the bank says moved. The rows we extracted are
 * what we think moved. A difference means pages or lines were missed — the
 * one failure this pipeline previously had no way to notice, because a short
 * read simply produced smaller totals and looked just as confident.
 */
function reconcileStatement(rows, bal) {
    if (!bal || bal.opening == null || bal.closing == null) return null;
    const read     = Math.round(rows.reduce((s, t) => s + (Number(t.amount) || 0), 0) * 100) / 100;
    const expected = Math.round((bal.closing - bal.opening) * 100) / 100;
    const diff     = Math.round((read - expected) * 100) / 100;
    return {
        opening: bal.opening,
        closing: bal.closing,
        expected_movement: expected,
        read_movement: read,
        difference: diff,
        ok: Math.abs(diff) < 0.005,
    };
}

async function importStatementFromImage(email, imageBase64, mimeType, filename, ownerName) {
    const raw = await visionRead({
        prompt:   STATEMENT_IMAGE_PROMPT,
        base64:   imageBase64,
        mimeType: mimeType || 'image/jpeg',
        maxTokens: 8000,
    });
    if (!raw || raw.trim().length < 20) return { added: 0, total: 0 };
    const source = deriveSource(filename, '');
    const acct = detectAccount(accountHeaderText(raw), filename);
    if (acct) upsertAccount(email, acct, source);
    const bal = normaliseCardBalance(parseBalanceHeader(raw), acct);
    // Card statements: check the signs against the statement's own evidence
    // BEFORE anything is saved (see normaliseCardRows).
    const rows = normaliseCardRows(csvToRows(raw).map(r => ({ ...r, source, ...(acct && { account: acct.id }) })), acct, bal).rows;
    console.log(`[finance] importStatementFromImage: vision ${raw.length} chars → ${rows.length} rows (no re-parse)${acct ? `, account "${acct.label}"` : ''}`);
    const result = await saveRows(email, rows, { ownerName });
    const check = reconcileStatement(rows, bal);
    if (bal && bal.closing != null && acct) setAccountBalance(email, acct.id, bal.closing, bal.closingDate || undefined);
    if (check) {
        result.reconciliation = check;
        if (!check.ok) {
            result.hint = `⚠️ This statement doesn't add up. The bank's own balances say £${Math.abs(check.difference).toFixed(2)} more moved than I could read — some transactions were missed.`;
        }
    }
    return result;
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
async function importStatementFromFile(email, fileBase64, mimeType, onProgress, filename, ownerName) {
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
        const acct = detectAccount(accountHeaderText(chunked.csv), filename);
        if (acct) upsertAccount(email, acct, source);
        // The statement's own front-page balances audit the read, and give
        // the account a real balance without anyone typing one. Read first:
        // on a credit card they are also the evidence for which way round the
        // rows were read (normaliseCardRows).
        const bal = normaliseCardBalance(parseBalanceHeader(chunked.csv), acct);
        const rows = normaliseCardRows(csvToRows(chunked.csv).map(r => ({ ...r, source, ...(acct && { account: acct.id }) })), acct, bal).rows;
        console.log(`[finance] PDF→Gemini chunked: ${chunked.pageCount} pages → ${rows.length} rows; failed: ${chunked.failed.join(', ') || 'none'}${acct ? `; account "${acct.label}"` : ''}`);
        if (!rows.length) {
            return { added: 0, total, hint: 'Could not read transactions from this PDF — try uploading a clearer copy.' };
        }
        const result = await saveRows(email, rows, { ownerName });

        const check = reconcileStatement(rows, bal);
        if (bal && bal.closing != null && acct) {
            setAccountBalance(email, acct.id, bal.closing, bal.closingDate || undefined);
        }
        if (check) {
            result.reconciliation = check;
            console.log(`[finance] statement check — bank says ${check.expected_movement}, we read ${check.read_movement}, diff ${check.difference} → ${check.ok ? 'COMPLETE' : 'SHORT'}`);
        }

        // Tell her what happened, in every case. A silent success is what let
        // a short read look identical to a complete one.
        if (chunked.failed.length) {
            result.hint = `Imported ${result.added} transactions, but page(s) ${chunked.failed.join(', ')} of ${chunked.pageCount} couldn't be read — upload the same PDF again to retry those.`;
        } else if (check && !check.ok) {
            const missing = Math.abs(check.difference);
            result.hint = `⚠️ This statement doesn't add up. The bank's own closing balance says £${missing.toFixed(2)} ${check.difference < 0 ? 'more' : 'less'} moved than I could read — some transactions were missed. Upload a clearer copy of this one.`;
        } else if (check && check.ok) {
            result.hint = `✅ Checked against the bank's own opening and closing balance — every transaction on this statement was read.`;
        } else if (bal && bal.closing != null) {
            result.hint = `Balance read from the statement: £${bal.closing.toFixed(2)}. No opening balance printed, so I can't verify the read was complete.`;
        }
        return result;
    }
    // Actual image (JPEG, PNG, WebP, etc.)
    return importStatementFromImage(email, fileBase64, mimeType || 'image/jpeg', filename, ownerName);
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
function startImportJob(email, fileBase64, mimeType, filename, ownerName) {
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
            const result = await importStatementFromFile(email, fileBase64, mimeType, onProgress, filename, ownerName);
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
//
// With the user's accounts passed in, the same set also carries payments to
// a credit card they hold and payments received on it (cardPaymentIds) —
// the other way the same pound gets counted twice.
function pairInternalTransfers(txns, accounts) {
    const paired = cardPaymentIds(txns, accounts);
    const credits = txns.filter(t => t.amount > 0 && t.category !== 'savings_transfer' && !paired.has(t.id) && Math.abs(t.amount) >= 5);
    const debits  = txns.filter(t => t.amount < 0 && t.category !== 'savings_transfer' && !paired.has(t.id) && Math.abs(t.amount) >= 5);
    const usedCredits = new Set();
    // Two halves of a self-move must come from DIFFERENT accounts. The account
    // stamp is the real test; the filename is the fallback for rows imported
    // before accounts were recognised. Same account on both sides means it is
    // a purchase and its refund, not money moving between her banks.
    const sameSide = (a, b) => (a.account && b.account)
        ? a.account === b.account
        : !!(a.source && b.source && a.source === b.source);
    for (const d of debits) {
        const dT = Date.parse(d.date || '');
        if (!Number.isFinite(dT)) continue;
        const match = credits.find(c => !usedCredits.has(c.id)
            && Math.abs(c.amount + d.amount) < 0.005
            && Number.isFinite(Date.parse(c.date || ''))
            && Math.abs(Date.parse(c.date) - dT) <= 4 * 86400000
            && !sameSide(d, c));
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
    const pairedIds = pairInternalTransfers(txns, getAccounts(email));
    const viewCat = t => pairedIds.has(t.id) ? 'savings_transfer' : (t.category || 'other');

    // Graph 1: category breakdown. "Where your money goes" is a SPENDING
    // chart, so money moved between the user's own pots and banks is not in
    // it — it never left. Including it made "Own transfers" the biggest slice
    // on the page, squashing groceries, children and subscriptions into
    // slivers and contradicting the headline totals directly beneath it.
    // Own transfers stay fully visible: the account cards report both
    // directions, the summary line carries the total, and the transactions
    // filter still has an "Own transfers / savings" option.
    const byCategory = {};
    for (const t of debits) {
        const cat = viewCat(t);
        if (cat === 'savings_transfer') continue;
        byCategory[cat] = (byCategory[cat] || 0) + Math.abs(t.amount);
    }

    // Graph 2: bucket/person breakdown (only assigned transactions).
    //
    // ⚠️ DELIBERATELY NOT the same rule as the donut above. Sarah's children
    // have accounts held under her own banking, so a transfer to Charlie is
    // filed savings_transfer ("still her money") — but it IS money spent on
    // Charlie, and knowing what each child costs is the entire point of this
    // chart. Excluding self-moves here erased them. A bucket is a human's
    // answer to "who was this for", and it outranks the category machinery.
    // The chart therefore does NOT sum to total_spend, and must not be
    // "corrected" to.
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
            // Which statements the data came from — so "three banks" is
            // visible on the page, not a mystery.
            // Every statement that fed this picture. NOT capped at a handful:
            // Sarah runs personal and business accounts across several banks,
            // and a truncated list would quietly imply she'd loaded fewer
            // statements than she had.
            sources: [...new Set(txns.map(t => t.source).filter(Boolean))],
            // How many rows the app cannot yet attribute to an account. This
            // is the honest counterpart to the account cards: if 1,410 rows
            // have no account, the page says so instead of implying the
            // breakdown is complete.
            unattributed_count: txns.filter(t => !t.account).length,
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
    // Own money moving — a pot transfer, a card payment — is never a
    // subscription, however regular it is.
    const paired = pairInternalTransfers(txns, getAccounts(email));
    const debits = txns.filter(t => t.amount < 0 && (t.recurring || t.category === 'subscriptions')
        && t.category !== 'savings_transfer' && !paired.has(t.id));
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


// Reference codes split one payer into many: "200Y14H4M DWP UC" and
// "200X19N45 DWP UC" are the same benefit with per-payment references.
// Strip mixed letter+digit tokens (6+ chars) before grouping — real names
// ("GAINES SL") are untouched.
function stripRefTokens(name) {
    const cleaned = String(name || '')
        .split(/\s+/)
        .filter(w => !(w.length >= 6 && /[A-Za-z]/.test(w) && /\d/.test(w)))
        .join(' ')
        .trim();
    return cleaned || String(name || '');
}

// Income sources — credits grouped the way subscriptions are, with
// self-transfers (pots, savings, cross-account pairs) excluded so a top-up
// from the user's own other bank never masquerades as income.
// Money you also SEND to someone is not income when it comes back. An
// employer never receives money from you; the DWP never receives money from
// you; family does, constantly. A two-way flow is the signature of a person
// you exchange money with — the exact thing that kept putting Sarah's
// family into her income list. Computed from her own data, so it works for
// everyone without anyone labelling anything.
function twoWayPayers(txns, paired) {
    const paidTo = new Map();     // merchantKey -> total sent to them
    for (const t of txns) {
        if (!(t.amount < 0) || t.category === 'savings_transfer' || paired.has(t.id)) continue;
        const k = merchantKey(stripRefTokens(t.merchant || t.description));
        if (!k) continue;
        paidTo.set(k, (paidTo.get(k) || 0) + Math.abs(t.amount));
    }
    // A trivial amount going the other way is noise (a refund, a rounding, a
    // single fiver). £50 of genuine two-way traffic is a relationship.
    const out = new Set();
    for (const [k, total] of paidTo) if (total >= 50) out.add(k);
    return out;
}

function detectIncome(email) {
    const txns = getTransactions(email);
    const paired = pairInternalTransfers(txns, getAccounts(email));
    const twoWay = twoWayPayers(txns, paired);
    const credits = txns.filter(t => t.amount > 0 && t.category !== 'savings_transfer' && !paired.has(t.id));
    const byMerchant = {};
    for (const t of credits) {
        const k = merchantKey(stripRefTokens(t.merchant || t.description));
        // Someone she sends real money to is not one of her income sources —
        // unless she has explicitly labelled these credits as income, which
        // is her overriding the machine and always wins.
        if (twoWay.has(k) && !(byMerchant[k] || []).some(x => x.category === 'income')) {
            const isLabelledIncome = credits.some(c => merchantKey(stripRefTokens(c.merchant || c.description)) === k && c.category === 'income');
            if (!isLabelledIncome) continue;
        }
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
            // The income label helps but never bypasses the size bar — the
            // old fast-path let every mislabelled refund and one-off fiver
            // walk straight into the box.
            if (entries.every(t => t.category && t.category !== 'other' && t.category !== 'income')) return false;
            if (/refund|reversal|dispute/i.test(entries.map(t => (t.description || '') + ' ' + (t.merchant || '')).join(' '))) return false;
            const total = entries.reduce((s, t) => s + t.amount, 0);
            if (total >= 150) return true;
            return entries.length >= 2 && total >= 100;
        })
        .map(entries => {
            entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            return {
                merchant:       stripRefTokens(entries[0].merchant || entries[0].description),
                amount:         Math.abs(entries[0].amount),
                last_seen:      entries[0].date,
                source:         entries[0].source || null,
                count:          entries.length,
                total_received: Math.round(entries.reduce((s, t) => s + t.amount, 0) * 100) / 100,
            };
        })
        .sort((a, b) => b.total_received - a.total_received);
}

// ── What the charges cost ─────────────────────────────────────────
// Sarah's thesis, in her words: "We put things off and we pay charges and
// that keeps these big businesses ticking." The categoriser has had a
// fees_charges bucket all along and NOTHING on the page ever showed it.
//
// Two groups, deliberately kept apart. A penalty is money lost to timing —
// it is avoidable and it is the number that should make someone angry. An
// account fee is the price of a product she chose, and lumping the two
// together would either understate the penalties or slander the fees.
const CHARGE_PATTERNS = [
    // Avoidable — the cost of being late, short, or over.
    { type: 'penalty', label: 'Unarranged overdraft',   re: /unarranged|unauthoris?ed (?:overdraft|borrowing)/i },
    { type: 'penalty', label: 'Overdraft interest',     re: /overdraft (?:interest|fee|charge|usage)/i },
    { type: 'penalty', label: 'Returned payment',       re: /returned (?:item|direct debit|payment|cheque)|unpaid (?:item|direct debit|cheque|transaction)/i },
    { type: 'penalty', label: 'Late payment',           re: /late payment|missed payment|arrears (?:charge|fee)/i },
    { type: 'penalty', label: 'Default charge',         re: /default (?:sum|charge|fee)|penalty (?:charge|fee)/i },
    { type: 'penalty', label: 'Referral fee',           re: /referral fee|paid referral/i },
    { type: 'penalty', label: 'Interest charged',       re: /interest charged|debit interest/i },
    // Contractual — the price of the product, not a punishment.
    { type: 'fee',     label: 'Account fee',            re: /(?:monthly |account |service |maintenance |membership )fee|club lloyds fee|package fee/i },
    { type: 'fee',     label: 'Card fee',               re: /card (?:replacement |delivery )?fee/i },
    { type: 'fee',     label: 'Cash withdrawal fee',    re: /(?:atm|cash (?:machine|advance|withdrawal)) fee/i },
    { type: 'fee',     label: 'Non-sterling fee',       re: /non-?sterling|foreign (?:transaction|currency|exchange) fee/i },
    { type: 'fee',     label: 'Arrangement fee',        re: /arrangement fee|admin(?:istration)? fee|set-?up fee/i },
];

/**
 * Every charge the statements contain, what kind it is, and what it added up
 * to. Reads the descriptions directly rather than trusting the categoriser —
 * a charge the labeller filed as 'other' is exactly the charge nobody ever
 * notices, which is the whole problem this card exists to solve.
 */
function detectCharges(email) {
    const txns = getTransactions(email);
    const groups = new Map();
    let uncategorised = 0;

    for (const t of txns) {
        if (!(t.amount < 0)) continue;                       // a refund of a fee is not a charge
        const text = `${t.description || ''} ${t.merchant || ''}`;
        const hit = CHARGE_PATTERNS.find(p => p.re.test(text));
        // A row the labeller called fees_charges but no pattern matched is
        // still a charge — count it rather than lose it.
        if (!hit && t.category !== 'fees_charges') continue;
        const key = hit ? hit.label : 'Other bank charge';
        const type = hit ? hit.type : 'penalty';
        if (!hit) uncategorised++;
        if (!groups.has(key)) groups.set(key, { label: key, type, count: 0, total: 0, last_seen: '', first_seen: '', sources: new Set() });
        const g = groups.get(key);
        g.count++;
        g.total += Math.abs(t.amount);
        if (t.date && (!g.last_seen  || t.date > g.last_seen))  g.last_seen  = t.date;
        if (t.date && (!g.first_seen || t.date < g.first_seen)) g.first_seen = t.date;
        if (t.account) g.sources.add(t.account);
    }

    const items = [...groups.values()]
        .map(g => ({ ...g, total: Math.round(g.total * 100) / 100, sources: [...g.sources] }))
        .sort((a, b) => b.total - a.total);

    const penalties = items.filter(i => i.type === 'penalty');
    const fees      = items.filter(i => i.type === 'fee');
    const sum = arr => Math.round(arr.reduce((s, i) => s + i.total, 0) * 100) / 100;

    // Monthly rate, so the figure means something regardless of how much
    // history happens to be loaded.
    const dates = txns.map(t => t.date).filter(Boolean).sort();
    const months = (dates.length >= 2)
        ? Math.max(1, (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (30.44 * 86400000))
        : 1;

    return {
        penalties,
        fees,
        penalty_total: sum(penalties),
        fee_total:     sum(fees),
        total:         sum(items),
        penalty_per_month: Math.round((sum(penalties) / months) * 100) / 100,
        penalty_per_year:  Math.round((sum(penalties) / months) * 12 * 100) / 100,
        months_covered: Math.round(months * 10) / 10,
        unmatched_rows: uncategorised,
    };
}

// ── Income forecast ───────────────────────────────────────────────
// "I need a clear run of what's coming in and when, like a forecast."
//
// ⚠️ UK benefit cadences are the reason this can't reuse the rhythm card's
// bands. PIP and Child Benefit land every FOUR WEEKS — 13 payments a year,
// drifting earlier through the calendar — while Universal Credit and wages
// are MONTHLY on roughly the same date. The rhythm card lumps 24–38 days
// into one "monthly" band, which is fine for a badge and useless for a
// forecast: four-weekly predicted as monthly is wrong by a growing number
// of days every cycle, and being told the wrong day is worse than being
// told nothing.
const CADENCES = [
    { key: 'weekly',      label: 'weekly',        days: 7,  lo: 6,  hi: 8 },
    { key: 'fortnightly', label: 'fortnightly',   days: 14, lo: 13, hi: 15 },
    { key: 'four_weekly', label: 'every 4 weeks', days: 28, lo: 27, hi: 29 },
    { key: 'monthly',     label: 'monthly',       days: 30, lo: 29, hi: 32 },
];

function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// Monthly means "the same date each month", not "30 days later" — otherwise
// a wage paid on the 28th drifts to the 26th over a few months.
function addMonthKeepingDay(iso, n, day) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d.toISOString().slice(0, 10);
}

/**
 * What is coming in, and when. Projects each recurring income stream forward
 * from the pattern it has actually shown — never from an assumption about
 * what a payer "should" do.
 *
 * @param {number} weeks  how far ahead to project
 */
function forecastIncome(email, weeks = 12) {
    const txns   = getTransactions(email);
    const paired = pairInternalTransfers(txns, getAccounts(email));
    const twoWay = twoWayPayers(txns, paired);

    const credits = txns.filter(t => t.amount > 0
        && t.category !== 'savings_transfer'
        && !paired.has(t.id)
        && t.date);

    const groups = {};
    for (const t of credits) {
        const k = merchantKey(stripRefTokens(t.merchant || t.description));
        if (!k) continue;
        if (twoWay.has(k) && t.category !== 'income') continue;   // family, not income
        (groups[k] = groups[k] || []).push(t);
    }

    const today   = new Date().toISOString().slice(0, 10);
    const horizon = addDays(today, weeks * 7);
    const streams = [];
    const events  = [];

    for (const entries of Object.values(groups)) {
        if (entries.length < 2) continue;                 // one payment is not a pattern
        entries.sort((a, b) => a.date.localeCompare(b.date));

        const gaps = [];
        for (let i = 1; i < entries.length; i++) {
            const g = (Date.parse(entries[i].date) - Date.parse(entries[i - 1].date)) / 86400000;
            if (Number.isFinite(g) && g > 0) gaps.push(g);
        }
        if (!gaps.length) continue;
        const sorted = [...gaps].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];

        const cad = CADENCES.find(c => median >= c.lo && median <= c.hi);
        if (!cad) continue;                               // no dependable rhythm — don't pretend

        // Most gaps must actually sit in the band; one late payment survives,
        // a coincidence does not.
        const inBand = gaps.filter(g => g >= cad.lo && g <= cad.hi).length;
        if (inBand < Math.max(1, Math.ceil(gaps.length * 0.6))) continue;

        const amounts = entries.map(t => t.amount).sort((a, b) => a - b);
        const median$ = amounts[Math.floor(amounts.length / 2)];
        const spread  = median$ > 0 ? (amounts[amounts.length - 1] - amounts[0]) / median$ : 1;
        const last    = entries[entries.length - 1];
        const dayOfMonth = Number(last.date.slice(8, 10));

        // Confidence is stated, not implied. A wage paid the same amount on
        // the same date six times is not the same claim as two payments that
        // happened to fall four weeks apart.
        const confidence = (entries.length >= 4 && spread <= 0.1) ? 'high'
                         : (entries.length >= 3 && spread <= 0.35) ? 'medium'
                         : 'low';

        const stream = {
            payer:      stripRefTokens(last.merchant || last.description),
            cadence:    cad.key,
            cadence_label: cad.label,
            amount:     Math.round(median$ * 100) / 100,
            varies:     spread > 0.1,
            last_seen:  last.date,
            count:      entries.length,
            confidence,
            source:     last.source || null,
            account:    last.account || null,
        };
        streams.push(stream);

        // Project forward. Monthly keeps its date; everything else steps by
        // its own day-count, which is what makes four-weekly drift correctly.
        let next = cad.key === 'monthly'
            ? addMonthKeepingDay(last.date, 1, dayOfMonth)
            : addDays(last.date, cad.days);
        let guard = 0, step = 1;
        while (next <= horizon && guard++ < 60) {
            if (next >= today) {
                events.push({
                    date: next,
                    payer: stream.payer,
                    amount: stream.amount,
                    cadence: cad.key,
                    cadence_label: cad.label,
                    confidence,
                    varies: stream.varies,
                });
            }
            step++;
            next = cad.key === 'monthly'
                ? addMonthKeepingDay(last.date, step, dayOfMonth)
                : addDays(last.date, cad.days * step);
        }
    }

    events.sort((a, b) => a.date.localeCompare(b.date));

    // What it adds up to over the horizon, and a monthly equivalent — the
    // figure that answers "what am I actually living on".
    const total = Math.round(events.reduce((s, e) => s + e.amount, 0) * 100) / 100;
    const perMonth = Math.round((total / (weeks / 4.345)) * 100) / 100;

    return {
        streams: streams.sort((a, b) => b.amount - a.amount),
        events,
        weeks,
        from: today,
        to: horizon,
        total_expected: total,
        monthly_equivalent: perMonth,
        next: events[0] || null,
    };
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
    const paired = pairInternalTransfers(txns, getAccounts(email));
    const live = txns.filter(t => t.category !== 'savings_transfer' && !paired.has(t.id) && t.date);
    const groups = {};
    for (const t of live) {
        const k = (t.amount < 0 ? 'out:' : 'in:') + merchantKey(stripRefTokens(t.merchant || t.description));
        (groups[k] = groups[k] || []).push(t);
    }
    const rhythm = { in: { weekly: [], monthly: [], bills: [] }, out: { weekly: [], monthly: [], bills: [] } };
    for (const [k, entries] of Object.entries(groups)) {
        // Bill-natured charges (subscriptions, utilities, housing, fees)
        // surface from their FIRST payment — the card is Sarah's early
        // warning for a new charge, and waiting for repeats means "people
        // get away with 3 payments before I notice". Everything else needs
        // at least two occurrences to be worth a rhythm look.
        const isBillNature = entries.some(t => BILL_CATEGORIES.has(t.category));
        if (entries.length < 2 && !isBillNature) continue;
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
        // A rhythm needs EVIDENCE, not coincidence: two payments that happen
        // to land a week apart are not "weekly" (that badge was landing on
        // people paid twice, ever). At least 3 payments, median in the band,
        // and most gaps actually inside it — one skipped month survives, a
        // fluke doesn't. AND the amount must be steady: wages and Spotify
        // are the same figure every time; parking and Costco runs are
        // habits with wandering amounts, not commitments, and they were
        // cluttering the card as "weekly".
        const amounts = entries.map(t => Math.abs(t.amount)).sort((a, b) => a - b);
        const medAmt = amounts[Math.floor(amounts.length / 2)] || 0;
        const steadyAmount = medAmt > 0 && (amounts[amounts.length - 1] - amounts[0]) / medAmt <= 0.25;
        const rhythmic = (lo, hi) => {
            if (!steadyAmount) return false;
            if (entries.length < 3 || median == null || median < lo || median > hi) return false;
            const inBand = gaps.filter(g => g >= lo && g <= hi).length;
            return inBand >= Math.max(2, Math.ceil(gaps.length * 0.6));
        };
        let target = null, cadence = null, monthlyEquiv = null;
        if (rhythmic(5, 10))        { target = 'weekly';  cadence = 'weekly';      monthlyEquiv = amount * 4.33; }
        else if (rhythmic(11, 18))  { target = 'weekly';  cadence = 'fortnightly'; monthlyEquiv = amount * 2.17; }
        else if (rhythmic(24, 38))  { target = 'monthly'; cadence = 'monthly';     monthlyEquiv = amount; }
        else if (isBillNature) { target = 'bills'; cadence = entries.length === 1 ? 'new' : 'irregular'; }
        if (!target) continue;
        rhythm[dir][target].push({
            merchant:      stripRefTokens(latest.merchant || latest.description),
            amount:        Math.round(amount * 100) / 100,
            cadence,
            monthly_equiv: monthlyEquiv != null ? Math.round(monthlyEquiv * 100) / 100 : null,
            count:         entries.length,
            is_new:        entries.length === 1,
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

    // Accounts
    detectAccount,
    cardPaymentIds,
    normaliseCardRows,
    normaliseCardBalance,
    parseBalanceHeader,
    pairInternalTransfers,
    getAccounts,
    getAccountsWithTotals,
    upsertAccount,
    setAccountBalance,
    importBalancesFromScreenshot,

    // Subscriptions + income + rhythm + charges
    detectSubscriptions,
    detectIncome,
    detectRegulars,
    detectCharges,
    forecastIncome,

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
