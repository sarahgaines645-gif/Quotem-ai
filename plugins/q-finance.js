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
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
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
async function geminiText(prompt, { maxTokens = 8000 } = {}) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res;
    try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
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
  savings_transfer — transfers to savings, ISA contributions
  income           — wages, HMRC credits, benefits, refunds
  fees_charges     — bank charges, overdraft fees, late fees
  other            — anything that doesn't fit above

Return a JSON array — same order as input — each item:
{ "id": "<the id field from input>", "category": "<category>", "recurring": true|false }

recurring = true if this looks like a regular subscription or standing order.
Return ONLY the JSON array.`;

async function categoriseTransactions(transactions) {
    if (!transactions.length) return transactions;

    // Batch — one giant call over a 3-month statement (565 txns) blew the
    // 90s timeout and the throw discarded the WHOLE import. Small batches
    // each finish fast, and a failed batch only loses that batch's
    // categories (left as 'other'), never the transactions themselves.
    const BATCH = 120;   // Gemini is fast & reliable — bigger batches, far fewer calls
    const catMap = {};

    for (let i = 0; i < transactions.length; i += BATCH) {
        const slice = transactions.slice(i, i + BATCH);
        const input = slice.map(t => ({
            id:          t.id,
            description: t.description,
            merchant:    t.merchant,
            amount:      t.amount,
        }));
        try {
            const raw = cleanModelOutput(await geminiText(`${CATEGORISE_SYSTEM}\n\n${JSON.stringify(input)}`, { maxTokens: 8000 }));
            const m = raw.match(/\[[\s\S]*\]/);
            for (const c of (m ? JSON.parse(m[0]) : [])) catMap[c.id] = c;
        } catch (e) {
            console.warn(`[finance] categorise batch ${i}-${i + slice.length} failed (${e.message}) — those rows stay 'other'`);
        }
    }

    return transactions.map(t => ({
        ...t,
        category:  catMap[t.id]?.category  || 'other',
        recurring: catMap[t.id]?.recurring || false,
    }));
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

// UK-first date normaliser → YYYY-MM-DD. Handles ISO, DD/MM/YYYY,
// DD-MM-YY and "01 May 2026".
function normDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) { let y = m[3]; if (y.length === 2) y = '20' + y;
        return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})/);
    if (m) {
        const mo = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 }[m[2].slice(0, 3).toLowerCase()];
        if (mo) { let y = m[3]; if (y.length === 2) y = '20' + y;
            return `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
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
        rows.push({ date, description: desc, merchant: desc, amount });
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
async function importStatement(email, rawText) {
    const csvRows = parseCsvStatement(rawText);
    if (csvRows && csvRows.length) {
        console.log(`[finance] importStatement: ${csvRows.length} rows via deterministic CSV parser (no AI)`);
        return saveRows(email, csvRows);
    }
    const parsed = await parseStatementText(rawText);
    return saveRows(email, parsed);
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
    // Defence in depth: categorisation must NEVER lose a successfully-read
    // statement. If it fails wholesale, save the rows uncategorised — the
    // user can re-categorise, but they never lose their transactions.
    let categorised;
    try {
        categorised = await categoriseTransactions(stamped);
    } catch (e) {
        console.warn(`[finance] categorisation failed wholesale (${e.message}) — saving ${stamped.length} rows as 'other'`);
        categorised = stamped.map(t => ({ ...t, category: 'other', recurring: false }));
    }

    // Apply existing merchant assignments
    const assignments = getAssignments(email);
    const withBuckets = categorised.map(t => {
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
    return { added: fresh.length, total: merged.length };
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
        let date = null;
        let m = l.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
        if (!date) {
            m = l.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
            if (m) { let y = m[3]; if (y.length === 2) y = '20' + y;
                date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
        }
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

async function importStatementFromImage(email, imageBase64, mimeType) {
    const raw = await visionRead({
        prompt:   STATEMENT_IMAGE_PROMPT,
        base64:   imageBase64,
        mimeType: mimeType || 'image/jpeg',
        maxTokens: 8000,
    });
    if (!raw || raw.trim().length < 20) return { added: 0, total: 0 };
    const rows = csvToRows(raw);
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
async function importStatementFromFile(email, fileBase64, mimeType, onProgress) {
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
        const rows = csvToRows(chunked.csv);
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
    return importStatementFromImage(email, fileBase64, mimeType || 'image/jpeg');
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
function startImportJob(email, fileBase64, mimeType) {
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
            const result = await importStatementFromFile(email, fileBase64, mimeType, onProgress);
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
        maxTokens: 8192,   // was 1200 — that GUARANTEED a full letter could not be transcribed
    });
    try {
        const m = raw.match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : { error: 'Parse failed' };
    } catch {
        return { error: 'Parse failed', raw };
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

function repairTransactions(email) {
    const txns = getTransactions(email);
    const corrupt = txns.filter(isCorruptAmount);
    if (!corrupt.length) return { removed: 0 };
    const bak = `transactions.corrupt-backup-${Date.now()}.json`;
    saveJSON(finPath(email, bak), txns);                 // full backup BEFORE mutating
    for (const t of corrupt) {
        console.warn(`[finance] repair removed corrupt row — ${t.date} ${t.amount} "${String(t.description || '').slice(0, 40)}"`);
    }
    const clean = txns.filter(t => !isCorruptAmount(t));
    saveTransactions(email, clean);
    console.warn(`[finance] repair: removed ${corrupt.length} corrupt rows; backup=${bak}; ${clean.length} remain`);
    return { removed: corrupt.length, backup: bak };
}

// ── Spending graphs ───────────────────────────────────────────────

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

    // Graph 1: category breakdown
    const byCategory = {};
    for (const t of debits) {
        const cat = t.category || 'other';
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

    const totalSpend  = debits.reduce((s, t) => s + Math.abs(t.amount), 0);
    const totalIncome = txns.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);

    return {
        by_category:    sortObj(byCategory),
        by_bucket:      sortObj(byBucket),
        subscriptions,
        summary: {
            total_spend:  Math.round(totalSpend  * 100) / 100,
            total_income: Math.round(totalIncome * 100) / 100,
            net:          Math.round((totalIncome - totalSpend) * 100) / 100,
            transaction_count: txns.length,
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
    const debits = txns.filter(t => t.amount < 0 && t.recurring);
    const byMerchant = {};
    for (const t of debits) {
        const k = merchantKey(t.merchant || t.description);
        if (!byMerchant[k]) byMerchant[k] = [];
        byMerchant[k].push(t);
    }
    return Object.entries(byMerchant)
        .filter(([, entries]) => entries.length >= 2)
        .map(([, entries]) => {
            entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            return {
                merchant:    entries[0].merchant || entries[0].description,
                amount:      Math.abs(entries[0].amount),
                category:    entries[0].category,
                bucket:      entries[0].bucket,
                last_seen:   entries[0].date,
                count:       entries.length,
                total_paid:  Math.round(entries.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100,
            };
        })
        .sort((a, b) => b.amount - a.amount);
}


module.exports = {
    // Transactions
    importStatement,
    getTransactions,
    saveTransactions,
    updateTransaction,
    deleteTransactions,
    categoriseTransactions,

    // Documents / vision
    extractDocument,
    importStatementFromImage,
    importStatementFromFile,
    startImportJob,
    getImportJob,

    // Assignments
    assignMerchant,
    getAssignments,

    // Subscriptions
    detectSubscriptions,

    // Graphs
    getSpendingGraphData,

    // Problem queue
    getProblemQueue,
    addProblem,
    updateProblem,
    addDocumentToProblem,

    // Advice
    getAdvice,
};
