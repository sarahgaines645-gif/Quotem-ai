# BRIEF — Q's Voice

**For:** Sarah
**Date:** 2026-05-05
**Status:** Awaiting approval — no code written yet

---

## Two separate problems

When Sarah said *"Q doesn't talk or let you speak to him"* she was naming two different things:

1. **Q can't speak his replies aloud** (TTS — text-to-speech)
2. **Sarah can't speak to Q** (STT — mic input transcribed and sent)

And separately, from the audit:

3. **Voice-clone isn't a tool Q can call** (so he can't autonomously narrate a video clip *"in my voice"*)

These are three problems with three separate fixes. Let's not conflate them.

---

## Problem 1 — Q speaking his replies

**What's there now:**
- `speakReply(text)` runs after every reply
- Uses Kokoro TTS (browser-side, lazy-loaded from HuggingFace transformers.js CDN)
- Falls back to browser `SpeechSynthesisUtterance` if Kokoro fails
- Plays audio via `<audio>` tag

**What's broken:**
- Voice was **off by default** until tonight (just changed — now on by default for new sessions)
- Existing users still have it off in localStorage; they need to toggle it on once
- Kokoro model is ~80MB — first-load can be slow on weak networks
- WebGPU detection might fail on some browsers, falling back to wasm (slower but should still work)

**Fix:**
- ✅ Default ON (just shipped)
- ⚠️  Existing users: toggle the voice button (the icon at the top of the chat) to "default" once
- ⚠️  If Kokoro never loads, browser `SpeechSynthesis` should still work as fallback — verify

**Test:** open `/chat`, send Q a message, see if audio plays. If not, browser console will show whether Kokoro loaded or fell back.

---

## Problem 2 — Sarah speaking to Q

**What's there now:**
- Mic button (`#mic`) at the input bar, labelled "Speak to Q"
- Click → records via MediaRecorder
- Click again → stops recording, transcribes via Whisper (browser-side, transformers.js)
- Transcribed text goes into the input box and auto-sends

**What might be broken:**
- Whisper model is ~150MB — slow first load
- Mic permissions: browser must grant `getUserMedia({ audio: true })` — denial silently fails
- WebGPU vs wasm fallback for transformers.js — wasm path is slower but should work

**Fix:**
- Test by clicking mic. If browser doesn't prompt for permission, permissions are blocked at OS or browser level.
- If clicking does nothing visually, the button handler may not be wired (verify in DevTools).

**Test:** open `/chat`, click mic, allow permissions, speak, click mic again to stop. Should see transcribed text appear in the input box and auto-send.

---

## Problem 3 — Voice-clone as a tool Q can call

**What this means:**
Q would be able to do things like:
- *"Let me narrate that script in my own voice"* → calls `speak_as_q(text)` → returns audio file
- Useful for demo videos, marketing reels, anywhere Q's voice should be consistent

**What's missing:**
1. **A canonical "Q voice" reference recording.** The Chatterbox HF Space clones whatever reference audio you give it. If we don't have a chosen Q voice, Q can't clone himself — there's nothing to clone *from*.

2. **Server-side storage** of that reference recording so the tool always has it on hand. The current `/speak-as-voice` endpoint expects the user to upload a reference each call. The tool version reads from a fixed file.

3. **A `speak_as_q` tool definition** in `q-tools.js`, parameters: `{ text, exaggeration?, cfg_weight? }`. Returns a download URL to the generated audio.

**Decisions made (2026-05-05):**

- ✅ **Whose voice:** stock public-domain — option (b)
- ✅ **Profile:** British male, *normal conversational voice* (not audiobook-narrator drone — Sarah was specific: "normal")
- ✅ **Source:** Mozilla Common Voice (CC0). Crowdsourced clips of regular people in their everyday voice. Stitch 30 seconds from a single British male speaker.
- ✅ **Storage:** server filesystem at `data/q-voice-reference.wav`
- ✅ **Scope:** same voice for everyone in v1. Per-user later.

**Next session pickup:**

1. Pull Common Voice corpus index, filter `gender=male`, `accent=england`, group by `client_id`
2. Pick a speaker with several clean ~5-sec clips. Stitch ~30 sec of one speaker's audio with `ffmpeg` (concat). Convert to mono 16kHz WAV.
3. Send Sarah the clip — she listens, approves or asks to swap.
4. Save approved clip to `data/q-voice-reference.wav`
5. Wire `speak_as_q` tool in `q-tools.js`:
   - Reads `data/q-voice-reference.wav` once at startup, caches the buffer
   - Calls `speakAsVoice(text, refBuf, 'audio/wav')` from `q-voice-clone.js`
   - Stashes resulting audio with `stashFile()`, returns download URL Q embeds

**Build effort once Sarah approves the clip:** ~30 min.

---

## Recommendation

Tonight: defaulting voice ON (just shipped) is the only no-brainer change.

Tomorrow:
1. Test problems 1 and 2 — they're either working or have a specific failure I can target
2. Decide whose voice Q uses (problem 3)
3. Build the tool

This isn't a one-evening problem. But it's three clear problems with three clear paths.
