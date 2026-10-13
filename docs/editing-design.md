# Editing: text files and images

This document fixes how HushOS edits files on the web: any text file (plain text, Markdown, CSV and TSV as tables, JSON, YAML, TOML, XML, logs, source code) and images (JPEG, PNG, WebP, and HEIC as a source). Office documents are a separate design (an ONLYOFFICE spike); iOS and Android follow this one later.

Everything happens on the device. The server never sees a document open, never converts anything and never renders anything: an edit reaches it as a new encrypted, signed version of the file, through the upload pipeline that exists today.

Decisions settled with the owner (2026-10-14): a server change lets one editing session amend its own version instead of stacking versions; redaction saves a new file by default, with replace-and-purge as an explicit choice; images are rendered for saving with `wasm-vips`; location and camera data are stripped in the editor and, on request, when sharing, never silently on upload; the web comes first.

## Principles

- **The file is the person's.** An editor writes back exactly what was there except what the person changed: same encoding, line endings, final newline, CSV dialect, image format and colour profile. Anything the editor cannot keep exactly, it opens read-only.
- **Nothing changes unasked.** Uploads stay byte-exact. Metadata is stripped only from an image the person edits or explicitly chooses to share cleaned.
- **History is not a hiding place.** Earlier versions stay for 30 days and anyone who can open a file can open them. An edit whose point is to remove something (a redaction, a location) must not leave it one click away.
- **Saving is boring.** One version per editing session, a refusal when someone else saved first, an encrypted local draft so a closed tab loses nothing.

## 1. Text

### Which files open in the editor

The editor follows the content, not a list of extensions: a file opens in it when the viewer already treats it as text (`looksLikeText` in `lib/previews.ts`: valid UTF-8, no NUL, few control characters) or when it starts with a UTF-8 or UTF-16 byte-order mark.

- **Size:** up to the text preview limit, 8 MiB (`PREVIEW_LIMITS.text`). A larger file opens read-only with a note.
- **Encoding:** UTF-8 with or without a BOM, and UTF-16 LE/BE with a BOM, are edited and written back in the same encoding with the same BOM. Anything else opens read-only ("This file uses an encoding HushOS can't edit without changing it"), never transcoded.
- **Line endings:** detected from the file (LF, CRLF; mixed files keep the majority and the editor says so) and written back the same. The final newline is kept or left absent as it was.
- **Rights:** owners and editors edit; viewers and link visitors read. A file the person may not write opens read-only without an Edit action.

### The editor

CodeMirror 6, with its own language packages (Lezer grammars) chosen by extension, falling back to plain text: JavaScript and TypeScript, JSON, YAML, TOML (legacy mode), Markdown, HTML, CSS, XML, Python, Rust, Go, Java, Kotlin, Swift, C and C++, SQL, shell, INI and properties, Dockerfile, diff. Shiki stays in the viewer; it is built for read-only highlighting and re-highlights the whole file, too slow per keystroke.

Search and replace, multiple cursors, soft wrap (on for Markdown and plain text, off for code), and the app's light and dark themes. No language servers, no formatting on save, no autocompletion from outside the file.

**Structured text** (JSON, YAML, TOML, XML) gets a parse check: a file that no longer parses shows a warning beside Save ("This YAML doesn't parse at line 14"), and saving still works. HushOS never refuses to save a person's text.

### Markdown

Editor and preview side by side on wide screens, a toggle on phones. The preview is the viewer's renderer (`components/drive/rich-text`), sanitized the same way: images and links are named, never fetched, so a document cannot make the browser call out.

### Tables: CSV and TSV

A delimited file (`.csv`, `.tsv`, `.tab`, or text whose first lines parse consistently with one delimiter) opens with two tabs on the same bytes: **Table** and **Text**.

- **Dialect:** the delimiter (comma, semicolon, tab, pipe), quote character, BOM, line endings and final newline are detected once and kept.
- **Byte-exact round trip:** the parser keeps every cell's raw source text, quotes and escapes included. Saving writes unchanged cells from their raw text and re-encodes only cells the person changed, quoting a changed cell only if it now needs quoting. A file opened and saved without edits is byte-identical; a one-cell edit changes only that cell's bytes.
- **Shape:** rows of uneven width are kept as they are; the grid pads them visually without writing padding. Adding and removing rows and columns is supported; reordering columns is not in this version.
- **Formulas:** a cell starting with `=`, `+`, `-` or `@` gets a small warning that other spreadsheet apps may run it as a formula. It is never rewritten.
- **Size:** the grid draws only the rows on screen. Above 100,000 rows or 8 MiB the Table tab is unavailable and the Text tab edits the file.

## 2. Images

### Formats

| Source                         | Edits saved as                                                   |
| ------------------------------ | ---------------------------------------------------------------- |
| JPEG, PNG, WebP                | A new version in the same format                                 |
| HEIC/HEIF (iPhone photos)      | A new JPEG file beside the original; the original is not changed |
| GIF, SVG, RAW, everything else | Not editable in this version (SVG opens in the text editor)      |

A version that suddenly changed format would surprise everything downstream, hence the HEIC rule.

### Tools

Crop (free and fixed ratios), rotate 90°, flip, resize, redact, annotate (arrow, box, highlighter, text), with undo and redo. Rotation from the EXIF orientation is applied on load and baked into the saved pixels.

### The engine

- **On screen:** a canvas showing a downscaled copy, where the person crops, draws and redacts. Every action is recorded as an operation on the full-size image, not as canvas pixels.
- **On save:** `wasm-vips` (libvips compiled to WebAssembly, a few MB) in a background worker decodes the original at full resolution, applies the recorded operations, composites redaction boxes and a rasterised annotation layer, and encodes the result.

Canvas alone fails the common case: iPhone Safari caps a canvas near 16.7 million pixels, so a 48 MP photo cannot be drawn at all; canvas drops colour profiles, so wide-gamut (Display P3) photos come out visibly duller; and it cannot crop a JPEG without re-encoding it. libvips handles all three.

- **Colour:** the ICC profile is kept on the output.
- **Quality:** JPEG at quality 92 with the original's chroma subsampling. A crop-only edit of a JPEG is lossless (whole-block crop) where the crop box allows it.
- **Loading:** the editor and `wasm-vips` load the first time someone edits an image, not in the post-unlock preload (see Privacy).

### Location and camera data

An edited image drops all EXIF, XMP and IPTC metadata except the colour profile and the baked orientation. The editor says so before saving ("Location and camera details are removed when you save").

The share dialog and the link dialog gain **Remove location and camera details**: it makes a cleaned copy beside the original and shares that copy. Uploads are never altered.

### Redaction

Redaction boxes are solid colour, chosen from black and white; there is no blur or pixelation, which can sometimes be reversed.

An image with any redaction does not save as a new version by default, because the earlier version (unredacted) would stay for 30 days, visible to everyone who can open the file. The save offers:

- **Save as a new file** (default): `<name> (redacted).<ext>` in the same folder; the original is untouched. The person shares the new file.
- **Replace and delete the original**: saves the new version, then deletes every earlier version of the file (`DELETE /api/drive/versions/:id` for each, as the versions dialog does), after a confirmation that names what is lost ("The unredacted original and its earlier versions are deleted for good"). If the file is shared, the confirmation says who could already have opened or kept the original.

The same choice applies when the person removes location data and the image is shared or linked.

## 3. Saving

### Editing sessions

Opening a file for editing starts a session: a random id held by the editor, the version it was opened at, and the person's rights. Closing the editor, or ten minutes without a save, ends it.

- **Explicit save:** Ctrl/Cmd+S or the Save button. There is no silent upload while typing.
- **Draft:** every few seconds of changes, the unsaved content is sealed and kept on this device, keyed by account and file. Reopening the file offers "Restore your unsaved changes from 2:14 PM" or discards them. Saving, discarding, signing out, locking and the account's local wipe remove drafts. Drafts are sealed under a key derived from the unlocked account key (HKDF, label `hushos/drafts/v1`, with the user id and node id as context), so a locked device cannot read them and they never leave it.
- **One version per session:** the first save in a session creates a new version. Later saves in the same session **amend** it: the server replaces that version's object with the new one, if it is still the current version and nobody else saved since. The replaced object is deleted at once rather than kept 30 days, so a long edit costs one version of quota.
- **Someone else saved first:** a save names the version the session last saw. If that is no longer current, the server refuses and the editor offers **Save on top** (a new version after theirs; nothing is lost, both stay in history), **Save as a copy** (a new file beside it), or **Open theirs** (discarding this session's changes after a confirmation, with the draft kept until then). There is no locking.

### Signatures and integrity

A saved edit signs the new version with the ordinary version statement: the person wrote those bytes. The file's name record is not touched, so a file whose name is Unverified keeps its mark. An image edit's thumbnail is regenerated and sealed in the object as today (content suite 3).

### Thumbnails, search and the feed

Images get a new thumbnail in the saved object. Text files have none. The name does not change, so the catalogue and search are unaffected; the change feed reports the new version as it reports any upload.

## 4. Privacy: what the server learns

- That a file got a new version, when, and its padded size; under amend, that a version was replaced. This is what any upload tells it today.
- The text editor (CodeMirror and its languages, roughly 150 to 250 KB gzipped) joins the post-unlock preload in `lib/preload.ts`, so fetching it reveals nothing.
- The image editor and `wasm-vips` load on first use, so the server can tell that someone edited an image. It already knows which versions carry thumbnails, which says nearly as much. The security page states this.
- Drafts never leave the device.

## 5. Security

- Documents are untrusted input. The text editor never renders a file's HTML; the Markdown preview goes through the existing sanitizer; SVG is edited as text, never rendered from the editor.
- `wasm-vips` runs in a dedicated worker with no network access of its own. The CSP already allows `'wasm-unsafe-eval'` for pdf.js (`apps/web/server/csp.ts`) and needs nothing new; it must still never need `'unsafe-eval'`.
- Image decoding has limits: dimensions above 100 megapixels or files above 64 MiB open read-only.

## 6. API contract

- `POST /api/drive/uploads` gains an optional `versionOf: { nodeId, expectedVersionId, editSessionId, amends?: versionId }` for a save from the editor. The upload is a new version of `nodeId` (no name conflict step, no sibling). At begin and again at complete, the server checks that `expectedVersionId` is still the node's current version (409 `stale`, body `{ currentVersionId }`), that the caller may write the node, and for `amends` that the named version is current, was created by the caller in the same `editSessionId`, and was created within the last hour (409 `stale` otherwise). Signatures and seeds as for any upload begin (`versionIdSeed`, `objectIdSeed`, `versionSignature`).
- On complete with `amends`, the amended version and its object are deleted in the same transaction that makes the new version current; quota is released at once.
- No new route for drafts: they are local.
- Redaction's replace-and-purge uses the existing `DELETE /api/drive/versions/:id`.

## 7. Tests that must exist

Each fails on a defect a person would notice (see AGENTS.md):

- CSV and TSV: open-and-save is byte-identical across dialects (semicolons, tabs, CRLF, BOM, quoted newlines, uneven rows); a one-cell edit changes only that cell's bytes.
- Text: UTF-16 and UTF-8-with-BOM round-trip with their BOM; a Latin-1 file opens read-only; CRLF and a missing final newline survive a save.
- Sessions: a second save amends (one version, quota released); a save after someone else's is refused with `stale`; `amends` from another session or another account is refused.
- Drafts: unreadable after lock and gone after sign-out; restored after a closed tab.
- Images: saved output carries no GPS or camera EXIF and keeps the ICC profile; a 48 MP JPEG saves on iPhone-sized limits; redaction defaults to a new file; replace-and-purge leaves no earlier version.
- Integrity: an edit of an Unverified file signs the new version as the editor's and leaves the name's mark.

## 8. Milestones

1. **Text editor:** CodeMirror with languages, Markdown preview, encodings and line endings, drafts, explicit save as a new version, stale refusal. Preload added.
2. **Tables and sessions:** CSV/TSV grid with byte-exact round trip; the `versionOf`/`amends` server change.
3. **Images:** editor, `wasm-vips` worker, metadata stripping, HEIC to JPEG, redaction with its two save choices.
4. **Sharing cleaned copies:** the share and link dialog option.
5. **iOS and Android:** text and image editing in the apps, on the same save contract.
