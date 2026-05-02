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
  model: 'deepseek-ai/DeepSeek-V4-Pro',
  // V4 Pro is text-only. When the chat carries an image attachment we
  // switch the call to a vision-capable model on the same Together key.
  // Qwen3.6-Plus is Together AI's current multimodal flagship (Apr 2026) —
  // supports images and reads text inside them (screenshots, forms, docs).
  // Previous: Qwen2.5-VL-72B-Instruct (retired from Together, Apr 2026)
  visionModel: 'Qwen/Qwen3.6-Plus',
  // Fast model for utility tasks where top-tier reasoning isn't needed —
  // form-field extraction, simple JSON shaping, lightweight transforms.
  // Llama 3.3 70B Turbo on Together AI: ~5-10x faster than V4 Pro and
  // strong at structured-output JSON tasks. Q's main brain stays on V4 Pro.
  fastModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  temperature: 0.0,
  maxTokens: 4000,
  // Voice cloning — set after deploying q-lab/voice-cloning-space/ to a HF Space.
  // See voice-cloning-space/README.md for setup. URL looks like:
  //   https://YOUR-USERNAME-q-voice-cloning.hf.space
  chatterboxSpaceUrl: process.env.CHATTERBOX_SPACE_URL || '',
  // Image generation — set after deploying q-lab/image-gen-space/ to a HF Space.
  // See image-gen-space/README.md for setup. URL looks like:
  //   https://YOUR-USERNAME-q-image-gen.hf.space
  zImageSpaceUrl: process.env.ZIMAGE_SPACE_URL || '',
  // Graphics — image-to-SVG via StarVector. q-lab/graphics-space/.
  starVectorSpaceUrl: process.env.STARVECTOR_SPACE_URL || '',
  // Music — text-to-music via ACE-Step. q-lab/music-space/.
  aceStepSpaceUrl: process.env.ACESTEP_SPACE_URL || '',
  // Video — text-to-video via Wan 2.2. q-lab/video-space/.
  wanSpaceUrl: process.env.WAN_SPACE_URL || '',
};

module.exports = { Q_CONFIG };
