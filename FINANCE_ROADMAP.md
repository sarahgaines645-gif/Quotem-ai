# THE FINANCE ROADMAP — Q as an actual financial advisor

**Written 15 Aug 2026 (Fenn), from Sarah's brief.** Read this before touching
the finance page. It is the plan, in order, with the reasoning kept in.

---

## The thesis, in Sarah's words

> "I want it to recognise subscriptions and money saving options, help with
> debt, make everything that people like me — ADHD, unorganised — struggle
> with... I want them to be able to get back in the game. We put things off and
> we pay charges and that keeps these big businesses ticking."

And the feature that proves it:

> "I have a Club Lloyds account. If I was a financial advisor I'd say — did you
> know you get benefits with that? Have you got them? Here's how we get them.
> Because obviously I've had it for years and never got them, and yet I pay for
> Disney every month, which IS the benefit."

That is the whole product in one example. Not a budgeting app — an advisor that
knows the products, checks whether you're actually getting what you pay for, and
tells you the specific thing to do.

**Design law that follows from it:** every card must answer *"and what do I do
about it?"*. A number with no action is decoration. The user is a person who
puts things off — so the action has to be one press, or a script they can read
down a phone, not "consider reviewing your subscriptions".

---

## PHASE 0 — ACCURACY (do first; nothing else is worth building on a lie)

The page currently tells the truth about self-transfers but is still blind in
four places.

**0.1 Accounts, not filenames.**
`source` is whatever the file was called ([q-finance.js:482](plugins/q-finance.js#L482)).
The app cannot say "this left your Halifax". Fix: recognise the bank at import
from header signature + filename + the transaction fingerprints, store a real
account record (bank, product if detectable, last 4 if visible), and show
accounts as cards on the page. **Everything below depends on this.** Sarah
should not re-upload until it lands, or she'll do it twice.

**0.2 What lateness cost you.**
`fees_charges` is a category the categoriser assigns and **nothing on the page
ever shows**. That is her thesis, unbuilt. A headline card: every fee, overdraft
charge, late-payment charge and interest line, totalled, each with what to do
about it.

**0.3 Real logos, no leak.**
Merchants render as coloured monograms ([finance.html:246](finance.html#L246))
because the usual logo services mean posting your merchant list to a third
party. Third option: bundle **simple-icons** (CC0) into the app, match locally,
monogram fallback. Real logos, zero calls out.

**0.4 One destination for bank data.**
`getAdvice` posts the finance summary to Together/DeepSeek-V4-Pro
([q-finance.js:1395](plugins/q-finance.js#L1395)) while every other finance path
is Gemini-only for GDPR. Move advice to Gemini so "your bank data only ever goes
to one place" is a true sentence — it will need to be true in writing if this is
ever sold.

**0.5 Labelling the last of the noise.**
Payments to family and to her own company still count as living costs. Not a
bug — a labelling job. Make it one press per payee, applied retroactively.

---

## PHASE 1 — THE ADVISOR THAT KNOWS THE PRODUCTS

This is the Club Lloyds feature, generalised. Three parts:

**1.1 Product recognition.** Detect the account product from the statement's own
evidence — the monthly fee line is the fingerprint. A £5/month "Club Lloyds"
line, a £17 Santander Edge Explorer fee, a £18 Nationwide FlexPlus fee: each one
names the product.

**1.2 A benefits knowledge base.** A local, dated, sourced table of UK account
products → what they entitle you to → how to claim it. Seeded from verified
sources, each entry carrying its source URL and the date it was checked, so it
can be re-verified rather than trusted. Verified 15 Aug 2026:

- **Club Lloyds** — one lifestyle benefit chosen per year: 12 months Disney+
  (Standard with Ads), or six ODEON/Vue cinema tickets, or Coffee Club +
  Gourmet Society membership, or a magazine subscription. £5/month account fee,
  refunded any month you pay in £2,000+.
  ([Lloyds](https://www.lloydsbank.com/current-accounts/club-lifestyle-benefits.html))
- **Halifax Ultimate Reward** — worldwide multi-trip travel insurance, breakdown
  cover, mobile phone insurance, home emergency cover, monthly Rewards Extra.
  ([Halifax](https://www.halifax.co.uk/bankaccounts/current-accounts/ultimate-reward-current-account.html))
- **Nationwide FlexPlus** — travel insurance, mobile phone insurance, breakdown
  cover, £18/month.
  ([Which?](https://www.which.co.uk/money/banking/bank-accounts/best-bank-accounts/best-packaged-bank-accounts-a40ir8R79BKi))
- **Santander Edge Explorer** — £17/month: worldwide family travel insurance,
  mobile phone insurance, breakdown cover, 24/7 remote GP, 1% cashback on
  household bills (£10 cap) and on supermarket/fuel/transport (£10 cap).
  ([Moneyfacts](https://moneyfactscompare.co.uk/news/banking/santander-launches-edge-explorer-packaged-bank-account/))

**1.3 The cross-check — this is the magic.** Match entitlements against what
she is actually paying for:

> **You're paying twice.** Your Club Lloyds account includes Disney+ as its
> lifestyle benefit, and you're also paying Disney+ £X/month from the same
> account. Claiming it at clublloyds.com stops that charge. **£X/month, £Y/year.**

Same shape for: phone insurance she pays separately while her packaged account
already covers it; breakdown cover bought twice; travel insurance on a holiday
booking when the account includes it. This is the highest-value feature in the
document and it is entirely computable from data she already has.

**1.4 The reverse check — is the account worth its fee?** If she pays £17/month
for a packaged account and claims none of it, that's £204/year to say out loud.
Honest in both directions.

---

## PHASE 2 — SUBSCRIPTION TRUTH

**2.1 Price rises.** A subscription currently shows its latest amount only
([q-finance.js:1445](plugins/q-finance.js#L1445)). Nothing notices £9.99 →
£14.99. Track each merchant's amount history and flag the increase with its
date and the annual cost of the rise.

**2.2 Duplicates and overlaps.** Two music services, two cloud storage plans,
a gym paid alongside a leisure-centre direct debit.

**2.3 Trial→paid transitions.** A small first charge followed by a bigger
recurring one is the classic "free trial you forgot".

**2.4 Zombie payments.** Paying for something with no matching activity — the
honest version, flagged as a question ("still using this?"), never asserted.

---

## PHASE 3 — ENTITLEMENTS AND WHAT'S OWED TO HER

Money that is available and unclaimed, checked against the real data:

- Social broadband and mobile tariffs (means-tested, providers publish them)
- Warm Home Discount
- Council Tax Reduction and single-person discount
- Benefit entitlement signposting where the income data suggests a gap
- Priority vs non-priority debt ordering — which arrears actually cost you your
  home or your energy supply, and which are just noisy

Every entry carries its official source link and its check date. Nothing in this
phase gets asserted from model memory.

---

## PHASE 4 — CREDIT

Sarah: *"if we could get credit score on there too that would be a real tool."*
Agreed — and here is the honest state of it.

**What is not available now:** a real score needs a credit reference agency
(Experian, Equifax, TransUnion). They sell API access to businesses; consumer
"free score" products are ad-funded and don't expose an API for a third-party
app to resell. Access requires a commercial agreement and passing their
onboarding, and the activity sits inside FCA-regulated territory — CRAs are
FCA-regulated and credit information services is a regulated activity.
([Equifax developer](https://developer.equifax.com/products/apiproducts/credit-scores-credit-score-coach),
[FCA/CRA background](https://www.nimblefins.co.uk/uk-credit-reference-agencies-explained))

**What IS buildable now, with no regulator involved — "credit health from your
own statements":**

- Missed or returned direct debits (the bank labels them; they are visible)
- Overdraft usage: how many days per month in it, what it cost
- Payment reliability: which commitments went out on time, every month
- Arrears signals: partial payments, repeated small payments to one creditor

That is most of what actually *moves* a score, derived from data she already
has, with no CRA, no FCA permission, and no third party. **Recommendation: build
this, call it what it is — "your credit health, from your own statements" — and
never call it a score.** Revisit a real CRA integration only if this becomes a
funded product.

---

## THE LINE WE DO NOT CROSS (read before Phase 3)

Debt counselling is an FCA-regulated activity: giving advice to someone about
the liquidation of a debt. The boundary is not "did we say the word advice" —
the FCA's test is whether a communication goes beyond providing information and
is objectively likely to influence the debtor's decision, explicitly or
implicitly steering them to a course of action.
([FCA PERG 17](https://handbook.fca.org.uk/handbook/perg17),
[FCA CONC 8](https://handbook.fca.org.uk/handbook/conc8))

**What that means for how we build:**

- ✅ "You paid £312 in overdraft charges over five months." — fact
- ✅ "Club Lloyds includes Disney+. Here's the official page to claim it." — fact + signpost
- ✅ "Free debt advice: StepChange, National Debtline, Citizens Advice." — signpost
- ❌ "Pay this one off first and ignore that letter." — regulated advice
- ❌ Anything that ranks *her debts* into a repayment plan

This does not weaken the product. The strongest thing it can do is show a person
the true picture and the specific official door to knock on — which nobody
currently does well. Q's tone can stay warm and direct; what it must not do is
tell someone what to do about a debt.

**Practical rule for prompts:** Q may state facts from the data and quote
published entitlements with sources. On anything touching debt liquidation, Q
surfaces the facts and the free-advice routes, and stops there.

---

## ORDER OF WORK

### ⚠️ ONE JOB ONLY: THE AMOUNT ON THE PAGE IS CORRECT

Nothing below the line gets built until Sarah looks at Total Spending and
says "yes, that's my life". Everything else is a bell on a broken clock.

**Sarah's banks: Monzo (CSV export), NatWest (PDF), Lloyds (PDF ×3).**

| # | Task | Whose | Status |
|---|------|-------|--------|
| 1 | Account recognition — bank/product/last4 per statement | Fenn | ✅ shipped 15 Aug (`88e1cec`) |
| 2 | Account card totals exclude own transfers | Fenn | ✅ shipped (`8bc0233`) |
| 3 | Self-transfer figure states both directions | Fenn | ✅ shipped (`cfe87f1`) |
| 4 | Spending donut excludes own transfers | Fenn | ✅ shipped (`a2507a8`) |
| 5 | Bucket chart KEEPS transfers to the kids' accounts | Fenn | ✅ shipped (`42ea21e`) |
| 6 | **Upload NatWest + 3× Lloyds** — pairing needs both halves of every transfer | Sarah | ⬜ |
| 7 | **Balance check**: is Monzo up exactly £2,072.09 since 1 Mar? | Sarah | ⬜ |
| 8 | **Balance on the account card** + completeness check (opening + transactions = closing; say so loudly when it doesn't) | Fenn | ⬜ |
| 9 | Re-read the totals together. Do they match her life? | Both | ⬜ |
| 10 | Label family payments + own company (~£6.5k currently counted as living costs) | Sarah | ⬜ |
| 11 | **Credit cards don't double-count** — a payment to a card she holds is a transfer (only for dates the card's rows cover); "payment received" on the card is never income; card statements read purchases as money OUT (checked against the statement's own payment lines / balances); a card's balance is a debt, shown as "owe", never in "You have" | Rowan | ✅ shipped 15 Aug |

**Why 6 matters most:** a transfer is only recognised when the app can see
BOTH halves. Monzo is fully loaded; the other two banks are 217 rows, almost
all credits. So money leaving Monzo for an invisible bank counts as SPENDING,
and money arriving from it counts as INCOME. Spending £21,986 and income
£21,927 — within £59 of each other across five and a half months — is the
signature of exactly that: the same pound counted twice.

**Why 8 matters:** nothing currently checks whether a statement was read in
FULL. The PDF reader already logs failed pages. If a page drops, the totals
come out lower and the page looks just as confident. A balance reconciliation
is the only real test that the money adds up.

---

### PARKED until the amount is right

Do not start these. They are good and they are not now.

| What | Where it's specified |
|------|----------------------|
| Product-from-fee-line detection → Q's context | Phase 1.1–1.3 above |
| The entitlements table (Club Lloyds, FlexPlus, Edge Explorer…) | Phase 1.2 |
| "What lateness cost you" — the charges card | Phase 0.2 |
| Real logos (bundled simple-icons, no leak) | Phase 0.3 |
| Subscription price rises + duplicates | Phase 2 |
| Entitlements / social tariffs | Phase 3 |
| Credit health from her own statements | Phase 4 |
| Moving the engine to Claude (Haiku sorting, Opus advice, Claude reads PDFs) | Awaiting her £-yes |

⚠️ Sarah, 15 Aug: *"that was an example of what I expect"* — Club Lloyds and
Disney+ are ONE INSTANCE of a general engine. Never hardcode her example.
Q already does this reasoning unprompted when he has the fact (he spotted EE
+ PIP and found a cheaper tariff himself). He missed Club Lloyds because
nobody told him she holds the account. **Supply the fact; don't script the
conclusion.**

---

## HOW TO VERIFY ANY OF THIS

Railway CLI is linked in the repo (project `industrious-contentment`).
`railway logs`, `railway variables --json`, `railway deployment list`. Push to
`main` deploys. Use `https://www.quotem-ai.co.uk` — the bare domain drops curl.
Clean test: POST `/signup` → admin approve → test → admin delete. **Never test
`/chat` as the admin account** — it writes into Sarah's real Q memory.

⚠️ This file is in a repo that pushes to GitHub. Keep real payees, family names,
account numbers and balances OUT of it. Aggregates and product names only.
