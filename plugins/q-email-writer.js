'use strict';

/**
 * Q EMAIL WRITER
 *
 * Three steps:
 *   1. analyseEmail(text)      — read 1 email or a whole thread, return a
 *                                punchy headline + 4 clickable response options
 *   2. generateReply(...)      — turn picked option(s) + tone into a draft
 *   3. adjustTone(body, tone)  — rewrite an existing draft in a new tone
 */

const { Q_CONFIG } = require('../config');
const { cleanModelOutput } = require('./cjk-filter');

const ANALYSE_SYSTEM = `You are an expert email reader. The user pastes ONE email or a WHOLE thread (multiple back-and-forth messages). Read everything carefully. Identify the LATEST message — that's what we're replying to.

Return a SINGLE JSON object — no markdown fences, no prose around it.

Fields:
- "headline" (string)  — ONE short punchy sentence telling the user what the latest email wants, written like you'd say it to a friend. START with a relevant emoji (📧 ✉️ 💰 📅 ⚠️ 🔧 🎉 🤝 🏠 🚨 ❓ 📦 etc.). Examples: "💰 They want their invoice paid by Friday" / "🎉 Sarah's accepted your party invite" / "⚠️ Council says the noise complaint needs a response within 14 days".
- "summary" (string)  — 1-2 plain sentences with extra detail if needed. Plain text, no emoji.
- "sender" (string)   — name + email of who sent the LATEST message
- "subject" (string)  — original subject line (or inferred)
- "urgency" (string)  — "low" | "medium" | "high" | "urgent"
- "senderTone" (string) — "formal" | "professional" | "casual" | "brief" — what tone the sender uses
- "options" (array of EXACTLY 4 strings) — clickable response options the user can pick. Each one is the GIST of how the user might respond. Each option MUST start with an emoji. Write them so the user just picks one and moves on. Examples: ["✅ Sounds good — go ahead", "🤔 I need to think about it", "🚫 Not interested, thanks", "📅 Can we change the date?"]

OPTION RULES:
- 4 options. Always 4.
- Each starts with a different emoji that fits the option's vibe (✅👍🎉 for yes; 🤔🙏 for maybe; 🚫❌😬 for no; 📅⏰ for time).
- Make options SPECIFIC to this email — not generic.
- The 4 options should cover the realistic reply paths: usually one positive, one negotiating, one declining, one asking-for-more-info — adapt to what fits this email.

OUTPUT IN ENGLISH ONLY. No other languages. Output ONLY the JSON object.`;

const TONE_GUIDE = {
  professional: 'Professional but approachable. Polite, clear, no waffle. Light touch of warmth. One or two emojis is fine if natural.',
  friendly: 'Warm and friendly, like writing to a mate. Use first names. Emojis welcome where they fit naturally — don\'t force them. ✨',
  formal: 'Formal and precise. Full sentences, proper structure, suitable for councils, lawyers, or large organisations. NO emojis.',
  brief: 'As short as possible. Bullet points fine. Get to the point. One emoji at most, only if it adds something.',
};

const REPLY_SYSTEM = `You are writing an email reply on behalf of the user. The user has pasted the original email (or thread) and picked which response paths to take. You will be told the tone.

Return a SINGLE JSON object — no markdown fences:
{
  "subject": "Re: ...",
  "body":    "...the full email body, ready to send. Use \\n for line breaks..."
}

RULES:
1. Match the requested tone EXACTLY (see tone guide).
2. Address the reply to the sender of the LATEST message in the thread.
3. Cover everything the user picked in their response options. If they added extra notes, work those in too.
4. Never invent facts the user didn't give you (no fake prices, dates, addresses, names).
5. Sign off naturally. Don't fabricate a signature with phone numbers / company unless the user gave them.
6. OUTPUT IN ENGLISH ONLY.
7. Output ONLY the JSON object. No markdown.`;

const TONE_REWRITE_SYSTEM = `You rewrite an email body in a different tone.

RULES:
- Keep ALL facts, numbers, dates, names, prices exactly the same.
- Only change wording and style.
- Do NOT add anything that wasn't in the original.
- Do NOT remove any prices, dates or commitments.
- Output ONLY the rewritten body — no JSON, no markdown fences, no explanation.
- OUTPUT IN ENGLISH ONLY.`;


async function callQ(systemPrompt, userPrompt, { maxTokens = 2048, temperature = 0.3 } = {}) {
  const body = {
    model: Q_CONFIG.model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  };

  const res = await fetch(`${Q_CONFIG.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Q_CONFIG.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Q HTTP ${res.status}: ${err.slice(0, 300)}`);
  }
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content || '';
  return cleanModelOutput(raw).trim();
}

function parseJsonOutput(raw) {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}


async function analyseEmail(emailText) {
  if (!emailText || !emailText.trim()) {
    throw new Error('No email text provided');
  }
  const userPrompt = `--- PASTED EMAIL OR THREAD ---\n${emailText.trim()}\n--- END ---`;
  const raw = await callQ(ANALYSE_SYSTEM, userPrompt, { maxTokens: 2048, temperature: 0.4 });
  return parseJsonOutput(raw);
}


async function generateReply(emailText, pickedOptions, extraNotes, tone) {
  const toneKey = ['professional', 'friendly', 'formal', 'brief'].includes(tone) ? tone : 'professional';
  const guide   = TONE_GUIDE[toneKey];

  const picked = (pickedOptions || []).filter(Boolean);
  const pickedBlock = picked.length
    ? picked.map((opt, i) => `${i + 1}. ${opt}`).join('\n')
    : '(none picked — use the extra notes to draft a reply)';

  const userPrompt = `TONE: ${toneKey} — ${guide}

ORIGINAL EMAIL OR THREAD:
${emailText.trim()}

USER PICKED THESE RESPONSE PATHS:
${pickedBlock}

USER'S EXTRA NOTES (optional, may be empty):
${(extraNotes || '').trim() || '(none)'}

Write the reply now.`;

  const raw = await callQ(REPLY_SYSTEM, userPrompt, { maxTokens: 1500, temperature: 0.4 });
  return parseJsonOutput(raw);
}


async function adjustTone(emailBody, newTone) {
  const toneKey = ['professional', 'friendly', 'formal', 'brief'].includes(newTone) ? newTone : 'professional';
  const guide   = TONE_GUIDE[toneKey];
  const userPrompt = `Rewrite this email body in a "${toneKey}" tone.

TONE GUIDE: ${guide}

--- EMAIL BODY ---
${emailBody}
--- END ---`;
  const raw = await callQ(TONE_REWRITE_SYSTEM, userPrompt, { maxTokens: 1500, temperature: 0.4 });
  return raw.replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}


module.exports = { analyseEmail, generateReply, adjustTone };
