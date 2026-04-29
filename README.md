# Q

A general AI you can trust. Open-weights, frozen at a pinned version, fine-tunable on your own data, no single-vendor dependency.

Lives at **quotem-ai.co.uk**. Shares a parent brand with Quotem the app — nothing else.

## What Q is

Q is a general-purpose AI assistant. He runs on DeepSeek V4 Pro via Together AI as his text brain, plus Together's vision model for images and various Hugging Face Spaces for music, video, voice cloning, image generation, and image-to-SVG.

He's not a SaaS for the public. He's a personal AI for Sarah and the people she trusts (her **Circle**). Each person in the Circle has their own access key. Q knows them by name, remembers what they say, and can reference shared context naturally — *"Sarah mentioned that yesterday"*, *"I was just talking to Emma about this."*

## Architecture

- **Memory** — single JSON file on the Railway volume. Every message tagged with the person who said it. Q sees the full cross-Circle history but always knows who's in front of him. Persists across redeploys.
- **People registry** — list of people Q knows. Each has a hashed access key. Sarah is the admin; she adds people, rotates keys, removes people.
- **Auth** — every protected route requires `X-Q-Key` header (or `qkey` cookie). 401 if missing or wrong. The chat UI prompts for the key on first visit and stores it as a cookie.
- **Cost tracker** — every Together / Hugging Face call gets logged with model, tokens, duration, the person Q was helping, and an estimated GBP cost. Sarah sees daily / weekly / per-skill / per-person breakdowns at `/admin/costs`.
- **Persona** — Q's voice and identity live in `Q's Voice.md`, `Q's Bloodline.md`, `The Crown Plan.md`, plus the `Q_PERSONA` constant in `plugins/qwen-chat.js`. His skills are tools on the belt, not his job description.

## Skills available

Chat · Agent · Code · Documents · Image generation · Music · Video · Voice cloning · Graphics (image-to-SVG) · Scheduled tasks · Plus a starter set of property/construction skills carried over from his lab origins. The toolkit will grow with fine-tuning; the persona is the constant.

## Running locally

```bash
npm install
cp .env.example .env
# Edit .env — set TOGETHER_API_KEY and Q_AUTH_PEPPER at minimum
npm start
```

On first boot, Q creates Sarah in the Circle and prints her access key once. Copy it; restarts won't show it again. Open `http://localhost:8080/`, paste the key when prompted.

## Deploying to Railway

1. Push this repo to GitHub.
2. Create a new Railway service, connect it to the repo.
3. Add a volume at `/data` — Q's memory and people registry live there.
4. Set env vars from `.env.example` in Railway's variables panel. **`Q_AUTH_PEPPER` must be a long random string set ONCE — never change it after Q has people in his Circle, or every existing key invalidates.**
5. Deploy. On first boot, Sarah's access key prints in the Railway logs once. Copy it.
6. Add `quotem-ai.co.uk` as a custom domain in Railway's networking panel. Point IONOS DNS at the target Railway gives you.

## Adding someone to the Circle

```bash
curl -X POST https://quotem-ai.co.uk/circle/people \
  -H "X-Q-Key: <Sarah's key>" \
  -H "Content-Type: application/json" \
  -d '{"id":"emma","name":"Emma","intro":"Sarah'"'"'s friend"}'
```

Response includes a `accessKey` — send it to Emma via secure channel. She uses it on first visit to Q.

## Viewing costs

```bash
curl "https://quotem-ai.co.uk/admin/costs?groupBy=skill" \
  -H "X-Q-Key: <Sarah's key>"
```

Group by `skill`, `model`, `provider`, or `user`. Optional `since` and `until` ISO dates.

## Q's persona

Don't touch his persona files. They are:

- `Q's Voice.md` — voice / tone / style rules
- `Q's Bloodline.md` — origin / heritage
- `The Crown Plan.md` — Q's plan / mission

The `Q_PERSONA` constant in `plugins/qwen-chat.js` is the runtime version. Keep it in sync with the .md files when you intentionally evolve Q's voice. Don't drift it accidentally.

## Repo conventions

- No Quotem-specific code. Q has nothing to do with construction or surveying. The brand is shared; the products aren't.
- Memory + people files are gitignored. They live on the Railway volume in production and locally in `data/` for dev. Never commit them.
- Skills are tools, not roles. Adding a skill is fine; defining Q by his skills is not.
- Costs get logged. If you add a plugin that calls a paid API, wire `cost-tracker.logCall(...)` into it.
