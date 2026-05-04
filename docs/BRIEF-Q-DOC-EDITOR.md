# BRIEF — Q Doc Editor

**For:** Sarah
**Date:** 2026-05-04
**Status:** Approved 2026-05-04 — building now

## Sarah's decisions
- Step 6 (Q's vision on the doc) — **IN**. Q must see and move text, not just read it.
- Build all six steps in order.
- Plugin must be reusable — `/doc-editor` page first, then a `/homework` page later.

---

## What this is

A voice-controlled Word-document editor where Q is the operator. You speak; Q reads the doc, decides what to do, and edits it in place. You watch the changes happen on screen.

Born from tonight's form-filler dead-end: instead of trying to make pdf-lib produce a Word-compatible PDF, we let Q clean up the converted Word doc directly. But the editor stands on its own — it works for any .docx, not just filled forms.

---

## The flow (v1)

1. **You upload a .docx** (or it arrives from the form-fill pipeline).
2. **You see it on screen** — text content + paragraph structure.
3. **You speak** — *"Move the tenant name to the line above"* / *"Delete the second paragraph"* / *"Make the heading bold."*
4. **Q reasons and calls tools** — each edit is a tool call (`move_paragraph`, `delete_text`, `format_paragraph`, etc.).
5. **The doc updates live** in the preview pane.
6. **You download** the edited .docx when done.

---

## What Q gets — the tool kit

These are the new function-call tools wired into Q's chat:

| Tool | What it does |
|------|--------------|
| `read_doc()` | Returns every paragraph in order with its index, text, and style. Q calls this first to know what's where. |
| `view_doc_image()` | Renders the current doc as an image so Q can SEE alignment issues, not just read text. |
| `replace_text(target, replacement)` | Find a phrase, swap it for another. Preserves formatting. |
| `delete_paragraph(index)` | Remove a whole paragraph by its index. |
| `insert_paragraph(after_index, text, style?)` | Insert new content. Optional style: heading, body, bold, italic. |
| `move_paragraph(from_index, to_index)` | Move a paragraph from one position to another. |
| `format_paragraph(index, style)` | Bold / italic / underline / heading level / alignment. |
| `save_doc()` | Finalise — returns the edited .docx to the user. |

Every tool is a real edit on the underlying XML, so formatting survives.

---

## How it works under the hood

A .docx is a ZIP file with `word/document.xml` inside. We use:

- **pizzip** (3KB, zero deps) — open and rewrite the ZIP
- **fast-xml-parser** (already a transitive dep) — parse the document XML
- Direct manipulation of `<w:p>` (paragraphs) and `<w:r>` (text runs)

No new heavy dependencies. The libraries already in `package.json` (`docx`, `mammoth`) stay available for special cases (creating fresh docs, exporting to text).

---

## The UI

A single page at `/doc-editor`:

- **Left:** doc preview — paragraph-by-paragraph, with index numbers Q can refer to. Updates live after each tool call.
- **Right:** chat with Q. Voice button at the bottom (mic → transcribe → send). Q's tool calls show as small status lines (*"moving paragraph 3 to position 1…"*).
- **Top bar:** upload button, download button, doc title.

Visual style: matches Q's existing chat / doc-reader pages (Space Grotesk, neumorphic, pink accent).

---

## Voice — already wired, just plug in

Q's chat already has voice transcription. Same component, same flow. No new infrastructure for voice.

---

## What's OUT of v1 scope

These come later if v1 proves the concept:

- Tables (text paragraphs only for v1)
- Images
- Headers / footers
- Tracked changes / comments
- Multi-user editing
- Undo history beyond "reupload original"
- Real-time co-editing with Q (you both type into the same doc)

Keeping v1 small so we ship and test the *capability*, not the full Word feature set.

---

## Where it lives

```
quotem-ai/
├── plugins/
│   └── q-doc-editor.js          ← new — the tool implementations
├── routes.js                     ← new endpoints: /doc-editor/upload, /doc-editor/edit, /doc-editor/save
├── doc-editor.html               ← new — the UI page
└── docs/
    └── BRIEF-Q-DOC-EDITOR.md     ← this file
```

The chat tool definitions get added to `plugins/q-tools.js` alongside `web_search`, `calculator`, etc.

---

## Build order (so you can see progress)

1. **Pizzip + XML scaffolding** — read a .docx, list paragraphs, write back unchanged. Smoke test.
2. **One tool, end to end** — `replace_text`. Wire it through Q's chat. Test by typing.
3. **Five more tools** — `delete`, `insert`, `move`, `format`, `read`. Test each by typing.
4. **The UI page** — preview + chat panel + upload/download. Looks like the doc-reader page.
5. **Voice button** — drop in the existing voice component.
6. **`view_doc_image`** — render doc as image so Q can see alignment. (Last because it's the heaviest piece — needs a server-side renderer.)

Each step ends with a usable thing. You can stop after step 2 if "Q can replace text by voice" is enough to prove it works. Steps 3-6 expand on the same skeleton.

---

## What I need from you

1. Read this. Tell me what's wrong, missing, or scoped wrong.
2. Confirm "yes, build this" before I write any code.
3. Decide: build all six steps, or stop after step 2 and decide based on what we see?

No code until you've answered.
