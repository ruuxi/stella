---
name: pdf
description: Read, create, edit, or review PDF files when text extraction, visual rendering, layout fidelity, forms, page operations, or final PDF quality checks matter. Use for PDF inspection, conversion, generation, page rendering, annotation review, and polished PDF deliverables.
---

# PDF

Use this skill for PDF work where the final file, visual layout, or extracted content needs to be reliable.

## Workflow

1. Inspect the source file first.
   - Use `pdfinfo` for page count and metadata when available.
   - Use `pdfplumber` or `pypdf` for text extraction and structural checks.
   - Use rendered page images for layout-sensitive review.
2. Choose the lowest-risk tool for the job.
   - Use `pypdf` for page splitting, merging, rotation, metadata, and simple transformations.
   - Use `pdfplumber` for text/table extraction and coordinate-aware inspection.
   - Use `reportlab` when generating a PDF from structured content.
3. Render and visually verify pages before delivery whenever layout matters.
   - Prefer `pdftoppm -png <input.pdf> <output-prefix>`.
   - Check for clipped text, broken fonts, overlap, table alignment, image quality, and page numbering.
4. Keep intermediate files organized.
   - Use a task-specific folder under `tmp/pdfs/` for scratch output.
   - Put final PDF artifacts where the user requested; if unspecified, use `state/outputs/`.

## Commands

Render pages:

```bash
pdftoppm -png input.pdf tmp/pdfs/rendered/page
```

Extract text quickly:

```bash
python3 - <<'PY'
import pdfplumber
with pdfplumber.open("input.pdf") as pdf:
    for i, page in enumerate(pdf.pages, 1):
        print(f"--- page {i} ---")
        print(page.extract_text() or "")
PY
```

Split pages:

```bash
python3 - <<'PY'
from pypdf import PdfReader, PdfWriter
reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages[:3]:
    writer.add_page(page)
with open("output.pdf", "wb") as f:
    writer.write(f)
PY
```

## Dependencies

Use existing local tools first. If a dependency is missing, install only what the task needs.

Python packages:

```bash
python3 -m pip install reportlab pdfplumber pypdf
```

System renderer:

```bash
brew install poppler
```

If installation is not possible, tell the user exactly which dependency is missing and what could not be verified.

## Quality Bar

- Never rely on extracted text alone for visually sensitive PDFs.
- Confirm page count and page order after split, merge, rotate, or export work.
- Check rendered pages at a readable size before declaring layout-sensitive work done.
- Avoid placeholder citations, broken links, missing images, unreadable glyphs, and clipped content.
- Use ASCII hyphens in generated text unless the source document already intentionally uses richer typography.
