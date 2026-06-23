// q-lab/config.js
// Q's Together AI configuration.
//
// Q now runs on DeepSeek V4 Pro — top of the open-weight leaderboard
// (April 2026, score 87). Same ownership properties as Qwen 3 235B:
// downloadable, frozen at this version, portable across hosts,
// fine-tunable on Quotem's data later.
//
// Previous model: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput'
// Switched: 2026-04-25 after Sarah asked for the best version we can have.
// Switch is reversible — change the model line below to roll back.

const Q_CONFIG = {
  apiKey: process.env.TOGETHER_API_KEY,
  baseURL: 'https://api.together.xyz/v1',
  // Main chat = V4-Pro. We tried V4-Flash for speed but it intermittently
  // returned empty 200-OKs → "Q returned no reply" every other message. Pro's
  // earlier timeouts were caused by reasoning_effort:'high' on tool turns,
  // which is now removed in q-chat.js — so Pro is both fast and reliable here.
  // (fastModel below stays on Flash for utility/extraction speed.)
  model: 'deepseek-ai/DeepSeek-V4-Pro',
  // V4 Pro is text-only. When the chat carries an image attachment we
  // switch the call to a vision-capable model on the same Together key.
  // Kimi K2.5 (Moonshot AI) — strong on OCR / document reading / structured
  // image understanding. Open-weights, sovereignty-compatible.
  // Previous: Qwen/Qwen3.6-Plus (Apr 2026)
  // Previous: Qwen2.5-VL-72B-Instruct (retired from Together, Apr 2026)
  visionModel: 'moonshotai/Kimi-K2.5',
  // Utility tasks (extraction etc.). V4-Flash was removed by Together 2026-06-09;
  // using V4-Pro as fallback until a replacement fast model is confirmed available.
  fastModel: 'deepseek-ai/DeepSeek-V4-Pro',
  // Case THREADS run on GLM-5.2 — a true reasoning model (thinks in a separate
  // channel, answers decisively). Sarah's call, and VERIFIED LIVE 2026-06-23: a
  // direct Together test of `zai-org/GLM-5.2` with tool_choice:'auto' had it call
  // save_email_draft with valid args (finish_reason=tool_calls) — so it DOES drive
  // tools and WILL save her Outbox drafts (the earlier "GLM drops drafts" worry was
  // a stale comment, not reality). It's cheaper than Claude, which on her council-
  // tax case looped on a phantom liability order and missed the winning argument
  // (the ignored SMI disregard). Rollback paths if needed:
  // QUOTEM_THREAD_MODEL='deepseek-ai/DeepSeek-V4-Pro' (V4) or
  // QUOTEM_CLAUDE_THREADS=1 (back to Claude Sonnet).
  threadModel: process.env.QUOTEM_THREAD_MODEL || 'zai-org/GLM-5.2',
  temperature: 0.0,
  maxTokens: 4000,
  // Voice cloning — set after deploying q-lab/voice-cloning-space/ to a HF Space.
  // See voice-cloning-space/README.md for setup. URL looks like:
  //   https://YOUR-USERNAME-q-voice-cloning.hf.space
  chatterboxSpaceUrl: process.env.CHATTERBOX_SPACE_URL || '',
  // Image generation — runs on Together AI (FLUX.1-schnell-Free, no extra key needed).
  // Graphics — image-to-SVG via StarVector. q-lab/graphics-space/.
  starVectorSpaceUrl: process.env.STARVECTOR_SPACE_URL || '',
  // Music — text-to-music via ACE-Step. q-lab/music-space/.
  aceStepSpaceUrl: process.env.ACESTEP_SPACE_URL || '',
  // Video — text-to-video via Wan 2.2. q-lab/video-space/.
  wanSpaceUrl: process.env.WAN_SPACE_URL || '',
};

module.exports = { Q_CONFIG };
