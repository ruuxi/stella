---
name: stella-office
description: Create, analyze, proofread, and modify Office documents (.docx, .xlsx, .pptx) using Stella's bundled `stella-office` CLI. Use when the user wants to create, inspect, check formatting, find issues, add charts, or modify Office documents.
---

# stella-office

AI-friendly CLI for `.docx`, `.xlsx`, `.pptx`. Stella bundles this command directly into Bash. No Office installation and no separate CLI install flow.

## Availability

- Use `stella-office` inside `Bash`.
- Stella exposes it as a native bundled command, similar to `stella-browser`.
- If the command is unexpectedly unavailable, the bundled binary for this platform may not be present yet.
- For live chat previews inside Stella, use `stella-office preview <file>`.

---

## Strategy

**L1 (read) -> L2 (DOM edit) -> L3 (raw XML)**. Always prefer higher layers. Add `--json` for structured output.

---

## Help System (Important)

**When unsure about property names, value formats, or command syntax, always run help instead of guessing.** One help query is faster than guess-fail-retry loops.

**Three-layer navigation** — start from the deepest level you know:

```bash
stella-office pptx set
stella-office pptx set shape
stella-office pptx set shape.fill
```

Replace `pptx` with `docx` or `xlsx`. Commands: `view`, `get`, `query`, `set`, `add`, `raw`.

---

## Performance: Resident Mode

For multi-step workflows (3+ commands on the same file), use `open` / `close`:

```bash
stella-office open report.docx
stella-office set report.docx /body/p[1]/r[1] --prop bold=true
stella-office set report.docx /body/p[2]/r[1] --prop color=FF0000
stella-office close report.docx
```

---

## Inline Live Preview

Use this when you want Stella to keep a document preview embedded in chat while you continue editing the underlying file.

```bash
stella-office preview slides.pptx
stella-office preview report.docx
stella-office preview budget.xlsx --interval-ms 1000
```

Notes:

- `preview` is Stella-specific wrapper behavior. It is not an upstream OfficeCli subcommand.
- The command starts a Stella-owned preview session and returns immediately.
- Stella watches the document and refreshes the inline preview automatically as the file changes.
- Use it before or during multi-step edit workflows when visual feedback matters.

---

## Quick Start

**PPT:**

```bash
stella-office create slides.pptx
stella-office add slides.pptx / --type slide --prop title="Q4 Report" --prop background=1A1A2E
stella-office add slides.pptx '/slide[1]' --type shape --prop text="Revenue grew 25%" --prop x=2cm --prop y=5cm --prop font=Arial --prop size=24 --prop color=FFFFFF
stella-office set slides.pptx '/slide[1]' --prop transition=fade --prop advanceTime=3000
```

**Word:**

```bash
stella-office create report.docx
stella-office add report.docx /body --type paragraph --prop text="Executive Summary" --prop style=Heading1
stella-office add report.docx /body --type paragraph --prop text="Revenue increased by 25% year-over-year."
```

**Excel:**

```bash
stella-office create data.xlsx
stella-office set data.xlsx /Sheet1/A1 --prop value="Name" --prop bold=true
stella-office set data.xlsx /Sheet1/B1 --prop value="Score" --prop bold=true
stella-office set data.xlsx /Sheet1/A2 --prop value="Alice"
stella-office set data.xlsx /Sheet1/B2 --prop value=95
```

---

## L1: Create, Read, and Inspect

```bash
stella-office create <file>
stella-office view <file> <mode>
stella-office get <file> <path> --depth N
stella-office query <file> <selector>
stella-office validate <file>
```

### view modes

| Mode | Description | Useful flags |
|------|-------------|--------------|
| `outline` | Document structure | |
| `stats` | Statistics (pages, words, shapes) | |
| `issues` | Formatting/content/structure problems | `--type format\|content\|structure`, `--limit N` |
| `text` | Plain text extraction | `--start N --end N`, `--max-lines N` |
| `annotated` | Text with formatting annotations | |

### get

Any XML path via element localName. Use `--depth N` to expand children. Add `--json` for structured output.

```bash
stella-office get report.docx '/body/p[3]' --depth 2 --json
stella-office get slides.pptx '/slide[1]' --depth 1
stella-office get data.xlsx '/Sheet1/B2' --json
```

Run `stella-office docx get` / `stella-office xlsx get` / `stella-office pptx get` for all available paths.

### Stable ID Addressing

Elements with stable IDs return `@attr=value` paths instead of positional indices. These paths survive insert/delete operations, so prefer them in multi-step workflows.

```text
/slide[1]/shape[@id=550950021]
/slide[1]/shape[@id=550950021]/paragraph[1]
/slide[1]/table[@id=1388430425]/tr[1]/tc[2]
/body/p[@paraId=1A2B3C4D]
/comments/comment[@commentId=1]
/footnote[@footnoteId=2]
/endnote[@endnoteId=1]
/body/sdt[@sdtId=123456]
```

Use returned paths directly:

```bash
stella-office set slides.pptx '/slide[1]/shape[@id=550950021]' --prop bold=true
stella-office set slides.pptx '/slide[1]/shape[@name=Title 1]' --prop text="New"
stella-office set slides.pptx '/slide[1]/shape[2]' --prop color=red
```

### query

CSS-like selectors: `[attr=value]`, `[attr!=value]`, `[attr~=text]`, `[attr>=value]`, `[attr<=value]`, `:contains("text")`, `:empty`, `:has(formula)`, `:no-alt`.

```bash
stella-office query report.docx 'paragraph[style=Normal] > run[font!=Arial]'
stella-office query slides.pptx 'shape[fill=FF0000]'
```

### validate

```bash
stella-office validate report.docx
stella-office validate slides.pptx
```

For large documents, always use `--max-lines` or `--start` / `--end` to limit output.

---

## L2: DOM Operations

### set — modify properties

```bash
stella-office set <file> <path> --prop key=value [--prop ...]
```

Any XML attribute is settable via the element path. Without `find=`, `set` applies formatting to the whole element.

Run `stella-office <format> set` for all settable elements. Run `stella-office <format> set <element>` for detail.

**Value formats:**

| Type | Format | Examples |
|------|--------|----------|
| Colors | Hex, named, RGB, theme | `FF0000`, `red`, `rgb(255,0,0)`, `accent1`..`accent6` |
| Spacing | Unit-qualified | `12pt`, `0.5cm`, `1.5x`, `150%` |
| Dimensions | EMU or suffixed | `914400`, `2.54cm`, `1in`, `72pt`, `96px` |

### find — format or replace matched text

Use `find=` with `set` to target specific text within a paragraph or broader scope. The matched text is automatically split into its own run(s). Add `regex=true` for regex matching.

```bash
stella-office set doc.docx '/body/p[1]' --prop find=weather --prop highlight=yellow
stella-office set doc.docx '/body/p[1]' --prop find=weather --prop bold=true --prop color=red
stella-office set doc.docx '/body/p[1]' --prop 'find=\d+%' --prop regex=true --prop color=red
stella-office set doc.docx / --prop find=draft --prop replace=final
stella-office set doc.docx '/body/p[1]' --prop find=TODO --prop replace=DONE --prop bold=true
stella-office set doc.docx / --prop 'find=\d{4}-\d{2}-\d{2}' --prop regex=true --prop color=red
stella-office set doc.docx '/header[1]' --prop find=Draft --prop replace=Final
```

PPT `find` works the same way:

```bash
stella-office set slides.pptx '/slide[1]/shape[1]' --prop find=weather --prop bold=true --prop color=red
stella-office set slides.pptx '/slide[1]/shape[1]' --prop 'find=\d+%' --prop regex=true --prop color=red
stella-office set slides.pptx / --prop find=draft --prop replace=final
stella-office set slides.pptx '/slide[1]/shape[1]' --prop find=TODO --prop replace=DONE --prop bold=true
stella-office set slides.pptx '/slide[1]/table[1]' --prop find=old --prop replace=new
```

Notes:

- Path controls search scope.
- If `find=` matches nothing, the command succeeds with no changes.
- `--json` output includes a `"matched"` field.
- Matching is case-sensitive by default.
- Excel supports `find` + `replace`, but not `find` + format-only styling.

### add — add elements or clone

```bash
stella-office add <file> <parent> --type <type> [--prop ...]
stella-office add <file> <parent> --type <type> --after <path> [--prop ...]
stella-office add <file> <parent> --type <type> --before <path> [--prop ...]
stella-office add <file> <parent> --type <type> --index N [--prop ...]
stella-office add <file> <parent> --from <path>
```

**Insert position** (`--after`, `--before`, `--index` are mutually exclusive):

- `--after "p[@paraId=1A2B3C4D]"` — insert after the anchor element
- `--before "/body/p[@paraId=5E6F7A8B]"` — insert before the anchor element
- `--index N` — insert at 0-based position
- No position flag — append to end

**Element types (with aliases):**

| Format | Types |
|--------|-------|
| **pptx** | slide, shape (textbox), picture (image/img), chart, table, row (tr), connector (connection/line), group, video (audio/media), equation (formula/math), notes, paragraph (para), run, zoom (slidezoom) |
| **docx** | paragraph (para), run, table, row (tr), cell (td), image (picture/img), header, footer, section, bookmark, comment, footnote, endnote, formfield, sdt (contentcontrol), chart, equation (formula/math), field, hyperlink, style, toc, watermark, break (pagebreak/columnbreak) |
| **xlsx** | sheet, row, cell, chart, image (picture), comment, table (listobject), namedrange (definedname), pivottable (pivot), sparkline, validation (datavalidation), autofilter, shape, textbox, databar/colorscale/iconset/formulacf (conditional formatting), csv (tsv) |

**Text-anchored insert** (`--after find:X` / `--before find:X`):

```bash
stella-office add doc.docx '/body/p[1]' --type run --after find:weather --prop text=" (sunny)"
stella-office add doc.docx '/body/p[1]' --type table --after "find:First sentence." --prop rows=2 --prop cols=2
stella-office add doc.docx '/body/p[1]' --type run --before find:weather --prop text="["
stella-office add slides.pptx '/slide[1]/shape[1]' --type run --after find:weather --prop text=" (sunny)"
stella-office add slides.pptx '/slide[1]/shape[1]' --type run --before find:weather --prop text="["
```

Clone example:

```bash
stella-office add slides.pptx / --from '/slide[1]'
```

Run `stella-office <format> add` for all addable types and properties.

### move, swap, remove

```bash
stella-office move <file> <path> [--to <parent>] [--index N] [--after <path>] [--before <path>]
stella-office swap <file> <path1> <path2>
stella-office remove <file> '/body/p[4]'
```

When using `--after` or `--before`, `--to` can often be omitted because the target container is inferred from the anchor path.

### batch — multiple operations in one save cycle

Stops on first error by default. Use `--force` to continue past errors.

```bash
echo '[
  {"command":"set","path":"/Sheet1/A1","props":{"value":"Name","bold":"true"}},
  {"command":"set","path":"/Sheet1/B1","props":{"value":"Score","bold":"true"}}
]' | stella-office batch data.xlsx --json

stella-office batch data.xlsx --commands '[{"op":"set","path":"/Sheet1/A1","props":{"value":"Done"}}]' --json
stella-office batch data.xlsx --input updates.json --force --json
```

Batch supports: `add`, `set`, `get`, `query`, `remove`, `move`, `swap`, `view`, `raw`, `raw-set`, `validate`.

---

## L3: Raw XML

Use raw XML only when L2 cannot express what you need. No xmlns declarations are needed because prefixes are auto-registered.

```bash
stella-office raw <file> <part>
stella-office raw-set <file> <part> --xpath "..." --action replace --xml '<w:p>...</w:p>'
stella-office add-part <file> <parent>
```

**raw-set actions:** `append`, `prepend`, `insertbefore`, `insertafter`, `replace`, `remove`, `setattr`.

Run `stella-office <format> raw` for available parts per format.

---

## Common Pitfalls

| Pitfall | Correct Approach |
|---------|------------------|
| `--name "foo"` | Use `--prop name="foo"` — all attributes go through `--prop` |
| `x=-3cm` | Negative coordinates are not supported. Use `x=0cm` or a positive value |
| PPT `shape[1]` for content | `shape[1]` is usually the title placeholder. Use `shape[2]` or higher for content |
| `/shape[myname]` | Name indexing is not supported. Use numeric index: `/shape[3]` |
| Guessing property names | Run `stella-office <format> set <element>` to see exact names |
| Modifying an open file | Close the file in PowerPoint, Word, Excel, or WPS first |
| `\n` in shell strings | Use `\\n` for newlines inside `--prop text="..."` |
| `stella-office set f.pptx /slide[1]` | Always single-quote paths with brackets: `'/slide[1]'` |

---

## Format-Specific Extras

- Cross-format core: `create`, `view`, `get`, `query`, `set`, `add`, `remove`, `move`, `swap`, `raw`, `raw-set`, `validate`, `merge`, `batch`, `open`, `close`
- XLSX-only: `import`
- PPTX-only: `check`, `view svg`
- DOCX-only: `view forms`

When you need deeper detail, prefer the command help tree:

```bash
stella-office docx help
stella-office xlsx help
stella-office pptx help
```

---

## Notes

- Paths are **1-based**: `'/body/p[3]'` means the third paragraph
- `--index` is **0-based**: `--index 0` means the first position
- After modifications, verify with `validate` and/or `view issues`
- When unsure, run `stella-office <format> <command> [element[.property]]` instead of guessing

## Backlinks

- [Abilities Index](life/knowledge/index.md)
- [Life Registry](life/registry.md)
