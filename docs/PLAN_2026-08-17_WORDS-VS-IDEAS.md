# PLAN — "Q is looking for those exact words, and the exact words don't have to be used"

*Sarah's sister, 17 Aug 2026, using the writer for real coursework.*

**Sarah's spec, 17 Aug:** *"the words are still there and will go green when
you've used a word that will cover it."*

So: the word board stays exactly as it is. What changes is what turns a word
green — **covering the idea**, in whatever words she used, instead of typing
that word. This is a plan, not a change; nothing here has been built.

---

## 1. The mechanism, and the good news

`termSeen` decides whether a word looks "used", and it is a raw substring test:

```js
// writer.html:4050
function termSeen(cid, term, text) {
  return (text != null ? text : partText(cid)).includes(String(term).toLowerCase());
}
```

It is worse than "exact words" — it is exact *characters*. No word boundaries,
no endings:

- **False positive** — `skill` is found inside *de**skill**ing*, *up**skill**ing*
- **False negative** — `motivate` is not found in *motivation*; `deskill` is not
  found in *deskilling*
- **Blind to her wording entirely** — she can argue the whole idea and the board
  still lists the word under **"Still to use"** ([writer.html:4158](../writer.html))

**The good news: the plumbing for what you want already exists.** Green comes
from `state.termsFit`, which the server fills from `termsUsed`:

```
probe/mark returns termsUsed  →  noteExpectations()  →  t.termsFit
                                 (routes.js:1373-1380)      ↓
                                                      green button
```

And `termsUsed` is *already* defined as a judgement about the idea, not the
letters ([q-writer.js:595](../plugins/q-writer.js)):

> "the ones her NEW writing uses correctly — **the idea behind the word is
> actually there**, in a sentence that says something"

So Q is already reading for meaning. Nothing needs to be added to the pipeline.

---

## 2. Why it still behaves literally

One word in that description: **"uses"**.

> "Of the EXPECTED TERMS listed, the ones her NEW writing **uses** correctly…"

A model reading that reasonably concludes the term has to appear for her to
"use" it. The parenthetical about the idea then reads as an extra condition —
*the word is there **and** the idea is behind it* — rather than as the whole
test. So `termsUsed` comes back holding only words she literally typed, green
only lights for those, and everything else sits in "Still to use".

**The fix is to say what it actually means: covered, not used.**

---

## 3. The plan

### Phase 1 — `termsUsed` means COVERED  ← this is the fix

Change the schema wording everywhere it is defined
([q-writer.js:595](../plugins/q-writer.js), [:747](../plugins/q-writer.js),
[:854](../plugins/q-writer.js)) so there is no ambiguity left. Something like:

> Of the EXPECTED TERMS listed, the ones this part of her writing **covers** —
> the idea is on the page and doing work in a sentence that says something.
> **It does not matter whether she used that word.** Her own wording,
> a synonym, or a plain-English explanation all count: if a marker reading
> this would credit the point the term stands for, list the term.
> A word dropped in as a bare label with no idea behind it does NOT count.

That last line matters — it keeps the existing `termsMisused` behaviour, which
is the opposite failure and worth keeping.

Nothing else in the chain changes. `noteExpectations` already unions
`termsUsed` into `termsFit`; the button already goes green off `termsFit`.
**Phase 1 is a prompt change, not a build.**

### Phase 2 — "Still to use" follows green

[writer.html:4158](../writer.html) builds that list from `!isFit && !seen`,
where `seen` is the substring test. Once green means covered, the list should
be **`!isFit`** only. A word she has covered must never appear as a debt.

Also worth renaming on screen: *"Still to use"* → *"Still to cover"*, and
*"Every expected word is in"* → *"Everything's covered"*. The words on the
board become **what the marker is looking for**, not a checklist of strings to
type.

### Phase 3 — stop `termSeen` lying

It has to stay instant while she types, so keep it client-side, but make it a
**hint only** and less wrong:

- match on **word boundaries** instead of substrings — kills `skill` inside
  *deskilling*
- fold simple endings (`-s -es -ing -ed -ion -ation`) so *deskilling* matches
  `deskill` and *motivation* matches `motivate`

After Phase 2 it no longer decides anything on its own — it only drives the
pressed-in `.seen` look between her typing a word and Q next reading the page.

### Phase 4 — check the score and the dots

Make sure the same literalism has not leaked into the two places carrying real
weight: the **match score** (`matchScore`) and the **requirement dots**
(`reqMet`). Neither should move on wording. Where they do, they inherit Phase 1.

---

## 4. The one thing to keep an eye on

Sometimes naming the term *is* the mark — a criterion that says "apply relevant
theory" often wants the theory named so the marker can tick it. Q was right this
morning when he told Sarah *"you describe skills being stripped away by
monitoring, but never name it."*

That does **not** need a state on the button, and it must not turn the board red
again. It belongs where Q is already talking: if the brief demands the term be
named, he says so once, in the coaching line, with the reason —

> "You've made this argument, so it's green. The marker wants it labelled
> though — drop *neo-Taylorism* in front of your picking example and it counts."

Green for covering it, a word from Q about naming it. Never a list of words she
has already argued, presented as things she has failed to do.

---

## 5. How to test without spending on the model

1. `termSeen` word-boundary + endings as a table — *skill / deskilling /
   upskilling / motivate / motivation* — same shape as
   `scratchpad/classify-test.js` (17 Aug), which pulls the real function out of
   the page and runs it.
2. Stub a probe response with `termsUsed: ['neo-Taylorism']` where that string
   is **absent** from the page ⇒ the button is green and "Still to cover" does
   not contain it.
3. Stub `termsMisused` ⇒ still comes off green. The opposite failure must
   survive the change.

Only the quality of the coverage judgement needs a live call, and it rides on a
call that already happens.

---

## 6. Cost

**Nil.** No new model call anywhere. Phase 1 is wording in three schema
descriptions; Phases 2–4 are local code.

---

## 7. Do not do these

- **Do not remove the words from the board.** They stay — they are what the
  marker is looking for. Only what turns them green changes.
- **Do not build a synonym list in the client.** The same instinct produced the
  Auto cite bug on 17 Aug, where one shared word ("skill") let a
  sports-psychology paper through as a citation for a sentence about AI
  deskilling. Word overlap cannot tell meaning, in either direction. Q is
  already making the judgement — use it.
- **Do not let a covered word ever read as missing.** That is the whole
  complaint.
