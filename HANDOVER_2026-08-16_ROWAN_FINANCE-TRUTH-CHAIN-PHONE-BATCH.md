# HANDOVER — 16 Aug 2026 (overnight from 15 Aug) — ROWAN — quotem-ai finance: the amount being true, the phone, the batch

**Repo `quotem-ai`, branch `main`, push = Railway (`industrious-contentment`).
Live at handover: `032490e` (contains everything below). Follows Fenn's
`HANDOVER_2026-08-15_FENN_FINANCE-ACCOUNTS-TRUTH.md`. Read `FINANCE_ROADMAP.md`
rows 11–12 for the task-list view.**

Another session shares this working tree and pushes concurrently (study
suite / writer / revise). Commit by path (`git commit --only -- <paths>` or a
private index — see `c322e5f`) and read `git diff --cached` before pushing.

---

## What shipped tonight (in order) — all live, all verified from outside

| Commit | What |
|---|---|
| `7498412` | Credit cards don't double-count (payment to a held card = transfer, coverage-gated; card statements sign-checked; card balance = owed) |
| `a7f4baf` | **Running balance read as 4th CSV column; every row audited against the bank's own step** (`auditRowsByBalanceChain`); chain opening/closing when no front-page totals; per-statement verdict stored on the account (`recordStatement`, `statementGaps`); **balance never moves backwards in time**; **dedupe by bank Transaction ID / running balance** (same-day twins survive) |
| `93eb9bc` | `edgeGaps`: when every link agrees, say the gap is before-first-row / after-last-row; raw reader output kept per import in `finance/reads/` (last 30) |
| `c322e5f` | **"Scan from phone" fixed** — see below, three root causes |
| `7578279` | **Batch**: per-user server-side import queue; desktop + phone hand N files in, one watcher, one line per file |
| `192c6ca` | **Balance lines are not transactions** — phantom detection + set-aside (`phantoms.json`) |
| `73f193c`…`f9aa17b` | Net card → "In minus out" → replaced by **You have / You owe** headline; period line explains balance change |
| `…` | Account card stripped to numbers; charges named + placed; problem cards compact with time |

## The finance facts as of 02:00, 16 Aug

- Store: **1,411** rows. Monzo 1,232 (all linked, all with Transaction IDs); Lloyds Club Lloyds 134 (Jun/Jul/Aug); NatWest 45.
- **Lloyds 1–15 Aug: adds up.** **July: £47 out** = a PHANTOM — the reader turned "Balance on 01 July −999.30" into a −47.00 row (row's balance == printed opening ⇒ not a transaction). Detection + removal shipped in `192c6ca`; **the stored phantom is still in her store until she re-drops July** (saveRows sets it aside on that import). **June: 81p out** — pattern unknown (raw not kept at the time); a re-drop will say (edge gap or break).
- **NatWest**: her file is the "TXN" transaction download — columns Date · Description · Type · Paid in · Paid out. **No balance column, no opening/closing** (verified from the PDF's own text). Cannot self-check. Balance from screenshot (−£496.37) is correct source.
- Headline: spend £22,056 / income £22,027 over 1 Mar–14 Aug; accounts UP ~£2,035 because ~£1,950 net came in as "own money" from pots/accounts not loaded. Explained on the period line now.
- Balances: Monzo £1,872.01 (15 Aug), Lloyds −£1,000.34 (15 Aug, from statement), NatWest −£496.37 (screenshot).

## Laws added tonight (each cost a bug)

9. **A row whose balance didn't move is not a transaction.** Balance lines get read as rows. Arithmetic, not wording, decides.
10. **A balance never moves backwards in time.** Older statement's closing never overwrites a newer balance.
11. **The bank's Transaction ID / running balance is the row's identity.** date+amount+merchant collapses same-day twins.
12. **The bare domain `quotem-ai.co.uk` FAILS TLS.** Anything handed to a phone must be `www.` Old comments said the opposite; they were once true.
13. **Public-by-token routes must be in the auth gate allowlist** (`server/index.js` PUBLIC_PREFIXES): `/doc-drop/`, `/api/doc-drop/by-token/`, `/api/doc-drop/upload/`.
14. **`/api/finance/statement/pdf` returns 202 + a job**; poll `/api/finance/statement/job`. Desktop and phone share `importStatementBase64` / `queueStatementFile` / `watchImportQueue` in finance.html — keep them shared.

## OPEN — start here

1. **Her drop of July + June Lloyds** (batch). Then check the log: `balance line(s) read as transactions, dropped`, `stored row(s) … set aside in phantoms.json`, and June's `statement check detail`. Total spending should fall by £47.
2. **Her yes/no on the three-card design** (asked 02:00, no answer yet):
   - *What's coming in* → warm, big, "£X lands Tuesday (DWP) · at your pace that's 9 days · next money 12 days away".
   - *Advice line from her own numbers* — e.g. "£1,872 in Monzo, £1,006 Lloyds overdraft costing £X/mo — moving £1,006 stops that charge". Facts + arithmetic only (FCA line: never rank debts / "pay this first").
   - *Subscriptions* → Keep · Cut · Cheaper; running "you've cut £X/mo"; list total.
   Do NOT build before her yes — it's product shape.
3. **"Available" — A or B** (asked; unanswered): A = balance + unused overdraft headroom (needs limits: read from statement header / app screenshot); B = one netted figure. Fenn's law 3 says never net — she may still want B stated small.
4. Charges card: the 94 "unnamed" rows are now listed by merchant + account — look at what they actually are (likely mis-sorted). Then decide whether the categoriser needs a fix.
5. Labelling pass (family / own company payees) — still the last mile to "that's my life".
6. Fenn's parked list unchanged (`FINANCE_ROADMAP.md`).

## Verify recipes

- `railway logs -n 3000 | grep "\[finance\]"` — import lines; `railway logs -d -n 3000 <deploymentId>` for earlier containers (`railway deployment list --json --limit 40`).
- `railway ssh ls -t /data/users/<slug>/finance/reads/` then `railway ssh cat <file>` — raw reader output (use PowerShell tool; Git Bash mangles `/data`). Mask names before quoting anything.
- Tests are inline node scripts (scratchpad got wiped once — recreate from the commit messages' check lists if needed).
- `node -c plugins/q-finance.js` + the html-script parse one-liner before every push.

⚠️ Repo pushes to GitHub: no payees, family names, account numbers, balances in files. Aggregates and bank brands only.
