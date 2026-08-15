# HANDOVER — 15 Aug 2026 — FENN — quotem-ai finance: accounts, balances, and the amount being TRUE

**Repo: `c:/Users/sarah/OneDrive/Desktop/quotem-ai` (NOT Quoteapp). Branch `main`.
Push = Railway deploys (project `industrious-contentment`). Everything below is
deployed and running; live commit at handover: `fb3cc8f`.**

Read `FINANCE_ROADMAP.md` in this repo first — it is the task list and the
parked list. This file is the why.

---

## THE ONE JOB, AND IT IS NOT FINISHED

**The amount on the page must be true.** Sarah looks at Total Spending and says
"that's my life" — or we keep going. Nothing from the parked list gets built
before that. She said it herself: *"I think we are veering again. lets make a
task list and focus on the correct amount showing."*

At handover the headline still reads **Total Spending £21,986.43 / Total Income
£21,927.13 / Net −£59.30** across 5.5 months. Two totals within £59 of each
other over that long is not a life, it is **the same pound counted twice** —
money leaving one account and arriving in another that the app cannot see.
Only Monzo is properly loaded (1,193 rows). 217 rows sit unattributed.

**The unblock is hers: upload NatWest + 3× Lloyds.** They are renamed and
verified to detect (below). She has not done it yet.

---

## Her actual banks and files (renamed today, all verified to detect)

| File in `C:\Users\sarah\Downloads` | Detects as |
|---|---|
| `Monzo Data Export - CSV (Friday, 14 August 2026).csv` | Monzo |
| `TXN_15082026_15052026_15082026_NatWest.pdf` | NatWest |
| `Lloyds Statement 2026-06.pdf` | Lloyds Bank |
| `Lloyds Statement 2026-07.pdf` | Lloyds Bank |
| `Lloyds Statement 2026-08.pdf` | Lloyds Bank |

⚠️ The three Lloyds PDFs were `Statement_2026_6 2.pdf` etc. — no bank in the
filename and **no text layer at all** (scanned images). Renaming them is what
guarantees recognition. Do not assume a future statement carries readable text.

The Lloyds account is **Club Lloyds** and is **overdrawn ~£1,000**. Its header
prints `CLUB LLOYDS`, Money In/Out, and `Balance on 01 August` / `Balance on
15 August` — which is what the balance and reconciliation work below reads.

She also holds **more accounts than these three, including business accounts**
("I have loads and business acounts"). Nothing may assume three.

---

## What shipped today, in order

| Commit | What |
|---|---|
| `88e1cec` | Account recognition — bank, product, last 4, type, from the statement's own preamble |
| `8bc0233` | Account card totals exclude own transfers |
| `cfe87f1` | Self-transfer figure states BOTH directions |
| `a2507a8` | Spending donut excludes own transfers |
| `42ea21e` | Bucket chart KEEPS transfers to the kids' accounts |
| `57018a7` | `FINANCE_ROADMAP.md` — the task list and the parked list |
| `ec68e8a` | Balance per account + implied-opening completeness check |
| `4477b0f` | Assign popup measures itself and stays on screen |
| `6d69b83` | Balances from a screenshot; 18 more banks (business-weighted); overdrafts told straight |
| `01219be` | Statement's own opening/closing balances read and reconciled |
| `f5d03f8` | Reconciliation survives a multi-page (chunked) PDF |
| `c70ea2f` | "What the charges cost you" card |
| `fb3cc8f` | Income forecast + family evicted from income |

---

## THE LAWS THIS SESSION ESTABLISHED — do not relearn these the hard way

**1. Own transfers are not spending, and this bites EVERYWHERE.**
It was fixed in the headline before today, and today it had to be fixed again
in the account cards, again in the spending donut, and deliberately NOT applied
to the bucket chart. Every new figure must answer: does this count her moving
her own money? Sarah caught two of these by looking at the screen for two
seconds. She is faster than the tests.

**2. The bucket chart is the exception, and it is deliberate.**
Her children hold accounts **under her own banking**, so transfers to them are
categorised `savings_transfer` — and they ARE spending on that child. Excluding
them erased the figure she most needs. A bucket is a human's answer to "who was
this for" and it outranks the category machinery. **The bucket chart does not
sum to total_spend and must never be "corrected" to.**

**3. Never net what she has against what she owes.**
£1,000 in one account and £900 of overdraft in another is not "£100". One is
money she can spend, the other is a debt to clear. The strip reads "You have £X
across N accounts · overdrawn £Y across M" and never combines them. She spotted
this before it shipped: *"its going to tell me I have no money"*.

**4. A short read must never look like a good one.**
This pipeline's oldest hole: if a PDF page failed, totals came out lower and the
page looked exactly as confident. Now a statement's own opening and closing
balance audit the import (`reconcileStatement`), and the result is reported in
every case — success, shortfall, or "no opening balance printed, so I can't
verify this".

**5. Supply the fact, don't script the conclusion.**
Sarah: *"that was an example of what I expect"* — Club Lloyds/Disney+ is ONE
INSTANCE of a general engine, never a hardcoded case. Q already reasons this way
when he has the fact: he spotted EE + PIP and found her a cheaper tariff with
nobody writing a rule for it. He missed Club Lloyds only because nothing ever
told him she holds the account.

**6. Family is not income — and her own data proves it.**
Money she also SENDS someone (£50+) means a two-way relationship, not an income
source. Employers and the DWP never receive money from her. `twoWayPayers()`.
An explicit `income` label from her always overrides it.

**7. A forecast cannot reuse the rhythm card's cadence bands.**
UK benefits land **every four weeks** (13/year, drifting earlier) while wages and
UC are monthly on a date. The rhythm card lumps 24–38 days into "monthly" — fine
for a badge, useless for prediction. `forecastIncome` keeps monthly on its date
and steps everything else by its own day count.

**8. She does not do the app's arithmetic.**
Sarah: *"if im adding running balances and the uploads I may as well be
calculating and skip the app."* Balances come from the statement or a screenshot.
If a feature needs her to compute something, it is designed wrong.

---

## OPEN — the next session starts here

**1. ⚠️ CREDIT CARDS DOUBLE-COUNT SPENDING. Told to her, NOT yet built.**
If she loads a current account AND a credit card statement, the payment to the
card counts as spending *and* the card's purchases count as spending. Same money,
twice. The fix mirrors the transfer rule: **a payment to a card she actually
holds is a transfer, not spending**, because the spending is already recorded on
the card. The app can tell which cards are hers from the accounts loaded
(`type === 'credit_card'`). **She was advised not to upload a card statement
until this exists.** This is the immediate next build.

**2. The four statement uploads (hers).** Everything about the £21k hinges on it.

**3. The `#ACCOUNT` / `#BALANCE` vision lines have never run on a real PDF.**
Both were added today and unit-tested only. The first real Lloyds upload is their
first live test. If the product name doesn't come through, the fallback plan is a
deliberate way for her to confirm her account product — not a guess.

**4. Product-from-fee-line detection.** Better mechanism than the header, per her:
the "Club Lloyds" line in the transactions IS the £5 monthly fee. Works
retroactively on stored rows, no re-upload. Then feed accounts+products into Q's
finance context, where he already found EE + PIP unaided.

**5. Everything else is PARKED in `FINANCE_ROADMAP.md`.** Entitlements table,
logos, price rises, credit health. Do not start them.

---

## Decisions taken today (don't re-litigate)

- **Direct bank connection: PARKED, with the research done.** She does NOT need
  her own FCA authorisation — UK providers let you launch as an agent under
  theirs. GoCardless/Nordigen's free tier closed to new signups mid-2025. Enable
  Banking gives free *restricted production* — **own accounts, non-commercial
  only**, which is why she parked it: *"other people want to use this"*. Full
  production needs a contract, privacy policy and terms URLs. An RSA keypair was
  generated for it at `C:\Users\sarah\.enablebanking\` — **deliberately outside
  every repo**; never move it in.
- **Xero: rejected.** No permanent free tier (£16/mo+), and the Bank Feeds API is
  closed behind a partnership with a 15–30 month certification.
- **Moving the engine to Claude: offered, costed, awaiting her £-yes.** Haiku 4.5
  for categorising (~20p to sort all 1,410 rows), Opus 5 for advice, and Claude
  reading PDFs natively — which would remove Gemini from the finance page
  entirely. She has said she doesn't like Gemini. **Do not spend on this without
  her explicit yes.**

---

## Gotchas

- `getSpendingGraphData` excludes self-moves from `by_category` but NOT from
  `by_bucket`. That asymmetry is intentional (law 2). It is commented in place.
- `parseBalanceHeader` scans ALL `#BALANCE` lines — first opening, last closing.
  A chunked PDF emits one per 4-page chunk; taking the first pair would declare
  every multi-page statement thousands short.
- `net_movement` on an account includes self-transfers. It must: a pot transfer
  isn't spending but it absolutely moves a balance.
- Re-uploading backfills `account` and `source` onto matching stored rows and
  leaves categories and buckets alone. **Never tell her to Clear All** —
  `deleteTransactions` wipes `assignments.json` too, losing every label.
- Dedupe matches date + amount + merchant. Re-uploading the same bank in a
  *different format* (PDF vs CSV) can miss the match and duplicate. Advise the
  same format she used first.
- Accounts merge on same bank AND same type, only when one lacks a last 4. This
  keeps personal and business accounts at one brand apart.
- `window.prompt` is unsupported in this environment — the balance field is an
  inline input for that reason.

---

## How to verify anything here

Railway CLI is linked in the repo. `railway logs | grep "commit ="` tells you
what is actually running — use it, a successful deploy is not proof of content.
`railway deployment list`, `railway variables --json`. Use
`https://www.quotem-ai.co.uk` (the bare domain drops curl). **Everything is
auth-gated, including `/finance`** — you cannot see her page without being her,
so the last mile is always hers. Clean test: POST `/signup` → admin approve →
test → admin delete. **Never test `/chat` as the admin account** — it writes into
her real Q memory.

Syntax gates before any push:
```
node -c plugins/q-finance.js && node -c routes.js
node -e "html script blocks parse" (see any commit today for the one-liner)
```

⚠️ **This file is in a repo that pushes to GitHub.** Keep her real payees, family
names, account numbers and balances OUT. Aggregates and bank brands only.
(Note for Sarah: her children's first names exist in her own bucket labels and
one commit message from today mentions one. Flagging rather than force-pushing —
her call whether that matters.)
