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
async function togetherChat({ model, messages, temperature = 0, max_tokens = 4000 }) {
    const res = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Together AI ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
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

const PARSE_SYSTEM = `You are a bank statement parser. The user will give you raw text copied from a bank statement or a CSV export. Extract every transaction into a JSON array.

Each transaction object:
{
  "date":        "YYYY-MM-DD",
  "description": "exact merchant/payee text from the statement",
  "amount":      number (NEGATIVE for money leaving = debits/payments. POSITIVE for money coming in = credits/income),
  "merchant":    "cleaned merchant name (e.g. 'McDonald\\'s', 'Netflix', 'HMRC')"
}

Rules:
- Parse ALL transactions — do not skip, summarise, or truncate.
- If the statement shows debit/credit in separate columns, debit = negative amount.
- Ignore header rows, balance rows, and running totals.
- Dates: convert to YYYY-MM-DD. If year is missing, use the most recent plausible year.
- If you cannot parse a line, skip it silently.
- Return ONLY a JSON array. No markdown, no commentary.`;

async function parseStatementText(rawText) {
    const raw = cleanModelOutput(await togetherChat({
        model:      Q_CONFIG.model,
        max_tokens: 8000,
        messages: [
            { role: 'system', content: PARSE_SYSTEM },
            { role: 'user',   content: rawText.slice(0, 40000) },
        ],
    }));
    try {
        const m = raw.match(/\[[\s\S]*\]/);
        return m ? JSON.parse(m[0]) : [];
    } catch {
        return [];
    }
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

    const input = transactions.map(t => ({
        id:          t.id,
        description: t.description,
        merchant:    t.merchant,
        amount:      t.amount,
    }));

    const raw = cleanModelOutput(await togetherChat({
        model:      Q_CONFIG.model,
        max_tokens: 6000,
        messages: [
            { role: 'system', content: CATEGORISE_SYSTEM },
            { role: 'user',   content: JSON.stringify(input) },
        ],
    }));
    let categories = [];
    try {
        const m = raw.match(/\[[\s\S]*\]/);
        categories = m ? JSON.parse(m[0]) : [];
    } catch { /* */ }

    const catMap = {};
    for (const c of categories) catMap[c.id] = c;

    return transactions.map(t => ({
        ...t,
        category:  catMap[t.id]?.category  || 'other',
        recurring: catMap[t.id]?.recurring || false,
    }));
}


/**
 * Parse + categorise raw statement text, merge with existing user transactions
 * (deduplication by date+merchant+amount), and save.
 * Returns { added, total } counts.
 */
async function importStatement(email, rawText) {
    const parsed = await parseStatementText(rawText);
    if (!parsed.length) return { added: 0, total: 0 };

    // Stamp each parsed row with an id before categorising
    const stamped = parsed.map(t => ({ ...t, id: uid(), bucket: null, flagged: false }));
    const categorised = await categoriseTransactions(stamped);

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
    return `${t.date}|${t.amount}|${merchantKey(t.merchant || t.description)}`;
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
  "notes":       "any important extra detail (payment plan offers, discount schemes mentioned, etc.) or null"
}
If you cannot read the document, return { "error": "Cannot read document" }.`;

const STATEMENT_IMAGE_PROMPT = `You are reading a bank statement document. Extract EVERY transaction you can see.
Return them as plain CSV with a header row and one transaction per line:
date,description,amount

Rules:
- date: YYYY-MM-DD format
- description: exact text from the statement
- amount: NEGATIVE number for money leaving the account (payments/debits), POSITIVE for money coming in (credits/income)
- Do NOT include balance columns, opening/closing balance totals, or header/footer rows
- If multiple pages are visible, extract ALL of them
- Return ONLY the CSV. No explanation, no markdown.`;

async function importStatementFromImage(email, imageBase64, mimeType) {
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;
    const raw = cleanModelOutput(await togetherChat({
        model:      Q_CONFIG.visionModel,
        max_tokens: 8000,
        messages: [{
            role: 'user',
            content: [
                { type: 'text',      text: STATEMENT_IMAGE_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } },
            ],
        }],
    }));
    if (!raw || raw.trim().length < 20) return { added: 0, total: 0 };
    return importStatement(email, raw);
}

// PDFs → pdf-parse for text extraction. Images → vision model.
// Together AI vision does not accept application/pdf — only JPEG/PNG/WebP.
async function importStatementFromFile(email, fileBase64, mimeType) {
    if (mimeType === 'application/pdf') {
        const pdfParse = require('pdf-parse');
        const buffer = Buffer.from(fileBase64, 'base64');
        const data = await pdfParse(buffer);
        const text = (data.text || '').trim();
        if (text.length < 20) {
            return { added: 0, total: 0, hint: 'Could not extract text from this PDF — try exporting as CSV from your bank, or take a photo and scan from phone' };
        }
        return importStatement(email, text);
    }
    // Actual image (JPEG, PNG, WebP, etc.)
    return importStatementFromImage(email, fileBase64, mimeType || 'image/jpeg');
}


async function extractDocument(imageBase64, mimeType = 'image/jpeg') {
    const raw = cleanModelOutput(await togetherChat({
        model:      Q_CONFIG.visionModel,
        max_tokens: 1000,
        messages: [{
            role: 'user',
            content: [
                { type: 'text',      text: BILL_PROMPT },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            ],
        }],
    }));
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


// ── Spending graphs ───────────────────────────────────────────────

function getSpendingGraphData(email) {
    const txns      = getTransactions(email);
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
