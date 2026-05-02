# AcroForm PDF Field Parser — Brief for Quotem

**For:** A fresh Claude chat working on the Quoteapp repo  
**Date:** 2026-05-02  
**Origin:** Proved working today in quotem-ai on an NRLA Assured Shorthold Tenancy Agreement

---

## Why This Matters

Quotem has a form-filling system (`glass-filler.js`) that uses AI vision to look at a rendered image of a PDF page and guess where the fillable fields are. This is unreliable — the AI is estimating positions from pixels.

Professional PDFs (NRLA tenancy agreements, council forms, housing forms, housing benefit forms etc.) have their field positions, names and types **baked directly into the file** as AcroForm data. You don't need AI to find them. You just read them. We tested this on an NRLA Assured Shorthold Tenancy Agreement and every single field was found and mapped exactly — pixel-accurate, instant, no AI call at all.

---

## How It Works

**Client-side PDF.js** (loaded via CDN — no npm install) parses the PDF in the browser. Each Widget annotation in the PDF is a form field with a name, type, and exact coordinates.

### Step 1 — Parse fields from the PDF

```js
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

const allFields = [];
for (let p = 1; p <= pdfDoc.numPages; p++) {
  const page = await pdfDoc.getPage(p);
  const annotations = await page.getAnnotations({ intent: 'display' });
  const [,, pageW, pageH] = page.view;

  for (const ann of annotations) {
    if (ann.subtype !== 'Widget' || !ann.fieldType) continue;
    allFields.push({
      name:      ann.fieldName,   // e.g. "TenantName", "StartDate"
      fieldType: ann.fieldType,   // Tx = text, Btn = checkbox, Sig = signature, Ch = dropdown
      page:      p,
      rect:      ann.rect,        // [x1, y1, x2, y2] in PDF points, bottom-left origin
      pageW, pageH,
    });
  }
}
```

### Step 2 — Render page and draw overlays

```js
const viewport = page.getViewport({ scale: 1.5 });
await page.render({ canvasContext: ctx, viewport }).promise;

// Convert PDF rect to canvas coordinates
const [vx1, vy1] = viewport.convertToViewportPoint(ann.rect[0], ann.rect[3]); // top-left
const [vx2, vy2] = viewport.convertToViewportPoint(ann.rect[2], ann.rect[1]); // bottom-right
// Draw SVG rect at vx1, vy1 with width/height from those points
```

### Step 3 — Fill the fields server-side (pdf-lib)

```js
const { PDFDocument } = require('pdf-lib'); // npm install pdf-lib

const pdfDoc = await PDFDocument.load(pdfBytes);
const form = pdfDoc.getForm();

// Write values into fields by name
form.getTextField('TenantName').setText('John Smith');
form.getTextField('StartDate').setText('01/06/2026');
form.getCheckBox('PetsAllowed').check();    // or .uncheck()
form.getDropdown('TenancyType').select('Assured Shorthold');

// Flatten (optional — locks the fields so they print correctly)
form.flatten();

const filledPdfBytes = await pdfDoc.save();
// Return as application/pdf download
```

---

## What to Build in Quotem

1. **Replace** vision-based field detection in `glass-filler.js` with this AcroForm parser for the mapping step
2. **Map endpoint**: client parses fields with PDF.js, sends `{ name, type, page, rect }` list to server (or keeps it client-side)
3. **Fill endpoint**: `POST /forms/fill` accepts `{ pdfBuffer, values: { fieldName: value } }`, uses pdf-lib to write values, returns filled PDF as a download
4. **Fallback rule**: if `getForm().getFields()` returns 0 fields, the PDF has no AcroForm data (scanned/printed form) — fall back to vision detection for those only

---

## Field Type Reference

| fieldType | Meaning | pdf-lib method |
|-----------|---------|----------------|
| `Tx` | Text input / multi-line | `form.getTextField(name).setText(value)` |
| `Btn` | Checkbox or radio button | `form.getCheckBox(name).check()` |
| `Sig` | Signature field | `form.getSignature(name)` (read-only in pdf-lib) |
| `Ch` | Dropdown or list box | `form.getDropdown(name).select(option)` |

---

## Rules (from CLAUDE.md)

- Check `server/templates/TEMPLATE_CATALOGUE.md` first — if a plugin handles PDF parsing, use it
- Vault `glass-filler.js` to `server/vault/` before touching it
- Any new plugin goes in `server/templates/` following the catalogue pattern
- **No vision calls for PDFs that have AcroForm data** — the coordinates are exact and free
- Run `node -c <file>` on every server-side JS file before committing

---

## Working Reference

The complete working implementation (field parsing + SVG overlay + field list) is in:

```
quotem-ai/plotter.html
```

Use it as the reference for the client-side PDF.js code. The fill step (pdf-lib) has not been built yet — it's next.
