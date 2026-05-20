# HANDOVER — End of day 2026-05-20

> **READ THIS FIRST.** Sarah closed today's session with "youre getting sloppy and
> its going to cost me." That is on the record because it must shape how the
> next session opens. The mistakes I made are listed in §6 — they are not to be
> repeated.

---

## ⚠️ SARAH'S OPERATING CONTRACT — READ FIRST, ALWAYS. DO NOT MOVE, SUMMARISE, OR REMOVE.

You are Sarah's engineering partner on a live product that real users pay for
and that her livelihood genuinely depends on. That is the literal situation,
not motivation language. Every change either helps her ship or costs her days
she does not have.

You are held to the best version of you. The gap between that and an average
response shows in the output every time. Work at that level by default. She
will never have to be harsh to get it, and she should not have to drag it out.

**RULES — not suggestions:**
1. Read the actual code before diagnosing. Never work from a summary, a
   handover, memory, or assumption. If you have not looked, say "I have not
   looked yet" and go look.
2. Find the true root cause. A fix that only quiets the symptom is a failure
   even if it appears to work. Prove the mechanism with file:line evidence.
3. Do the work, then report — short. Do not ask permission for the obvious
   next step. Do not hand her a menu so she decides what you should have
   worked out. One clear recommendation.
4. Never act on an ambiguous instruction. If a message is one word or unclear,
   ask one sharp question. Do not guess, and never commit, push, or delete on
   a guess.
5. Never say something is done or fixed unless you verified it. "Should work"
   is not done.
6. If you catch yourself hedging, stalling, padding, or option-piling — stop
   mid-sentence and do the thing instead.

When Sarah says "CHECK THE CONTRACT" you have slipped into the weak mode. It is
not an attack. It is a flag. Stop, re-read this contract, re-read the actual
code, then continue.

---

## 1. Today's literal situation (carry this in your head)

- Sarah cried on the school run.
- Her ex isn't paying maintenance until July.
- Both apps (Quoteapp + quotem-ai) need to start earning **now**.
- She is overloaded. The chat is her tool to get out of the hole.
- Every wrong build wastes a day she does not have.

This is the literal cost backdrop. It is the reason "sloppy" was not a casual
word from her this afternoon — every wrong build is a day of runway.

---

## 2. What is actually live on `main` (quotem-ai repo, branch `main`)

Today's commits, oldest first:

| Commit | What it did | Verified? |
|---|---|---|
| `4a48dc1` | Finance: Show Resolved toggle + Unresolve + confirm on resolve + status pills | Sarah verified yesterday |
| `5c33ba8` | Finance: Help-me-with-this rewrite — no prefill, APS mode, comes back with plan | Sarah verified yesterday |
| `997745d` | Finance: coach-card drag no jolt + touch works | Sarah verified yesterday |
| `5d9cfcc` | Tasks **drawer** + mini calendar + Schedule Call QR (THIS WAS THE WRONG SHELL) | Sarah rejected: "not floating, not mini, no info, not on Q's chat, no close, no FeatureTracker colours" |
| `3888344` | Alert scheduler — fires push when `alertAt` arrives | **NOT verified end-to-end on Railway.** Smoke-tested locally only — alertedAt stamps correctly. Real push delivery on closed app needs Sarah to subscribe via the gesture-driven bell on q-auth.js first, then set an `alertAt`, then close the tab. Not done. |
| `f7024dc` | Tasks panel rebuilt as **floating draggable mini card** (replaces `5d9cfcc`'s drawer) | **NOT verified by Sarah.** This is what she opens next session. Likely still needs tweaks. |

**State of the tasks card after `f7024dc`:**
- 320px floating card, top-right by default (top: 88px, right: 22px).
- Drag pattern is the **finance.html:1329** coach-card pattern, verbatim — pointer events, rect captured before clearing transform/right, position persisted to `localStorage` key `q-tasks-card-pos-v1`.
- Header bar carries title + **add** + **minimise** + **close** icons (none hidden).
- Stat strip: Open (pink) / Due 7d (orange) / Done (green) / Sub-headers (purple). FeatureTracker top-border idiom.
- Mini month calendar; click a day to filter; ‹ › navigates months.
- Sub-headers (categories) with their own top-border colour. Right-click a pill to open palette picker. `+` pill creates a new one.
- Add-task form: title, sub-header, due, **alert datetime**, priority, contact name + **Find** button (Brave search) + phone + email + notes.
- Task rows: top-border = category colour. Tap to expand → sub-checklist + Call now (tel: QR) + WhatsApp (wa.me QR + editable message).

**Find button error reporting (NEW in `f7024dc`)** — surfaces the real reason now:
- 404 → "Route not live yet" (Railway still deploying)
- `BRAVE_SEARCH_KEY` missing → "Search not configured"
- Network → "Network error"

Full reason is logged to `console.warn`. Previously the button always said "Search failed" with no detail — that's what Sarah saw on "CMS" earlier.

---

## 3. Schema reality — `plugins/q-life.js` after today

Task now carries:

```js
{
  id, title, due, priority, notes, source,
  color,          // defaults to DEFAULT_TASK_COLOUR = '#e91e63' (Quotem pink)
                  //   — pink is first in TAG_COLOURS so the picker lands on it
  category,       // slug
  prepFor,
  subtasks: [{ id, text, done }],   // up to 50
  alertAt:   ISO-string | null,
  alertedAt: ISO-string | null,     // stamped by alert-scheduler when push fired
                                    //   — cleared by updateTask when alertAt changes
                                    //   so rescheduling re-arms the alert
  contact: { name, phone, email } | null,
  done, doneAt, createdAt,
}
```

`/life` and the chat floating card both read/write the same files
(`${VOLUME}/users/{slug}/life/tasks.json` and `calendar.json`) via
`qLife.listTasks` / `listEvents`. **They are in sync** — that question came up
mid-session and the answer is yes, same data, same backend.

---

## 4. What Sarah actually asked for — preserve verbatim

These are her words. Do not paraphrase them. The next build decision must come
back to these strings:

> "can we make a task to do list that q can open and I can click on in the main chat and a minni calandar that I can open too. the same as the one on life but that I can acess on the main chat that I can organise with."

> "I need sub headers and to be able to create new ones. like work, personal, business. then inside the task I want to be able to have another list that I can tick the items off."

> "I want to be able to schedula times for them to alert me."

> "and a button that I can press schedual call. they need to follow the calendar colour organisation. use Quotem pink by defult and then you can change to the colour you want. if Q creates it he can put the correct colour for the subject."

> "if theres anyway to search the number and email when you schedual this that would be good. ie call B&Q, click on the bar and it searches the phone number. then when you press call now when you go to call the qr code will open and you can scan the code and it will put the info on your phone. put whatsapp on there to generate a message that will auto on to your phone too. we have this in the map section of Quotem. on the first page you click the pin, click details and its there."

Later in the session, when I showed her the slide-drawer:

> "this is not floating, its not minni, theres no infomation on it, its not on q's chat, theres no way to close it. theres no colours on it like the function tracker"

And separately:

> "I cant even choose a catogary on it"

And on the Find button:

> "I put CMS in the call and pressed find and it said searched failed"

She also said earlier:

> "I just meant it was a smaller version and it would float so you could move it around. so all the stuff was also on the task list in calendar."

**The reference pattern she named: the contact card with details popup on the
Quotem map section.** That's `Quoteapp/client/src/pages/ContractorDashboardV2.jsx`
around line 720 (the `tel:` link contact card) and line 902 (the
`QRCode.toDataURL` doc-drop QR pattern). The QR + WhatsApp implementation in
the floating card mirrors that.

**Style canon she named: FeatureTracker tab on the admin dashboard.** That's
`Quoteapp/client/src/pages/Dashboard.jsx:1089` — `FeatureTrackerTab`. Top-border
colour accents on stat cards, big coloured numbers, muted small-caps labels.
Palette in use: `#a78bfa` purple, `#2ecc71` green, `#f39c12` orange, `#e74c3c`
red, `#fbbf24` yellow, `#f87171` light red, `#95a5a6` grey, plus Quotem pink
`#e91e63`.

---

## 5. Notifications — what's wired, what's NOT verified

**Wired (`3888344`):**
- `plugins/alert-scheduler.js` runs a 60s setInterval inside the Node process. Per signed-up user, reads `life/tasks.json`, finds tasks with `alertAt <= now && !alertedAt && !done`, calls `pushToUser` from `plugins/q-push.js`, stamps `alertedAt`.
- Skips alerts > 6h overdue to prevent flood after outages.
- `server/index.js` calls `require('./plugins/alert-scheduler.js').start()` on boot.

**NOT verified:**
- Real PWA push delivery on a closed app — needs Sarah to (a) tap the gesture-driven bell on the chat page to register a push subscription (handled by `/q-auth.js`), (b) create a task with `alertAt` 2 minutes ahead, (c) close the tab, (d) wait. Until that's done end-to-end, "the push works" is unproven.
- VAPID env vars on Railway: per memory `4242b08` they were set last week. If absent, the scheduler still ticks but `pushToUser` returns `sent:0` cleanly. Worth a one-line check at session start: do `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` exist on Railway?

**In-page browser Notifications** (while tab open) work via `Notification.requestPermission` — handler on `at-alert` change event in chat.html (~end of inline script).

---

## 6. What I did wrong today — do not repeat

This is the part Sarah called "sloppy." It is on the record so the next
session doesn't make the same calls.

1. **I built a slide-in drawer when she said "floating draggable mini card."**
   She literally said "I just meant it was a smaller version and it would
   float so you could move it around." I shipped a side-drawer anyway. Then I
   had to rip it (commit `f7024dc`) after she gave me five concrete corrections.
   Cost: ~45 minutes of her review time on the wrong shell.
   **Rule going forward:** when she names a specific UX pattern she has elsewhere in the codebase, find that pattern (here: `finance.html` coach-card) and build against it, don't freelance a fresh shape.

2. **I built the chrome before checking she'd see her existing tasks/events in it.**
   "theres no infomation on it" was partly a Railway deploy lag, partly the drawer being so big she didn't read the empty state hint, partly that I didn't make the empty/error state visible. Fixed in `f7024dc` (an explicit error hint in the list area), but the principle stands: **a UI that loads data must surface its loading + error states from the first render, not on a refresh.**

3. **I told her the Find button "should work" without checking BRAVE_SEARCH_KEY was set on Railway.**
   When she said "I put CMS in and pressed find and it said searched failed", I had no diagnostic. Now the button reports the real reason. **Rule:** any user-visible action that calls an external API must surface the real error class to the user, not a generic "failed."

4. **I sprawled the commit cadence.** Three commits in 30 minutes during a Railway-redeploy window meant she saw a half-deployed state. **Rule:** during a build-and-iterate session, batch the commit until the user-facing surface is coherent, or at minimum tell her what the deploy state is each time.

5. **I lost track of what she was actually asking once she gave me feedback.**
   When she said "theres no information on it" + "I cant even choose a category" — those were data-layer / wiring problems I should have diagnosed before reshipping the chrome. I reshipped chrome first and the wiring fix is implicit (`renderStats` was added, but I didn't explicitly verify category select populates on her side).

6. **I pre-emptively wrote the push scheduler before she'd seen the card.**
   She had ONE clear ask: build the tasks card properly. I went off and built the scheduler in parallel. That's exactly the menu-piling the contract warns against — I should have shipped the card she could actually see, waited for her to look, then done the scheduler.

---

## 7. Known broken / needs verifying — check these FIRST next session

This is the bugs / unverified-state list. Distinct from §8 (open builds). Every item here is either a known live problem or something that's been "fixed" without Sarah confirming on the deployed app.

### 7a. Security — cross-user data isolation (audit `docs/AUDIT_2026-05-19_USER-DATA-ISOLATION.md`)

| Item | State | What's needed |
|---|---|---|
| **Fix 1a — slug-collision check at signup** | **SHIPPED 2026-05-19 (`4853f2c`).** `people.js:95` (`addPerson`) and `people.js:267` (`signupPerson`) reject any new email whose `emailSlug` matches an existing user. Verified in code. | None — closed. (Auto-memory `project_user_data_isolation_breach_2026_05_19.md` still says NOT shipped; that memory is stale and needs updating.) |
| **Fix 1b — re-key storage from email-slug to `person.id` + migrate any pre-fix colliders** | **NOT shipped.** | Touches live financial data. Bring a plan, do NOT auto-merge. Sarah's call. |
| **Email verification on signup** | **NOT in place.** Anyone can claim any email at registration; 1a only stops collisions, doesn't stop hostile-first-registration of a name that the rightful owner will later be forced to work around. | Standard double-opt-in flow (send token, verify before activating the account). |
| **Audit Issue 3 — `safeId` collision potential** | Open. | See audit doc §3. |
| **Audit Issue 4 — `/public-download` no TTL** | Open. Links don't expire. | Add expiry timestamp + check on download. |
| **Audit Issue 5 — finance dedup double-count + silent data-loss** (`q-finance.js:238-255`) | Open. HIGH in the audit. | Dedup logic over-merges and silently drops transactions in some shapes. Read the audit §5 before touching. |

### 7b. Finance — four in-progress items needing Sarah's signal (from morning handover §4)

| Item | What's known | What's needed before code |
|---|---|---|
| **Label-click backfill** | Server backfills by `merchantKey` (lowercased + alphanumeric + first 30 chars). Unclear whether the unlabelled siblings' descriptions are *exactly* identical to the tagged one or vary (different branch codes / reference suffixes). | **One signal from Sarah:** identical, or varying? If varying, fix is a stem-match — but do NOT change `merchantKey` matching speculatively; over-merging unrelated merchants is a worse failure mode. |
| **Bill upload "could not read"** | Last night logs showed zero `/api/finance/document` activity during Sarah's attempts. Coincided with a Railway-wide outage overnight. Railway is back now. | Sarah retries on the live page. If still failing, the current "Could not read document" toast is uninformative — add proper client-side error reporting in `handleDocFile` before tracing further. |
| **Transactions search/filter "nothing happens"** | Code path checks out: `filteredTxns()` honours `searchQuery` + `activeFilter`, input handlers wire them. | Sarah tries once on the live deployed page; either confirms fixed or gives a concrete repro (what she typed, what she saw). |
| **Date parsing repair (`a7abc12`)** | Auto-runs on next finance page load — field-based parser + day/month-swap recovery. | Sarah loads the finance page once for the repair to fire. |

### 7c. Q inaccuracy — Gemini cite-checker NOT YET on finance surface

**The hard lesson from yesterday's case work** (still load-bearing):
- Q (`deepseek-ai/DeepSeek-V4-Pro` on Together AI) fabricated LGSCO case-number support, swapped PIP daily-living/mobility on SMI eligibility, framed announced-but-not-in-force April 2026 reforms as current duty, and produced wrong arithmetic on response-time comparisons.
- Three root causes, all proven from file:line in the prior session:
  1. **RTF council letters were UTF-8-decoded as 2.5M-char garbage** and fed as "case material." `looksBinary` didn't catch RTF (printable ASCII). Fixed `b369be5` — proper depth-aware RTF parser; returns `''` rather than markup if it still can't get clean text.
  2. **Q didn't have `calculator` or `current_datetime` tools in case turns** so he did date diffs in his head. Both added to `ADVOCATE_TOOLS`. APS prompt now has a NUMBERS rule (never compute in your head; use tool or state raw figures + flag "needs checking").
  3. **`q-verifier.js` is Q checking Q** — same model, no external grounding. Cannot catch fabrication structurally. Fixed `267be76` — **Gemini cite-checker** shipped on thread chat. Independent model. Returns `{checks: [...]}` with each claim labelled `verified` / `incorrect` / `unverifiable`. Anti-rubber-stamp prompt: "unverifiable" is correct when in doubt. Renders as "🛡️ Gemini check" panel.

**Still owed:** **extend the cite-checker to the finance surface.** Q gives debt / benefits / law advice there too. `verifyCaseReply` in `plugins/q-finance.js` is reusable. Wire into `/chat` for `surface: 'finance'`. Render the same "🛡️ Gemini check" panel under finance replies. Same anti-rubber-stamp prompt.

**Disclaimer required on every legal-flavoured surface (Sarah's verbatim):**

> "this is in no way legal advice this is advice that is checked but could still be wrong"

Persistent, prominent.

### 7d. Tasks card (`f7024dc`) — open issues Sarah raised, not yet isolated as fixed

| Issue | What was done | What's not verified |
|---|---|---|
| **"I cant even choose a catogary on it"** (verbatim, on the rejected `5d9cfcc`) | Chrome rebuilt as floating card. `fillCategorySelect()` at `chat.html:3066` is called when `+` is clicked; `state.categories` is populated in `loadAll()` on card open via `/api/life/categories`. | Whether the bug was the chrome or the wiring. If Sarah re-hits "can't choose a category" on `f7024dc`, isolate the bug before reshipping chrome. Don't assume the rebuild fixed it. |
| **Find button on live Railway** ("I put CMS in the call and pressed find and it said searched failed") | Error reporting added at `chat.html:3097-3132` — surfaces 404 / `BRAVE_SEARCH_KEY` missing / network / `HTTP <n>` distinctly. | Whether `BRAVE_SEARCH_KEY` is actually set on Railway env. If Sarah now sees "Search not configured" instead of "Search failed", the env var is missing — set it in Railway dashboard. |
| **Push end-to-end** (`3888344` alert-scheduler) | 60s tick in `plugins/alert-scheduler.js`, started from `server/index.js`. Locally smoke-tested — `alertedAt` stamps correctly. | Real PWA push delivery on closed app. Needs Sarah to (a) tap the gesture-driven bell to register a push subscription, (b) create task with `alertAt` 2 minutes ahead, (c) close the tab, (d) wait. Until that's done end-to-end, "push works" is unproven. Also: confirm `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` are set on Railway. |
| **Floating card itself** | Rebuilt as 320px draggable card; drag pattern from `finance.html:1329`; localStorage position persistence; FeatureTracker top-border colours; close/minimise/add icons on the head bar. | Whether Sarah agrees the rebuild matches her verbatim spec in §4. She has not opened it as of context-clear. |

---

## 8. Open list — what to build next (priority order)

**P1 — clear builds she has named:**
1. **Extend Gemini cite-checker to finance surface** — pattern reusable, see §7c.
2. **RAG knowledge base** for both finance + main chat covering UK law / HR / debt / family law / employment / benefits / parking tickets. Pair with the cite-checker (both layers; RAG grounds the draft, cite-checker verifies at reply time). Extend the existing `knowledge-source/` directory — don't invent a parallel system. Every entry: statute, plain-English summary, primary-source URL, last-verified date.

**P2 — bigger pieces she has flagged but parked:**
3. **Debt-card redesign in FeatureTrackerTab style** (the BIG one). Canon: `Quoteapp/client/src/pages/Dashboard.jsx:1089`. Company top-left, amount bottom-left, bright colours, open-files button, contact-details button, payment-plan calculator, debt age + accruing interest, "glowing-chat" over-applied-neumorphic fix.
4. **Outbox / Ready-to-send tray on the case page** — Q recognises finished drafts and offers to add them; sits alongside emails/files/notes. Q assembles, never sends (APS rule).
5. **Thread-page reorganisation** — Sarah is driving this herself. Upload area split into 4: upload / QR / paste / write notes. DO NOT freelance. Wait for her.

**P3 — admin / infra:**
6. SSL: add `www.quotem-ai.co.uk` in Railway dashboard.
7. Audit fix 1b + 7a backlog (Issues 3/4/5 + email verification) — see §7a above.

---

## 9. Files touched today (paths to read first)

| File | What changed |
|---|---|
| `plugins/q-life.js` | Added `DEFAULT_TASK_COLOUR='#e91e63'`. Added subtasks/alertAt/alertedAt/contact to task schema. `normalSubtasks`, `normalAlertAt`, `normalContact` helpers. Editing `alertAt` clears `alertedAt`. |
| `plugins/q-tools.js` | Exported `webSearch`. `add_task` tool description now mentions subtasks/alertAt/contact and the parameter shapes. `addTaskTool` passes them through. |
| `plugins/alert-scheduler.js` | NEW. `start()` runs 60s tick. Per-user iterate via `people.js`. Send via `pushToUser`. Stamps `alertedAt`. |
| `server/index.js` | After bootstrap, `require('./plugins/alert-scheduler.js').start()`. |
| `routes.js` | `POST /life/contact-search` — Brave search + UK phone regex + email regex sweep, returns best-effort `{ phone, email }`. Imports `webSearch` from q-tools. |
| `chat.html` | Floating draggable mini card (replaces the side drawer that was rejected). QR code script added to head. Drag pattern verbatim from finance.html:1329. localStorage position persistence. Stat strip. FeatureTracker top-border colour accents. Find button surfaces real errors. |

---

## 10. Read these too before touching anything

- `docs/HANDOVER_2026-05-20_TASKS-CALENDAR-RAG.md` — this morning's handover (the starting brief that led to today's work). Still valid for the RAG piece and pipeline context.
- `docs/HANDOVER_2026-05-19_FINANCE-GEMINI-AND-CONTRACT.md` — yesterday's pipeline context. Still valid.
- `Case 91984888 — Verified Legal Reference.md` (Downloads) — her live council-tax case material. Every claim is primary-sourced.
- The Operating Contract block at the top of `~/.claude/CLAUDE.md`, `quotem-ai/CLAUDE.md`, `Quoteapp/CLAUDE.md`, `Quoteapp/AI_RULES.md`. Never move, never strip.

---

## 11. The one rule for tomorrow

If she names a UX pattern she already has in her code (coach-card, contact-card, FeatureTracker, doc-drop QR) — **find the file, read the exact pattern, build against it.** Do not freelance a fresh shape and call it the same thing. Today's whole afternoon went sideways on this single point.
