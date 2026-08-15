# RETIRED — Voice cloning + Music generation (15 Aug 2026)

Retired from the served app on **15 August 2026** on Sarah's decision. Nothing was
destroyed: every file was `git mv`'d into this folder with its relative path kept,
so it can be diffed, read, or restored later. Sarah's rule: rename/retire, never delete.

## Why

**Voice cloning** — zero consent gating anywhere. `voice-clone.html` advertised
"clone any voice from a 5–15 sec sample", and `/voice-clone/from-url` +
`/q-voice/save-from-url` could clone a voice off **any URL** via `yt-dlp` (YouTube,
podcasts, archive.org…). A voice is biometric data under **UK GDPR Art. 9**; cloning a
third party's voice without consent is also **passing-off** exposure and breaches the
source sites' terms. Not something Sarah can carry in a product she sells. The only
sellable shape is a consent-gated "clone YOUR OWN voice" — see the last section.

**Music generation** — the generated audio carried **no licensing / commercial-use
statement** anywhere in the UI or output. Users could not know what they were allowed
to do with a track. Retired until that is resolved.

## What was moved (full list, relative paths preserved)

Pages
- `voice-clone.html` — the voice-cloning page (paste link / upload / record; "make this Q's voice forever")
- `music.html` — the Music Studio page

Server plugins
- `plugins/q-voice-clone.js` — `speakAsVoice(text, referenceAudio, mimeType, opts)` → Chatterbox HF Space via Gradio API
- `plugins/q-audio-fetch.js` — `fetchAudioClip(url, {startTime})` / `parseStartTime` — spawns `yt-dlp` then `ffmpeg` to pull a ~15 s mono slice from any URL. **Its only caller was voice cloning** (`/voice-clone/from-url`, `/q-voice/save-from-url`), so it is retired with it.
- `plugins/q-music.js` — `generateMusic(prompt, {lyrics, duration, seed})` → ACE-Step HF Space via Gradio API

Hugging Face Space sources
- `voice-cloning-space/` (`README.md`, `app.py`, `requirements.txt`) — the cloning Space (XTTS-v2 / Chatterbox)
- `music-space/` (`README.md`, `app.py`, `requirements.txt`) — the music Space (MusicGen / ACE-Step)

Assets
- `assets/voice-candidates/` (`q-current.mp3`, `1-rp-british.ogg`, `2-coffee-track5.mp3`, `3-coffee-track7.mp3`, `4-coffee-track13.mp3`) — the bundled "Q's own voice" reference clips. Only consumer was `speak_as_q` (`loadQVoiceFor` in `q-tools.js`). They were served publicly under `/assets/voice-candidates/…`; moved here so they no longer are.

## How it was wired (everything that was edited to unhook it)

Routes removed from `routes.js`
- `GET  /voice-clone` (served `voice-clone.html`)
- `POST /voice-clone/from-url` — url + text → yt-dlp/ffmpeg clip → `speakAsVoice` → WAV
- `POST /speak-as-voice` — text + base64 reference audio → `speakAsVoice` → WAV (called by `voice-clone.html` and by chat.html's cloned-voice mode)
- `GET  /q-voice/status`, `POST /q-voice/save-from-upload`, `POST /q-voice/save-from-url`, `POST /q-voice/reset` — per-user "Q's permanent voice" override on the Railway volume (`users/{slug}/q-voice/override.wav`)
- `GET  /music` (served `music.html`), `POST /music/generate`
- top-of-file `require`s of `./plugins/q-voice-clone`, `./plugins/q-music`, `./plugins/q-audio-fetch`
- `GET /voices` (client-side Kokoro voice **picker**, no cloning) was KEPT.

`plugins/q-tools.js`
- removed `require('./q-music')`, `require('./q-voice-clone')`, `require('./user-data')` (only used by the voice override) and `Q_VOICE_DEFAULT`
- removed helpers `_userOverridePath`, `loadQVoiceFor`, `setQVoiceFromBuffer`, `clearQVoice`, `getQVoiceStatus` (+ their `module.exports` entries)
- removed chat tools `generate_music` and `speak_as_q`: TOOL_DEFINITIONS entries, `executeTool` cases, `generateMusicTool` / `speakAsQTool` implementations, and their `TRIGGERS` regexes

`plugins/q-chat.js` — system prompt: dropped "Music generation … voice cloning" from the skills list and the `generate_music` / `speak_as_q` tool bullets.

`config.js` — removed `chatterboxSpaceUrl` (`CHATTERBOX_SPACE_URL`) and `aceStepSpaceUrl` (`ACESTEP_SPACE_URL`).
`.env.example` — removed the two vars (left a note).
`nixpacks.toml` — removed `yt-dlp` and `ffmpeg-full` from `nixPkgs` (their only consumer was `q-audio-fetch.js`; nothing else in the repo shells out to either).
`scripts/deploy-spaces.js` — dropped `voice-cloning-space` and `music-space` from `SPACES`.

UI
- `tools.html` — removed the "Music generation" and "Voice cloning" cards
- `chat.html` — removed the "Voice clone" and "Music" tiles from the tools launcher; removed the cloned-voice machinery from the voice panel: the "+ Add a voice" mic recorder form, the saved-voices list + delete buttons, the `voice-toggle-dot`, the `q-voices-db` IndexedDB helpers (`openVoicesDB/listVoices/getVoice/saveVoice/deleteVoice`), `blobToBase64`, and `speakWithChatterbox` (POST `/speak-as-voice`). `voiceMode` is now `'off' | 'default'`; a browser still on `'cloned:{id}'` is migrated to `'default'` on load. Any leftover `q-voices-db` IndexedDB in a browser is inert. Orphan CSS for `.add-voice-*`, `.voice-del`, `.voices-divider`, `.voice-toggle-dot` was left in place (harmless).
- `voices.html` — removed the "Want a custom cloned voice? → Open voice-clone" card
- `README.md` — feature lists updated

Deliberately left alone
- `server/index.js` legacy migration step 2 (moves an old shared `q-voice/q-voice-override.wav` into the admin's user dir on boot). Pure data-mover on the volume, no-ops when the file is absent, and touching user data is not this job's to do.
- `memory.js` `getVoicePath()` → `q-voice-{id}.json` — that is the **Writer's** voice *signature* (writing style), unrelated to audio cloning.
- Historical docs (`docs/AUDIT_*`, `docs/HANDOVER_*`, `docs/BRIEF-Q-VOICE.md`, `CREATIVE-STACK-AUDIT-2026-05-05.md`, `THE BREAK-OFF LIST - Q`) — dated records; still describe the feature as it was.
- Any per-user `users/{slug}/q-voice/override.wav` files already on the Railway volume — data, untouched.
- Railway env vars `CHATTERBOX_SPACE_URL` / `ACESTEP_SPACE_URL` if set — now unread; can be removed from the Railway panel at leisure. The HF Spaces themselves (if still deployed) can be paused/deleted on huggingface.co — nothing calls them.

## What it would take to bring back a consent-gated "clone your OWN voice"

1. **Consent + identity gate before any reference audio is accepted**: signed-in user only (`requirePerson`), an explicit checkbox/attestation that the voice is the user's own, a spoken consent phrase recorded live in-browser (mic only — no file upload, no URL) and verified server-side, and a logged consent record (who/when/what) kept with the sample.
2. **No URL ingestion.** Do not restore `q-audio-fetch.js` / `yt-dlp` / `ffmpeg` at all — that is the "clone anyone off YouTube" path.
3. **Storage as biometric data**: encrypted at rest under the user's own dir, deletable by the user in one click (`/q-voice/reset` shape), covered in the privacy notice as Art. 9 special-category data with explicit consent as the lawful basis, and a retention limit.
4. **Output labelling**: generated audio watermarked/labelled as synthetic; a per-user rate limit and cost tracking (`cost-tracker.js`) on every Space call.
5. **Only then** re-add: `speakAsVoice` (this folder's `plugins/q-voice-clone.js`), a single `POST /speak-as-my-voice` route behind the gate, and — if wanted — the `speak_as_q` tool reading a **licensed** Q reference clip (the bundled `voice-candidates` clips need a licence check first).
6. Music: needs a clear licence statement for the model's output (ACE-Step is Apache-2.0 code, but the output-use terms and training-data position must be stated to the user) before `q-music.js`, `/music/generate` and `generate_music` go back.
