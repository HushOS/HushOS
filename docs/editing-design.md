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

Editor and preview side by side on wide screens, a toggle on narrow ones. The preview is the viewer's renderer (`components/drive/rich-text`), sanitized the same way: images and links are named, never fetched, so a document cannot make the browser call out. It follows typing as it happens and scrolls with the source both ways (see As built: the Markdown preview).

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
- **Draft:** a couple of seconds after a change (and when the page or app goes to the background, and before a lock), the unsaved content is sealed and kept on this device, keyed by account and file. Reopening the file offers "Restore your unsaved changes from 2:14 PM" or discards them. Drafts are sealed under a key derived from the unlocked account key (HKDF, label `hushos/drafts/v1`, with the user id, workspace id and node id as context), so a locked device cannot read them and they never leave it. Locking keeps them, sealed: the lock drops the editor's text, and after the unlock reopening the file offers it back. A save that makes the text current, Discard, Open theirs, signing out and the account's local wipe remove them.
- **One version per session:** the first save in a session creates a new version. Later saves in the same session **amend** it: the server replaces that version's object with the new one, if it is still the current version and nobody else saved since. The replaced object is deleted at once rather than kept 30 days, so a long edit costs one version of quota.
- **Someone else saved first:** a save names the version the session last saw. If that is no longer current, the server refuses and the editor offers **Save on top** (a new version after theirs; nothing is lost, both stay in history), **Save as a copy** (a new file beside it), or **Open theirs** (discarding this session's changes after a confirmation, with the draft kept until then). There is no locking.

### Signatures and integrity

A saved edit signs the new version with the ordinary version statement: the person wrote those bytes. The file's name record is not touched, so a file whose name is Unverified keeps its mark. An image edit's thumbnail is regenerated and sealed in the object as today (content suite 3).

### Thumbnails, search and the feed

Images get a new thumbnail in the saved object. Text files have none. The name does not change, so the catalogue and search are unaffected; the change feed reports the new version as it reports any upload.

## 4. Privacy: what the server learns

- That a file got a new version, when, and its padded size; under amend, that a version was replaced. This is what any upload tells it today.
- The text editor (CodeMirror, every language it colours, the structured-text parsers and their check worker, and the preview's renderer) is not in the post-unlock preload: most people never edit, and fetching it for everyone slowed every unlock. The first Edit fetches the whole fixed set (`editorAssets` in `components/drive/text-editor.tsx`), in one order whatever the file, while the editor says it is opening. So the server can tell that someone edited a file then, never what kind of file: the same chunks come for a JSON file as for Markdown, and a later Edit fetches nothing more. Every viewer stays in the preload and imports nothing of the editor's.
- The image editor and `wasm-vips` load on first use, so the server can tell that someone edited an image. It already knows which versions carry thumbnails, which says nearly as much. The security page states this.
- Drafts never leave the device. Their code is part of the editor's fixed set, so they change nothing the server sees fetched.

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
- Drafts: unreadable after lock and gone after sign-out; restored after a closed tab and after a lock and unlock; removed by Save and Discard; a version someone saved since leads to the stale choices, never over theirs.
- Images: saved output carries no GPS or camera EXIF and keeps the ICC profile; a 48 MP JPEG saves on iPhone-sized limits; redaction defaults to a new file; replace-and-purge leaves no earlier version.
- Integrity: an edit of an Unverified file signs the new version as the editor's and leaves the name's mark.

## As built: Editing 1a (2026-11-18)

- **Where:** the web (CodeMirror 6, with every language and the YAML and TOML parsers fetched in the post-unlock preload, brought forward from 1b), iPhone (`UITextView`) and Android (`EditText`), no colouring on the phones. Edit is offered for text, Markdown, CSV and TSV (as text) and SVG (as text) to owners, editors of a share and family members while the folder is writable on the device; never to viewers or link visitors, never on an earlier version, and not on a file shared on its own (its folder isn't the editor's to list).
- **What opens for editing:** UTF-8 without a byte order mark, LF line endings only, not binary, up to 8 MiB (`crates/hushos-core/src/text_edit.rs` and `apps/web/src/lib/text-edit.ts`, held to `fixtures/text-edit-cases.json`). Byte order marks, UTF-16, CRLF, other encodings and larger files open read-only with a note until Editing 1b. A missing final newline is kept as it is, and a line break typed or pasted is LF on every client.
- **Saving:** each save is a new version through the save path's version mode (`startedFrom` the version the editor read), signed as the person's own writing; Save as a copy is signed as its source, so an Unverified file's copy stays Unverified. The stale check is the client-side one of file-tools-design.md question 10 until milestone 2's `versionOf`.
- **Not yet:** drafts (1c), the Markdown preview beside the source, encodings and line endings (1b), the large-file card's "edit anyway" above 8 MiB.

## As built: Editing 1b (2026-11-19)

- **Encodings:** UTF-8 with or without a byte order mark, and UTF-16 little or big endian with one, are edited and saved in the same encoding with the same mark. Detection follows the bytes: a UTF-8 or UTF-16 mark, else UTF-8. Latin-1 and other invalid UTF-8, UTF-16 without a mark (an even length whose NULs all sit on one side of each pair, at least one pair in two), and UTF-16 with an odd length or an unpaired surrogate open read-only with "This file uses an encoding HushOS can't edit without changing it", never transcoded. The 8 MiB limit is on the file's bytes. The binary rule is the viewer's, applied after the mark, counted in code units for UTF-16 (a NUL code unit is binary).
- **Line endings:** LF and CRLF are detected and written back; a line break typed or pasted becomes the file's. A file mixing them is editable, says "This file mixes line endings; saving uses Windows (CRLF)" (or "Unix (LF)"), and an edit writes every break in the majority style; a tie takes the file's first break, and a file with none is LF. A lone CR (classic Mac) opens read-only ("This file uses line endings HushOS can't edit without changing them"). The final newline is never added or removed.
- **Byte-exact saves:** the editor holds the text without the mark and with every break as LF; each client keeps a save state: the format found when the file opened (encoding, mark, line break), kept for the whole session, and the text and bytes last opened or saved. A save writes those bytes again while the text is unchanged (a file opened and saved without an edit is byte-identical, a mixed one included), otherwise the text in the session's format (`text_encode` in the core, `encodeText` on the web). The format is never found again from what was saved: a save that removed every line break would have lost CRLF, and one grown past 8 MiB would have stopped every later save. Detection and encoding live in `crates/hushos-core/src/text_edit.rs` and its web twin `apps/web/src/lib/text-edit.ts`, held to `fixtures/text-edit-cases.json` (byte cases with their encoding, line ending, mixed flag and editor text; edit cases; and `sessions`, several saves in a row) on every client. Half of a character (a surrogate without its pair, typed between an emoji's halves) is never written: UTF-16 would be a file no client opens again and UTF-8 would get U+FFFD in its place, so the web (`writable`) and Android (`TextEditing.writable`, since a Kotlin string can hold one) save nothing, keep the text, and say "This text has half of an emoji or symbol in it. Delete it, then save." Swift strings and the core can't hold one. The fixture has no such case: its texts are Rust strings. The web viewer also shows UTF-16 with a mark as UTF-16, and its sniff takes a UTF-16 mark for text.
- **Markdown preview:** on the web, the viewer's renderer (`MarkdownView`, sanitized the same way: images named with no `<img>`, links opened only on a click) beside the source at `lg` widths and behind a Source/Preview switch below them, mounted and rendered only while it can be seen (wide, or Preview chosen), a quarter second after typing stops, and not past `MARKDOWN_LIMIT` (2 MiB, counted in UTF-8 bytes). Parsing runs on the main thread (about 30 ms for 32K characters on a fast laptop, over a second for a megabyte), so past 32K characters (`PREVIEW_LIVE_LIMIT`) it renders when it comes into view and then only on Refresh preview. A preview that fails (its renderer's code didn't load, or the renderer threw) says "The preview couldn’t be shown." in its pane; the source, its text and Save go on. Whether a file gets the preview is decided by the row its text was read from, Open theirs included. Its code fences stay plain until the post-unlock preload has fetched every Shiki grammar, so a fence typed before that never fetches its language's grammar. The phones use a segmented Source/Preview control (SwiftUI `Picker`, Material `SegmentedButton`) over each app's viewer blocks (`MarkdownView`, `MarkdownBlockView`), rendered from the text when Preview is chosen, not selectable (a copy would skip the editor's protected one) and not past the viewers' 2 MiB limit; Open theirs goes back to Source. Nothing is fetched.
- **Preload:** UTF-16 and the marks are the editor's own code. The preview's renderer is the viewer's, behind a module of its own (`components/drive/editor-preview.tsx`) that every editor fetches with its grammars and parsers (`editorAssets`), whatever kind of file is open, and the post-unlock preload fetches too (`preloadEditor`); the limit it checks is in `lib/markdown-limit.ts`, which imports nothing, so a plain-text editor never loads the Markdown parser on its own. The e2e preload check now includes a Markdown file, and a fence typed while the preload is held back fetches no grammar.
- **Not yet:** drafts (1c), the large-file card's "edit anyway" above 8 MiB, colouring and a side-by-side preview on the phones, and the phones' viewers still read UTF-16 Markdown as UTF-8.

## As built: the Markdown preview (2026-11-19)

- **Live:** the web preview follows typing at most once a frame, leading and trailing (`lib/frame-throttle.ts`), never waiting for typing to stop, up to `PREVIEW_LIVE_LIMIT`, lowered from 32K to 16K characters: measured on a fast laptop against a production build, typing beside a 32K preview left a task of about 50 ms on most keys (48 of 60), and from 8K to 24K on at most one of 60; phones and slower laptops take a few times as long. Past it, Refresh preview as before.
- **Scrolling together:** the renderer marks each block (paragraphs, headings, fences, quotes, list items, tables and their rows, rules) with the first and last source line remark gave it, as `data-source-line` and `data-source-end`, added after sanitising to elements the sanitiser kept (`lib/markdown.ts`). A position in either pane is a fractional source line, interpolated within a block and across the blank lines between two (`lib/scroll-sync.ts`); the other pane is scrolled to put that line at its top, and either pane at its top or end takes the other there. The link's own scroll comes back as a scroll event; it is recognised and dropped, so it never moves the pane being scrolled. Footnote definitions are drawn at the end of the document wherever their source lines are, so blocks whose source starts go backwards are left out of the lookup (`inSourceOrder`): their lines map through the gap they leave. Typing keeps the preview near the cursor: the source keeps the cursor in view and the preview follows the source after each render. The preview has no scroll anchoring. On a narrow screen, switching between Source and Preview keeps the line that was at the top.
- **Diagrams (web only):** a Mermaid fence, in the viewer and the editor's preview alike, is drawn by `pele` (MIT, github.com/obsidianmd/pele) with its core and twelve diagram types: flowchart, sequence, class, state, entity relationship, Gantt, pie, user journey, Git graph, mind map, timeline and quadrant chart. About 138 KB gzipped, all of it in one worker file (`lib/mermaid.worker.ts`, over `lib/mermaid-render.ts`) that joins the viewers' post-unlock preload; nothing draws a diagram before it has come, and nothing is ever fetched per type, so which code a device fetched never says that a file holds a diagram or what kind (`lib/mermaid-bundle.test.ts` fails if a type is added or the set is split). pele runs without a DOM, in the worker, with links and images off (every `click` and image directive dropped). Its SVG must pass an allowlist of pele's own elements and quoted attributes, with no URL but a fragment (`safeDiagramSvg` in `lib/mermaid-svg.ts`), and is shown as an `<img>` from a blob URL, where it runs no script and fetches nothing. Colours come from the app's tokens, written into the SVG as pele's `--pele-*` variables (an image never sees the page's CSS), and each diagram is drawn again when light, dark or high contrast changes. Its SVG is checked as an SVG reader and its CSS would read it: XML character references and CSS escapes decoded, a style limited to the properties pele writes, and `url()` only to a fragment once decoded. Bounds: 20,000 characters of source, 500 edges and 2 MB of SVG per diagram, 20 diagrams per file, 8 seconds per diagram counted from when the worker is given it (diagrams are queued on the page and drawn one at a time; one that times out fails alone, and a new worker draws the rest). A worker that can't start settles the preload at once, and diagrams then say they couldn't be drawn; a replacement that fails before it loads is not started again. A diagram no longer wanted (its text changed, its view gone) leaves the queue before it is drawn. On a public link's page, which has no post-unlock preload, every Markdown file shown starts the same fixed bundle, with a diagram or without (`startDiagramsForView`); inside the drive only the preload starts it (`lib/diagram-owner.ts`). A diagram that isn't drawn stays its code with one sentence: "This kind of diagram isn’t drawn here." (a type outside the twelve), "This diagram is too large to draw.", "This diagram couldn’t be drawn." (a syntax error, or an SVG the allowlist refused), "Only the first 20 diagrams in a file are drawn." The image's text is "Diagram". The phones keep the code block (an owner decision).
- **Phones:** side by side when the window is wide (see each app's AGENTS.md), with the same live updates and scrolling; the Source/Preview switch stays on narrow widths.
- **Loading:** the editor left the post-unlock preload (section 4).

## As built: Editing 1c, drafts (2026-11-20)

- **Where:** the web, iPhone and Android alike. On the web the editor's (`lib/drafts.ts`, IndexedDB database `hushos-drafts`, sealed and opened in the crypto worker: `driveDraftSeal`, `driveDraftOpen`, `driveDraftSlot`), on the phones `Drafts.swift` (HushOSKit, `local/drafts` in the app group, out of backups, each record written with complete file protection) and `data/Drafts.kt` (`noBackupFilesDir/drafts`). The sealing is the core's `drafts.rs` and its web twin `packages/crypto/src/drafts.ts`, held to `crates/hushos-core/fixtures/drafts.json`: the key, slot, associated data and record bytes for a fixed key and nonce, thirteen records or inputs that must not open, and the restore decision's cases.
- **Key:** HKDF-SHA-256 of the account root, salt 32 zero bytes, info the compact JSON `["hushos/drafts/v1",userId,workspaceId,nodeId]` (ids lowercased): one key per account and file, derived only while unlocked and never stored. The workspace is in it beside the node, a change from the bullet in section 3 as first written: a node table is keyed by workspace and node, and a share's node named like one of the account's own files must never be offered that file's text. Under the root, not the settings key: a master-key rotation makes older drafts unreadable, and they are dropped when next looked for.
- **Record:** found by a slot, the first 16 bytes of HKDF under `["hushos/drafts/slot/v1",userId,workspaceId,nodeId]`, base64url, so a locked device shows how many drafts there are and when each was written, never which file. The record is compact JSON `{v,base,encoding,lineEnding,mixed,savedAt,sealed}`: the version the text started from, the session's save format (kept for the whole session, as a save keeps it, never found again from what was saved) and the time (milliseconds) beside the envelope `[1][24-byte nonce][XChaCha20-Poly1305]`, the device store's layout. The associated data `["hushos/drafts",1,userId,workspaceId,nodeId,base,encoding,lineEnding,mixed,savedAt]` binds them: another account, file, base version, format or time does not open. The plaintext is the selection's ends (`from` and `to`, where the cursor is) as 32-bit big-endian UTF-16 offsets (`0xFFFFFFFF` for none), then the text in UTF-8. No scroll position: the restore scrolls to the selection.
- **When written:** a write turn about two seconds after the first change, carrying every change until it runs (at most one write per two seconds while typing, the last change within two), and at once when the page is hidden or left (`visibilitychange`, `pagehide`), when the app goes to the background (iOS's scene phase, Android's `ON_STOP`), when an iPhone editor is parked by a rebuild, after a save lands, and on the web before Lock on this browser (`lib/draft-flush.ts`, at most 1.5 s, imported by the lock control and holding none of the editor's code). Never while locked or signed out (the worker has no root; the web's writer and the store both ask again just before writing, and a phone's write asked for before a sign-out's wipe keeps nothing after it), never for a read-only file, never while the restore offer is unanswered, and never for a text back at what was last opened or saved: that turn removes the draft. Half of a character (a surrogate without its pair) skips the turn and keeps the last draft.
- **Restoring:** looked for once per editor, at the first open (never after Open theirs, and on the iPhone never for work taken back after a rebuild, which is the same session's newer text; an offer up when the screens went comes back with the work). Not offered when the file already holds that text (the draft is dropped). The offer is a bar above the text on the web (Restore, Discard; the text can't be changed until it is answered) and the system's alert on the phones. Restore puts the draft's text in place as an unsaved edit (Undo goes back on the web and the iPhone), with its selection and the session format it was typed under. When the file's current version is still the draft's base, that is all. When someone saved since (or no version can be told), the stale choices open at once and the session's next save still starts from the draft's base, so a plain Save asks the same question: nothing lands over theirs without Save on top. Discard deletes the draft and asks nothing more.
- **Removed:** by a save or a copy once the text is the file's (a copy also removes the draft of the file it came from), Discard, Open theirs, a close by choice (Discard changes, or nothing to keep), signing out and the account's local wipe (the web's `hushos-drafts` is in `lib/device-data.ts`; the phones' folders are in `AccountStore`), a record that no longer opens, one older than 30 days, and past 50 per account the oldest (`drafts_to_drop`; the phones hold one account's data at a time). Locking keeps them. A draft whose file is gone or no longer this person's to edit is never shown (the editor never opens for it) and leaves by those bounds; on the iPhone a confirmed loss of access (`EditAccess.lost`: the share revoked, the family removed) deletes it at once, and Android's family clear-out does the same; an uncertain one keeps it.
- **Bounds and failures:** 8 MiB of text in UTF-8 per draft (the editor's limit; past it nothing is kept). A draft that can't be kept (past the limit, quota, a store that won't open) never stops editing: one quiet line, "Your unsaved changes couldn’t be kept on this device.", until a write succeeds.
- **Tabs and devices:** one draft per account and file on a device, the last writer's, with its time shown. A known cost: a save in one tab removes the draft of that file that another tab wrote; the other tab writes it again at its next change, so text typed there and not changed since is not kept if that tab then closes.
- **Strings:** "Restore your unsaved changes from 2:14 PM" (the time in the person's locale; "Nov 19, 2:14 PM" on another day, with the year in another year), "Restore", "Discard", "Your unsaved changes couldn’t be kept on this device."

## 8. Milestones

1. **Text editor:** CodeMirror with languages, Markdown preview, encodings and line endings, drafts, explicit save as a new version, stale refusal. Preload added.
2. **Tables and sessions:** CSV/TSV grid with byte-exact round trip; the `versionOf`/`amends` server change.
3. **Images:** editor, `wasm-vips` worker, metadata stripping, HEIC to JPEG, redaction with its two save choices.
4. **Sharing cleaned copies:** the share and link dialog option.
5. **iOS and Android:** text and image editing in the apps, on the same save contract.
