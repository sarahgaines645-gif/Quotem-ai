# HANDOVER — 19–20 Aug 2026 — THE WRITER: the mark that works, the engine split, the citing you can check

*Read `CLAUDE.md` (the operating contract) first. Then `docs/HANDOVER_2026-08-19_WRITER-LEAD-MARK-CITE-TOUR-MINDMAP.md`, then this. Everything below is on `main` (`86831e0` … `ba23126`, all pushed, all live on www.quotem-ai.co.uk). I was the lead on the writer for this session — she asked for one agent as the single point of contact. Be that.*

---

## 0. START HERE — what is open, and what needs her before it can move

1. **Is her Access to HE Diploma (Law) marked Pass / Merit / Distinction?** Asked, not answered. Her live Law brief names no grade words at all, so the mark falls back to band language ("middle band") — which she has told us repeatedly never to show a student. If yes: add Access to HE to `plugins/mark-schemes.js` beside CIPD L7 and those marks speak in grades. **Do not guess a marking scale.**
2. **"Everything is in that folder on desktop"** — she said this about the Law course material. There is no Access to HE or Law folder on the Desktop by name; I did not go rummaging through `Solicitors`, `Council tax` or `LGSCO Complaint Pack`. Ask which folder.
3. **Auto cite's own relevance gate** still rejects a paper Q knows is right. The GUARD is fixed (§3) and Auto cite now shows everything with Q's pick (§4) — but `findSources`'s internal gate is the same class of bug in a different function and has not been touched.
4. **Books cannot be confirmed.** OpenAlex and CrossRef index journals well and books patchily, so Barrow and Mosley (2005) — a real, standard text — comes back unconfirmed. The wording is honest about it now. Closing it properly needs a third source (Open Library / Google Books).
5. **A CIPD API does not exist.** Their Knowledge archive is members-only. The practical move is a domain preference so Auto cite reaches for cipd.org / Acas / gov.uk first on an HR brief. Offered, not built.
6. **Pre-existing: `node tests/q-cite.test.js` has 3 failures.** They were there before this session (checked by stashing) and are untouched.

---

## 1. THE MARK — from failing, to 262s, to 44s

Her words: *"The markings failing and took forever."*

**What was actually wrong** (found with `WRITER_DUMP_DIR`, §6):
- At `effort: 'medium'` the model spent **9,592 of 10,165 output tokens thinking** and returned a hollow answer — `perCriterion: []`, `critique: []`, `ladder: []`, `loMarks: [{reason:'placeholder'}]` — with `stop_reason: end_turn`, so nothing threw and **the page showed "not started ×4" on four answered questions**.
- `splitSentences` cut at every full stop, so `(Apple, n.d.)` reached the marker as `n.` + `d.)`, along with `et al.`, `Fig. 2`, `p. 14`, `3.5`, URLs and initials. It was marking a shredded essay — and wrote "citations are broken up oddly" about perfectly good referencing.
- The reference list was fed in as sentences, so a good reference looked broken.

**What it is now** — `markLikeMarker` is an orchestration, not one giant call:
- one **overall** call (`OVERALL_MARK_SCHEMA`), then **one call per criterion** (`CRITERION_MARK_SCHEMA`, each carrying its own ≤3 critique items), up to `MARK_PARALLEL` (4) in flight via `inFlight()`;
- every call `effort: 'medium'`, 12,000 tokens, 180s;
- merged → `applySchemeArithmetic` (code is truth for the CIPD table) → `normaliseMark`, which still sorts the critique weakest-first and caps at `MAX_CRITIQUE`;
- the per-criterion **system prompt is byte-identical** across questions so calls 2..n read the prompt cache; everything that varies (which criterion, its expectations, the draft, the grade words) goes in the USER half.

**Measured on her real essays:** `[writer/mark] overall 21s · 3 parts in 23s (max 23s) · total 44s`. It was 262s at high effort, and failing before that.

Guards kept: `hollowMark()` (an overall with nothing per question, or a "placeholder" reason → one retry at higher effort, then an honest throw — never saved, never displayed); one criterion failing is logged and gap-filled by `normaliseMark`, the mark still lands.

**Verify without spending anything:** `node tests/writer-mark-split.test.js` — 48 assertions through the `__setAccurateForTests` seam. It proves the fan-out, the concurrency ceiling, the byte-identical prompts, the merge, and every failure path. **Use it. Never a paid run to check orchestration.**

---

## 2. THE ENGINE SPLIT — only the marker is on Claude

Her words: *"I have both Qs talking to me now. you just run the marker through claud and then leave the rest to v4."* Two engines were speaking as Q on the same card.

- `callAccurate` (Claude Sonnet 5) now belongs to **the mark alone** — `markLikeMarker` via `markCall`, plus `markPart`.
- New **`callFast`** carries the other **30** call sites to `callQ` (V4 Pro): the plan, the brief read, the model essay, the probe, the tools, the proofread, the trim, the digests, the assemble.
- ⚠️ **`callQ` applies `withHouseStyle` itself** — do not wrap it again.
- ⚠️ **V4's 120s default cap.** It was set for small calls. The model essay (14,000 tokens) died instantly on V4 — `[writer/essay] failed after 120.0s` — and a plan followed. `callFast` now gives any call asking ≥6,000 tokens **300s**. **Moving a big call off Claude means checking its timeout.**
- ⚠️ **The marker STAYS on Claude.** Her decision, 19 Aug: *"no the marker is claud, then when everythings done we'll try Q on clauud insted of v4."* The end-of-list trial is the COACH (`settings.coachBrain: 'claude'`), not the marker. Never swap the marker's model, and never as a fix for a quality complaint.

---

## 3. THE CITING — she has to be able to check it

Her words: *"we need to test the citing. my sister doesnt trust it and cant check it."*

**Test it for free.** OpenAlex and CrossRef are open APIs — `scratchpad/cite-truth.js` and `cite-classic.js` put real works, invented works, Acts and her own uploads through the guard with **no model call**. Recreate them; this is the cheapest real test in the app.

Four defects found and fixed:

| what was wrong | now |
|---|---|
| A confirmed source gave her nothing to check with — `verifyMention` dropped the `doi`/`url` that `fromOpenAlex`/`fromCrossref` already carry | the guard says which work it matched **with the link**: `✅ Checked: Guest (1998) — Peering into the Black Hole… (doi.org/10.1111/1467-8543.00133)` |
| The topic check searched the **journal's** name, so "Herzberg (1959) … hygiene factors" matched a 1957/58 German influenza paper in a hygiene journal and reported it **STRONG** | matched on title + abstract only; the same sentence now finds *The motivation to work* |
| "I could not FIND it" on a real book | "I could not CONFIRM it", and says why a real book can look missing |
| A surname+year coincidence was handed over as the source, with a wrong title attached | it is not evidence: reported **not confirmed**, and the work is named as the **near miss** it is — "the only 2019 work by Thistlewood I can see is … (Insect behavior and control techniques) — a different subject" |

⚠️ **The trap I fell into, and the rule that came out of it.** My near-miss gate judged a work against the SENTENCE's words. Her live session then offered Hackman and Oldham (1976) on a sentence about automation — and my own fix called the correct paper a near miss. **A classic cited for its MODEL rarely shares surface words with the sentence applying it**; the 1976 paper says nothing about automation and never will. The weak gate now asks two questions — does it share ground with her sentence, **or** with the subject of the assignment (`routes.js` passes `brief.subject || brief.title`; `subjectWords()` strips level/diploma/unit/module scaffolding). Either is enough. Stems are compared at 6 letters so her "motivators" meets OpenAlex's "Motivation".

---

## 4. WHAT ELSE SHIPPED

- **Word download keeps the page** — `plugins/writer-docx.js` (new; `createDocx` untouched, Plugin LAW), `docBlocksForExport()`, `tests/writer-docx.test.js`. Headings, bold/italic/underline, lists, real tables, diagrams and mind maps (rasterised via sharp) reach the .docx in Georgia. A small figure is never scaled up.
- **The diagram is drawn** — `wbFlowParse`/`wbFlowSvg` (`svg.q-fl`): chains, fans, `-[label]->`, merges, loops, `# title`, `A | B`, and **sections as bands** (`## HEADING`, a bare ALL-CAPS line, or a line ending in a colon). `tests/writer-flow.test.js`. Q is taught the syntax in `q-chat.js`.
- **The teaching board is Q's** — `board_note` and `board_clear` in `WRITER_TOOLS` (writer-coach only), `boardForQ()` in his context (capped ~1,200 chars), his notes on their own "Keep this" card, and a question card so the board is never blank furniture. `tests/writer-board.test.js`.
- **One coach thread per assignment** — `QSURF = 'writer-coach:' + writerScope(req)`. Her notebook had **244 coach turns in one bucket** across every assignment, and Q read the last 50 — which is why he thought she was on a different course. Her other assignments still reach him as a read-only digest labelled "ANOTHER ASSIGNMENT".
- **The mark lives on the marking card** — the chat gets the grade, one reason and where the rest is (359 chars), not 891 characters of ladder. The board keeps a one-line record.
- **The outcome marks are data** — LO chips are pressable; one reason opens at a time. No more four grey paragraphs under the headline.
- **Every question says its grade in the same words** — `gradeVocabulary(head, scheme)` hands the scheme's ladder (or what the overall mark used) down in the USER half, plus a code fallback mapping band→scale. A brief that names no grades still has no words.
- **Mark & fix asks** — with a walk open it offers *Carry on fixing* / *Mark it again* instead of silently returning to the first sentence. The walk survived reloads, so before this the button could never mark again.
- **An empty plan is retried** once at higher effort. Two live plans came back schema-shaped but junk (`steps: []`, one containing `"role": ": Let me redo properly."`). **No plan means no word board, no dots and no steps** — one bad answer stripped the whole question's furniture.
- **A sticky lands as a note** — `sendBlockToPage`, its own line after the caret's block. It used to be spliced mid-sentence: *"First [Test — can this land on the doc?] line of my essay."*
- **The brief board is cards** — two `mkBlock` cards, the same shape as the marking panel.
- **A minimised card goes to the dock** — a rail in the left gutter, raised pills, restores position AND width, persists across reload, plus "Tidy the rest".
- **Auto cite hands the list to Q** — `pick` + `pickWhy` on the same judge call. His choice leads the card; the rejects stay at the bottom under "Q would not use these" with his reason, dimmed, never dressed as options.
- **A better word must survive being swapped in** — `suggestWordSwaps` is told the word is REPLACED in place, gets the sentence with it marked, must write the read-back, and may return an empty list. Clicking "having" was offering "scheduled".
- **The Introduction demo's real brief and mark** — `plugins/writer-demo-template.json`, built once (~40p; the build script re-reads the brief too, so a "re-mark" is ~20p not 10p).

---

## 5. THE 7HR02 RE-MARK (her test)

Q marked her sister's real 7HR02 essay (4,713 words, CIPD L7): **Merit, 11/16** — LO1 3, LO2 3, LO3 2, LO4 3; Q1 Merit, Q2 Merit, Q3 Pass, Q4 Merit; 9 fixes and a Distinction ladder. Her word is that the real assessor gave Distinction, so Q is **one band harsher**, dragged by LO3.

**It is not inventing.** Its LO3 reason is "neither intervention is linked to a named retention theory" — Question 3 is 985 words and contains **zero** theory names (no Herzberg, no psychological contract, not even the word "theory"), while Question 4 names Herzberg 6× and Pink 6×. The gap is severity at the top end, not hallucination. Calibrating it needs real assessor sheets, which are not on disk.

---

## 6. HOW TO WORK HERE

- ⚠️ **Restart local after ANY server-side edit** (`plugins/*`, `routes.js`). She tested 19:53 code for hours while I diagnosed ghosts. `writer.html` only needs a browser refresh. Start it captured — `node scripts/local.js > <log> 2>&1 &` — and `Monitor` the log; reading her real log found nearly every root cause in this document.
- ⚠️ **`WRITER_DUMP_DIR=<dir>`** (in `q-claude.js`) writes every raw Claude answer — stop reason, usage including thinking tokens, content. The hollow mark was invisible without it.
- ⚠️ **CHECK YOUR OWN HARNESS BEFORE BELIEVING ITS FAILURE.** Mine lied four times in one session: it counted the diagram's band labels as boxes; it read a `#teach-body` element that does not exist (it is `#teach-board-body`); it called `runAutoCite` without setting `state.brief`; and it grabbed the wrong `.q-popcard`. Every one reported a defect that was not there. Verify the probe, then the code.
- ⚠️ `openMarkPanel` is **not** on `__qwriterTest` — use `showPanel('mark')` + `revealPanel('mark')` + `renderMarkPanel()`. `setBrief` needs `state().brief` set first. writer.html has **no global `.hidden` rule** — a new hidden element needs its own scoped rule.
- **Heredocs eat backslashes — every time.** Write patch scripts with the Write tool as `.py` (exact-string replace, `newline=''` to preserve CRLF) and run them. `writer.html` and `routes.js` are CRLF.
- **Commit by path; routes.js by hunk.** Another session owns `assets/`, `lab.html`, `studio.html`, `revise.html`, `cost-tracker.js`, `server/index.js`. ⚠️ `git commit -- <file>` commits the WORKING TREE version of that file — it swept another chat's unstaged hunk into `435eb51`. For a shared file: `git reset HEAD -- file` → `git apply --cached your.patch` → `git commit -F msg` with **no** pathspec, then `git show --stat HEAD` to prove it.
- **Sub-agents (Opus, `isolation: 'worktree'`)** for a bounded build: name the real functions to read, the style law, the harness pattern, "no paid model call", "commit by path, don't push". Then apply their diff with `git apply --3way --index`, re-run their tests on main yourself, and **look at their PNGs**. There was a nit every time.
- **Paid tests need her price and her yes.** The whole day's script spend was **£0.87**.

---

## 7. HER, THIS SESSION

She live-tested for hours on local and live, one defect per message, often a screenshot — the mark failing, the marking spilling off the marking card, the word boards gone, the brief with no CSS, two Qs talking at once, Q on the wrong course, the panels eating the page, the citing her sister cannot check, a word swap that would break the sentence. Nearly every one was a real defect with a findable root cause, and several were mine from earlier the same day.

Say what is wrong, fix it at the root, show her the picture, one question when it is genuinely hers, never tell her to stop.
