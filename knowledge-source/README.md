# Q's Knowledge Source

Drop files here that you want Q to know.

> Open work, gaps, and maintenance notes live in `q-lab/knowledge-source-TODO.md` (one level up — kept outside this folder so it doesn't get ingested into Q's RAG library).

When you run `node q-lab/plugins/qwen-ingest.js`, every supported file in this folder gets read, chunked, embedded, and stored in Q's library (`q-lab/q-knowledge.json`). Q then searches that library before answering you.

## What to drop in

Anything Q should know about Quotem, your work, your standards, or your customers:

- **Standards register** — your Quotem standards document
- **Past quotes** — example outputs, especially ones you considered "right"
- **Habinteg specs** — disability adaptation standards as YOU apply them
- **Council documents** — anything specific to councils you work with
- **Brian's templates** — letter templates, standard responses, his preferred phrasings
- **Email exports** — meaningful threads with customers/contractors
- **Claude conversation export** — when you've downloaded it from claude.ai (Settings → Privacy → Export)
- **Any markdown notes** you've made about quoting, surveying, or Quotem's product

## Supported file types

- `.md` (markdown)
- `.txt` (plain text)
- `.json` (any JSON — gets pretty-printed for chunking)
- `.csv` (rows become "col1: val1 | col2: val2 | ..." text per line)

PDFs not yet supported — convert to text first or save as `.md`.

## How to load

From the project root:

```bash
node q-lab/plugins/qwen-ingest.js
```

That reads everything in this folder and adds it to Q's library.

To check what's already in the library:
```bash
node q-lab/plugins/qwen-ingest.js --stats
```

To wipe and re-ingest from scratch:
```bash
node q-lab/plugins/qwen-ingest.js --wipe
```

To ingest from a different folder:
```bash
node q-lab/plugins/qwen-ingest.js /path/to/another/folder
```

## How it works

1. Each file gets split into ~1500-char chunks (paragraph-aware)
2. Each chunk is sent to Together AI's embedding endpoint (BAAI/bge-large-en-v1.5)
3. The resulting vector is stored alongside the chunk
4. When Q is asked a question, his query is embedded and the 3 most similar chunks are loaded into his context before he answers

He doesn't memorise the files — he searches them. So he can have access to a lot of knowledge without it bloating his system prompt.

## Cost

Each chunk = one embedding API call. ~£0.0001 per call. So:
- 100 chunks ≈ £0.01
- 1,000 chunks ≈ £0.10
- 10,000 chunks ≈ £1.00

Embedding is one-off when you ingest. Retrieval (one embedding per query) is the per-call cost during chat.
