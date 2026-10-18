# File tools: archives, PDFs and images

This document fixes how HushOS works on files without them leaving the device decrypted: browsing and extracting zip and tar archives, compressing a selection into a zip, turning images into a PDF, merging, splitting and rearranging PDFs, and converting images, HEIC included. It is written against [drive-design.md](drive-design.md) and [editing-design.md](editing-design.md), and shares that design's save path, image pipeline, workers and large-file card rather than building second ones. iOS and Android follow later.

Everything happens on the device. The server never opens an archive, never converts anything and never renders anything: a tool's result reaches it as new encrypted files (or, for page edits, a new encrypted version), through the upload pipeline that exists today.

Decisions settled with the owner (2026-10-19): the whole milestone, features (a) to (g) below, one pull request each; editing milestone 1 is built alongside it in the order of section 8. The numbers in section 3 and the remaining choices are this note's proposals; the questions the owner still has to answer are listed at the end.

## Principles

- **Plaintext stays in memory.** Decrypted bytes, inflated entries and produced files live in memory and blob URLs only, never in IndexedDB, Cache Storage, the origin private file system or anywhere else on disk. This is the preview engine's rule (`lib/previews.ts`, drive-design.md "Viewers") applied to tools.
- **A tool makes something new.** The source is never changed. Results are new files beside it, except page edits of one PDF (rotate, reorder, remove), which can save a new version as editing does.
- **Hostile input is the normal case.** An archive or PDF can come from anyone through a share or a link. Every limit is enforced on the bytes as they are produced, not only on what the file claims about itself.
- **All or nothing.** A run that is cancelled, refused or fails part-way leaves nothing it made, in Drive or on the device.
- **Nothing loads that the drive doesn't need.** Every engine is a lazy chunk; the drive shell does not grow.

## 1. Scope

Each feature is one pull request, in this order.

### (a) Browse zip archives by range

A zip opens in the viewer as a list: folders to open, files with size and date, a breadcrumb. Any size, because nothing is read but the central directory and the entry asked for.

- **Reading.** `@zip.js/zip.js` over a custom `Reader` whose `readUint8Array(offset, length)` is the download engine's `FileReader.read` (`packages/drive/src/downloads.ts`), which fetches and decrypts the 8 MiB chunks that cover the range. The central directory is found from the end: the end-of-central-directory record in the last 64 KiB plus 22 bytes, then the ZIP64 locator and record when present. ZIP64 is supported.
- **Small archives** (up to `PREVIEW_LIMITS.document`, 16 MiB) are read whole and remembered like a PDF, so their reads look like a download; larger ones are read by range.
- **Per entry:** Preview (through the existing viewers, fed by an in-memory `FileReader` over the inflated bytes, with the kind's limit from section 3) and Download (streamed through the download sinks: service worker, File System Access, blob). An entry stored without compression or encryption is read by range from the archive and has no size limit for preview or download.
- **Methods.** Stored and Deflate open. Deflate64 opens if the pinned zip.js decodes it (checked when the version is pinned). BZip2, LZMA, Zstandard, PPMd and the rest are listed with "This item uses a kind of compression HushOS can't open. Download the archive to open it on your computer."
- **Names.** UTF-8 when the entry's flag says so or the Unicode path extra field (0x7075) is present and its CRC matches; otherwise strict UTF-8 if it decodes, else CP437. Names are shown as decoded; the path rules in section 3 apply when extracting.
- **Password-protected zips.** WinZip AES (AE-1, AE-2) and traditional ZipCrypto entries are listed with "Needs a password". **Decision: HushOS opens both with a password** typed in the viewer. The password is held in the archive worker for as long as the archive is open and dropped on close or lock; it is never stored. AES entries are shown only after their authentication code checks out, so a wrong password that passes the two-byte check never shows garbage. ZipCrypto is weak, but reading it protects nothing less than leaving the file locked; HushOS never **creates** password-protected zips (see (f)). Archives whose central directory is itself encrypted (PKWARE strong encryption) are refused: "This archive's list of contents is encrypted. HushOS can't open it."
- **Archives inside archives** are listed as files and are not opened in place: "Extract it first, or download it." This removes nested-archive bombs from browsing altogether.
- **Mac resource entries** (`__MACOSX/` and AppleDouble `._` files beside their originals) are hidden, with a count at the foot of the list.

### (b) Images to PDF

Select images, choose **Convert**, then **One PDF**. The dialog shows the images as a row of thumbnails to drag into order, a page size and margins, and the file name.

- **Engine:** `pdf-lib` in a worker.
- **JPEG** is embedded as it is, without re-encoding. EXIF, XMP and IPTC segments are cut out losslessly; the colour profile (APP2) and Adobe marker (APP14) are kept. A PDF reader shows no image metadata, so location riding along inside a PDF would be invisible to the person; the dialog says "Location and camera details are left out." An EXIF orientation other than upright is applied by rotating the image on the page, not by re-encoding it.
- **PNG** is embedded as PNG, transparency included.
- **HEIC, WebP, AVIF, GIF (first frame), BMP** go through the image module (section 2) to JPEG at quality 92, or PNG when there is transparency.
- **Page size:** Fit to each image, A4 or US Letter (default Letter where the browser's locale region is US or CA, A4 elsewhere), each page turned to match its image; margins none or 12 mm.
- **Output:** a new file in the folder, named after the first image with `.pdf`, editable before saving.

### (c) PDF tools

PDFs get **Edit pages**: thumbnails of every page (pdf.js, already in the app) with rotate, drag to reorder, remove, and split. Selecting several PDFs opens the same dialog with all their pages in order, which is merging. **Save as images** is in the same dialog.

- **Engine:** `pdf-lib` for structure (copying pages, `/Rotate`, removing pages), pdf.js for thumbnails and for rendering pages to images.
- **Rotate** sets the page's `/Rotate` and is lossless. **Reorder, remove, split and merge** copy pages into a new document.
- **Saving.**
    - Rotate, reorder and remove on one PDF offer **Save as a new version** (default for owners and editors) or **Save as a new file**.
    - Split makes one file per range ("Report (pages 1–3).pdf") or per page ("Report (page 4).pdf").
    - Merge makes "\<first name\> (merged).pdf".
    - Save as images makes a new folder "\<name\> (images)" with "page 001.png" onwards: PNG or JPEG, at 150 dpi by default or 300 dpi.
- **Refusals and warnings.**
    - A PDF with a password (an `/Encrypt` dictionary) is refused: "This PDF has a password. Remove it in another app, then try again." pdf-lib cannot write one back, and silently dropping the protection would be worse.
    - A PDF with a digital signature (a `/Sig` field with a `/ByteRange`) warns before saving: "Its digital signature won't be valid in the new file."
    - Bookmarks and form fields do not survive copying pages reliably; when the source has an outline or an AcroForm, the dialog says "Bookmarks and form fields may not carry over."

### (d) Extract an archive into a new folder

**Extract** on a zip (and, after (g), a tar) makes a new folder beside it, named after the archive without its extension ("Photos.zip" becomes "Photos", "site.tar.gz" becomes "site", with " (2)" if taken). The archive's tree is recreated inside it.

- Always a **new folder**. There is no "extract here" merging into an existing folder in this milestone, so name clashes happen only at the top, where the new folder's name gets the next free number.
- Entries are inflated in the archive worker one at a time and handed to the save path (section 2), with at most 512 MiB of produced plaintext waiting for upload at once. The next entry is inflated only when uploads have drained below that.
- Before anything is created, the central directory is checked against the caps in section 3, and quota against the declared sizes. While inflating, every cap is checked again on the real bytes.
- Every rule of section 3 applies; refused entries (links, special files) are named in the run's summary.

### (e) Image conversion

Images get **Convert**: to JPEG, PNG or WebP, optionally resized (longest side 1024, 2048 or 4096 pixels, or a custom size, never enlarged), and **One PDF** from (b). Several images convert in one run, one at a time.

- **Engine:** the image module (section 2), shared with editing's image editor: `wasm-vips` in a worker for decoding, resizing and encoding, so the colour profile is kept, 48 MP photos fit on an iPhone, and WebP encodes in Safari, which canvas cannot do. Canvas is used only to draw the dialog's preview.
- **HEIC decoding.** WebKit decodes HEIC natively and is used where it can. Elsewhere a WebAssembly build of libheif with libde265, loaded on first use, decodes to pixels and the colour profile, which go to `wasm-vips` for everything after. The stock `wasm-vips` build reads HEIF only as AVIF, as far as is known (see the open questions).
- **Metadata.** The output keeps the source's EXIF with the orientation baked in and reset to upright, and keeps the colour profile. The dialog offers **Remove location and camera details**, off by default, because converting is not editing and editing-design.md's rule is that nothing changes unasked.
- **Output:** beside the source, "IMG_0001.jpg" for "IMG_0001.HEIC" ("IMG_0001 (resized).jpg" when resized), with the next free number on a clash. JPEG at quality 92 with the source's chroma subsampling, as editing saves.

### (f) Compress a selection into a zip saved in Drive

**Compress** on any selection of files and folders makes one zip in the current folder: "\<name\>.zip" for one item, otherwise named as a download of the selection is ("\<folder name\>.zip", or "HushOS files.zip").

- **Engine:** `@zip.js/zip.js`'s writer in the archive worker. Deflate goes through the browser's `CompressionStream('deflate-raw')`. Files that are already compressed are stored, judged by extension: images, audio and video formats, archives, PDF, and Office files, which are zips themselves.
- **Contents:** UTF-8 names with the flag set, modification times from each file's metadata, empty folders as directory entries, ZIP64 where needed. No password, ever: the zip lives in Drive encrypted already, and ZipCrypto would only suggest protection it doesn't give.
- The walk is the download engine's (`downloads.ts`, the folder plan and its entries), reading each file decrypted in turn.
- **Downloads are unchanged:** they stay store-only through `client-zip`, streamed to disk. Compress exists to save a smaller file in Drive.

### (g) Browse tar and tar.gz

`.tar`, `.tar.gz` and `.tgz` open in the same archive list as (a), and extract after (d).

- **Parser:** HushOS's own, about two hundred lines, rather than a dependency.
    - ustar, pax (`x` per entry: `path`, `size`, `mtime`; `g` global records are ignored) and GNU long names (`L`, `K`), base-256 sizes, and the header checksum on every block.
    - Pax and long-name records are capped at 1 MiB.
- **Plain tar** is listed by reading each 512-byte header by range and skipping the data. An entry's data is stored, so preview and download read it by range at any size.
- **tar.gz** cannot seek. Listing streams the whole file once through `DecompressionStream('gzip')` in the archive worker, and opening an entry streams again from the start to that entry. Concatenated gzip members (pigz and others write them) must list completely; if the browser's stream stops after the first member, the parser falls back to `fflate`'s streaming `Gunzip`, already a dependency.
- `.tar.bz2`, `.tar.xz` and `.tar.zst` are not opened in this milestone: there is no native decompressor, and each would be another WebAssembly decoder.

### Out of scope

- **7z and RAR.** RAR is a proprietary format whose reference decoder's licence (UnRAR) forbids using it to recreate the compressor and does not fit AGPL-3.0. 7z's solid LZMA blocks must be decompressed from the start of a block to reach any file, which defeats browsing by range. A 7-Zip WebAssembly build is several megabytes and carries the same RAR code. "Download the archive to open it on your computer."
- **Office to PDF.** It needs a layout engine, which is editing's Office question (the ONLYOFFICE spike in editing-design.md). It waits for that answer and is not built twice.
- **Video and audio conversion.** ffmpeg compiled to WebAssembly is tens of megabytes, slow enough to run for minutes on a phone, bounded by memory well below the files people keep, and brings codec patent licensing with it. Media plays as it is today.

## 2. Shared pieces

### The save path: two modes, one queue

Editing and File tools write through one module over the transfer manager (`lib/transfers.ts`, `packages/drive/src/transfers.ts`):

- **A new version of the same file.** Editing's save, and page edits of one PDF. It is `enqueue` with `replaces` and the version the work started from. A version race must not quietly become a conflict copy here, as a dropped file does today. The save aborts and offers editing's choices: Save on top, Save as a copy, Open theirs (editing-design.md, "Someone else saved first"). Editing milestone 2's `versionOf`/`amends` contract replaces the client-side check when it lands.
- **A new file in a folder.** File tools' main case, and editing's "Save as a copy". The name is the next free one in the destination (`nextName`), shown before saving and editable. Results never replace an existing file and never ask the drop's replace-or-keep question.

What both modes add to the queue:

- **Uploads from memory.** A produced file is held as an `ArrayBuffer`, and the engine gains an in-memory byte source beside `File`. Results are not wrapped in a `Blob`: Chrome can page large Blobs to its profile directory, which would put plaintext on disk.
- **No stash, no journal rows with names.** Produced bytes are never written to the origin private file system (unlike Save a copy, which does today; see the open questions). The upload never resumes; an interrupted one starts over with fresh keys and nonce, which also keeps the journal's nonce rule trivially safe.
    - A run keeps one journal row with ids only: run id, workspace, output folder or output node ids, and time. No names and no bytes.
    - After a reload, that row lets the next open offer "Extracting into a folder was interrupted. Delete what was made?" naming the folder from its encrypted metadata.
    - Queued results are lost on reload, with "Run it again" (the source is still in Drive).
- **Quota before starting.** The run's outputs are estimated before anything is created and refused with the storage-full dialog when they don't fit the destination workspace's free space (allowance minus used minus reserved).
    - Each output is estimated as its padded ciphertext: the Padmé bucket of plaintext plus a 64 KiB thumbnail allowance, plus 16 bytes per chunk.
    - Where the size cannot be known before producing (conversion, compress), the estimate is the sources' total plus 1%.
    - The server's 402 at upload begin stays the backstop. A 402 mid-run stops the run and cleans up as a cancel does.
    - This code handles quota, so it gets a Vitest suite (AGENTS.md).
- **Signatures by source.** Each output is signed with `copySignatureForms` of its source (integrity-design.md, "Saved copies"): ordinary statements from a verified source, saved statements from a link, re-sealed statements from an Unverified one. An output made from several sources (merge, One PDF, compress) takes the weakest of them, so a zip of an Unverified file shows Unverified. A tool never launders a file's mark.
- **Family folders.** The destination's `refuseWrite` and `waitsForKeyChange` are asked once before the run starts, not per file. A family folder that is read-only or whose keys changed refuses the run; one waiting for a key change queues it.

### The image module: one engine, two entry points

One module, `lib/images/`, with a worker running `wasm-vips` (and the HEIC decoder, section 1 (e)):

- decode with orientation applied and the colour profile kept;
- operations: resize, crop, rotate, flip, composite;
- encode JPEG, PNG or WebP;
- strip metadata on request.

Editing's image editor (milestone 3: crop, annotate, redaction, removing location data) records operations and calls it on save. File tools' conversion, resize and One PDF call it directly. The limits are editing's: 100 megapixels and 64 MiB per image. Feature (e) builds the module; editing milestone 3 adds its editor on top and does not bring a second pipeline.

### Workers

- **Three tools workers.**
    - The archive worker: zip.js with its own workers turned off (`configure({ useWebWorkers: false })`, since it already runs in one), the tar parser, and inflate.
    - The PDF worker: pdf-lib. pdf.js keeps its existing worker.
    - The image worker: `wasm-vips` and the HEIC decoder, shared with editing.
- **They hold no keys.** The crypto worker keeps decrypting; a tools worker asks the page for byte ranges over a `MessagePort`, which the page answers from a `FileReader`, the pattern `serveMedia` uses for the player page.
- **One run at a time per tab.** A second run waits in the transfers panel ("Waiting for the extraction to finish").
- **Cancel terminates the worker**, which frees its memory and its WebAssembly heap at once.
- **A watchdog.** A worker that reports no progress for 30 seconds is terminated and the run fails with "This file couldn't be processed." A malicious PDF or archive that loops a parser costs half a minute, not a hung tab.
- **Same-origin module workers**, bundled by Vite: no `blob:` or `data:` workers in new code (see CSP below).

### The large-file card

The JSON viewer pull request introduces a card for code that is past a comfortable size. File tools and editing use the same component with a threshold and a ceiling per kind:

- **Below the threshold** the work just starts.
- **Between threshold and ceiling** the card shows the size, one sentence and **Continue** beside **Download**: "This file is 180 MB. Converting it uses a lot of memory and may be slow on this device."
- **Above the ceiling** there is no Continue: "This file is too large to convert here. Download it to work on it on your computer."

Editing's "opens read-only" cases (text above 8 MiB, images above 100 MP or 64 MiB) are the ceiling state of the same card. The numbers for File tools are in section 3.

### Entry points

One entry per file kind, in the row menu, the context menu and the selection bar's More actions, in the same place on every client later. No ellipsis, as the menus already do.

| Kind                            | Entry          | What it opens                                         |
| ------------------------------- | -------------- | ----------------------------------------------------- |
| Zip, tar, tar.gz                | **Extract**    | The extract dialog; Preview opens the archive list    |
| Image (one or several)          | **Convert**    | Format, size, or One PDF                              |
| PDF (one or several)            | **Edit pages** | Rotate, reorder, remove, split, merge, Save as images |
| Any selection of files, folders | **Compress**   | The compress dialog                                   |

PDFs get **Edit pages** rather than Convert, because rotating or merging is not converting. Entries are absent where the person can neither write the folder nor save to their own files (section 4), and on trashed items.

### Runs in the transfers panel

A run is one row in the transfers panel with one headline ("Extracting Photos.zip, 120 of 800 files", "Converting 3 photos"), progress over the bytes produced and uploaded, and **Pause** and **Cancel**. Pause pauses the uploads; producing stops by itself when the 512 MiB budget fills. Cancel asks, as every cancel does: "Stop extracting? What was extracted so far is deleted."

## 3. Safety rules

### Limits

| Work             | Threshold (card) | Ceiling                                                                                    |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| Zip listing      | none             | central directory 64 MiB; 100,000 entries                                                  |
| Tar listing      | 512 MiB file     | 100,000 entries; 32 GiB decompressed for tar.gz                                            |
| Entry preview    | none             | the viewer's limit for the kind (image 100 MiB, text 8 MiB); PDF and media 64 MiB inflated |
| Extract          | 1 GiB declared   | 4 GiB uncompressed in total; 10,000 entries; 256 MiB per entry; depth 32                   |
| Images to PDF    | 64 MiB of images | 256 MiB of images; 500 images                                                              |
| PDF tools        | 64 MiB           | 256 MiB of input (all files, when merging); 100 files; 2,000 pages                         |
| Save as images   | 50 pages         | 500 pages per run; 40 megapixels per page                                                  |
| Image conversion | 24 megapixels    | 100 megapixels and 64 MiB per image; 200 images per run                                    |
| Compress         | 256 MiB          | 1 GiB of input; 10,000 files                                                               |

Why these numbers:

- **256 MiB** is the size Save a copy already reads whole (`SAVE_COPY_MAX_BYTES`). pdf-lib holds the parsed source and builds the output in memory, roughly three times the input at peak. That keeps a merge under about 800 MB, which a recent iPhone's Safari tab survives; this is to be confirmed on the oldest supported iPhone before (b) ships.
- **4 GiB, 10,000 entries and 256 MiB per entry for extraction** bound what a bomb can cost in time, quota and memory. Above them, the archive belongs on a computer (or the desktop apps, later).
    - Memory is bounded separately, by the 512 MiB upload budget, so the total is not a memory number.
    - 10,000 files is already a long run through the upload queue.
    - Per entry, 256 MiB is what can be held as one in-memory upload.
- **100,000 listed entries and a 64 MiB central directory** list any archive a person browses by hand (100,000 entries of ordinary names take about 10 MiB) and refuse a directory built to exhaust memory.
- **Depth 32** inside the archive leaves room under Drive's height bound of 64 for wherever the new folder sits. The extract also checks the destination's depth plus the archive's against 64 before starting.
- **Images: 100 megapixels and 64 MiB** are editing-design.md's limits, so one image module has one set.
- **1 GiB for Compress**, because the upload protocol needs the exact ciphertext size at begin, so the zip is finished in memory before it is queued. Streaming a store-only zip straight into an upload (its length is predictable) is later work.

### Zip bombs

- **Declared sizes first.** Before anything is created, the central directory's sums must be under the caps: total, count, per entry, and a declared compression ratio of at most 200:1 per entry.
- **Real bytes always.** Every entry is inflated through a counter.
    - Producing more than the entry declared is an error at that byte, not at the end.
    - Producing more than 200 times the compressed bytes consumed so far is refused, once the entry has produced 1 MiB. Deflate's ceiling is about 1,032:1, and ordinary files rarely pass 200:1.
    - The run's total and count are enforced on what was actually produced.
    - The CRC-32 (or AES authentication code) must match at the end of each entry, or the entry and the run fail.
- **Overlapping entries are refused.** Every entry's span, from its local header to the end of its data, must not overlap another's, and each local header's name and sizes must agree with the central directory's. This stops the non-recursive overlapping-file bomb and the parser confusion where two readers see different files.
- **Nested archives** are never opened by extraction or browsing; they are files.
- **tar.gz** is held to the same 200:1 ratio on the gzip stream as a whole (after 1 MiB) and to 32 GiB decompressed for listing.
- **Downloading one entry** is held to its declared size (an entry that produces more fails). An entry whose declared size is over 4 GiB at more than 200:1 asks first: "This item expands to 40 GB from 20 MB."

### Paths

Each entry's path goes through one function, tested by table:

1. Backslashes are separators (Windows tools write them).
2. **Refused:**
    - an absolute path (leading `/` or `\`);
    - a drive letter (`C:`, with or without a separator after it);
    - a UNC path (`\\server\share`);
    - any `..` component, wherever it is. Refused, not resolved: `a/../b` is refused, never treated as `b`.
3. `.` and empty components are dropped.
4. Each component is normalised to Unicode NFC, then made safe as `save-file.ts`'s `safeFileName` makes names safe:
    - forbidden characters and controls become `_`;
    - bidirectional overrides become `_`;
    - leading and trailing dots and spaces are removed;
    - Windows device names get a leading `_`;
    - names are cut to 255 bytes of UTF-8 between whole characters, keeping the extension.
    - The result must pass Drive's own `checkName` (1 to 255 code points, no slash, no control characters, not `.` or `..`).
5. **Depth** above 32 components refuses the entry.
6. **Duplicates** after normalisation take the next free number (" (2)"), so NFC and NFD spellings of "é" become two files, not one overwriting the other. Comparison is exact after NFC, as Drive compares names today.
7. **A file and a folder with the same name** (`a` and `a/b`): the folder keeps the name and the file takes the next number.
8. **Names in the destination** clash only at the new folder, which takes the next free name.

### Links and special entries

- **Zip:** an entry whose Unix mode (external attributes) is a symbolic link is listed as "Link, not opened" and never extracted, and never followed; a later entry with a path through it is an ordinary path inside the new folder.
- **Tar:** these entry types are refused and named in the summary:
    - hard links (`1`) and symbolic links (`2`);
    - character and block devices (`3`, `4`);
    - FIFOs (`6`).
- GNU sparse (`S`) and multi-volume (`M`, `V`) entries stop the run. Type `7` is treated as a regular file, as tar does.
- Unix permissions, owners and setuid bits are ignored; Drive has none.

### Memory

The ceilings above are memory caps. On top of them:

- one run at a time per tab;
- at most 512 MiB of produced plaintext waiting for upload, across the run;
- one image decoded at a time;
- one PDF page bitmap at a time (40 megapixels is 160 MiB of RGBA).

### Plaintext never reaches storage

- Decrypted sources, inflated entries and results live in worker memory, page memory and, for previews, blob URLs that are revoked when the viewer closes.
- Never IndexedDB, Cache Storage, the origin private file system, `localStorage` or a download the person didn't ask for.
- Results are uploaded from `ArrayBuffer`s, not Blobs (section 2).
- Remembered previews of archive entries follow `rememberPreview`'s rules: memory only, bounded, dropped on lock.
- What the operating system swaps to disk is outside what a web page controls, as it is for previews today.

### Every result is encrypted before it leaves

Results go through the normal upload path and nothing else: fresh node and content keys, sealed metadata, the version envelope with its signature, Padmé padding, multipart upload with signed part lengths. No tool talks to the server except through that path and the existing read path.

### Cancellation and failure leave nothing

A cancel, a refusal, a 402, a watchdog or a closed tab:

1. terminates the run's workers, freeing their memory and WebAssembly heaps;
2. drops the page's buffers and revokes every blob URL the run made;
3. aborts the run's open uploads (`DELETE /api/drive/uploads/:id`; the server deletes their pending objects and releases the reservation);
4. deletes forever everything the run already published: the new folder for an extraction or Save as images, each new file otherwise. Deleted forever rather than moved to Trash, so the quota comes back at once and nothing half-made lingers. Where the person may not delete forever (to be checked for an editor in someone else's folder), the results go to Trash;
5. removes the run's journal row.

After a closed tab, steps 3 and 4 happen on the next open from the run's journal row, and the 24-hour upload expiry covers what is left.

### Content Security Policy

- **WebAssembly needs nothing new.** `script-src` already carries `'wasm-unsafe-eval'` (`apps/web/server/csp.ts`, for OPAQUE, libsodium, argon2 and pdf.js). `wasm-vips` and the HEIC decoder use the same permission. Nothing may need `'unsafe-eval'`.
    - The HEIC decoder's Emscripten glue must be built without dynamic code (`-sDYNAMIC_EXECUTION=0`).
    - A test fails the build if any shipped worker chunk contains `eval(` or `new Function(` reachable at runtime. OPAQUE's never-called js-sys detection stays the one known, inert exception.
- **Workers come from this origin.** New workers are module scripts Vite emits under `/assets/`, allowed by `worker-src 'self'`. New code creates no `blob:` or `data:` workers; zip.js's inline workers are turned off. WebAssembly files and pdf.js assets are fetched from this origin under `connect-src 'self'`.
- **The nonce policy is untouched.** The per-request nonce only stamps TanStack's inline hydration script. Workers are not inline and need none. A production check confirms that worker script responses carry the same policy header (the Nitro `response` hook sets it on every response), so a worker's own policy is ours.

### Dependencies

| Library                           | Licence                                                                             | Use                                       | Status                       |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------- |
| `@zip.js/zip.js`                  | BSD-3-Clause                                                                        | Reading and writing zips, AES, ZipCrypto  | New (a)                      |
| `pdf-lib`                         | MIT                                                                                 | PDF structure: merge, split, rotate       | New (b); see open questions  |
| `pdfjs-dist`                      | Apache-2.0                                                                          | Page thumbnails, PDF to images            | Existing, 6.3.289            |
| `wasm-vips`                       | MIT; libvips LGPL-2.1-or-later; bundled codecs under BSD, MIT, IJG, libpng and LGPL | The image module                          | New (e), shared with editing |
| libheif and libde265 (Emscripten) | LGPL-3.0                                                                            | HEIC decoding where the browser has none  | New (e); see open questions  |
| `fflate`                          | MIT                                                                                 | Gzip fallback for multi-member tar.gz     | Existing                     |
| `client-zip`                      | MIT                                                                                 | Store-only zips for downloads (unchanged) | Existing, 2.5.0              |
| Tar parser                        | AGPL-3.0 (ours)                                                                     | tar and pax headers                       | New (g)                      |

All are compatible with AGPL-3.0:

- BSD, MIT and Apache-2.0 code may be combined into a GPLv3-family work.
- LGPL-2.1-or-later and LGPL-3.0 may be combined with AGPL-3.0. The LGPL libraries ship as separate `.wasm` files loaded at run time, so they can be replaced, and their source is published with ours.
- Each licence text goes into the third-party notices.

Rules:

- Exact versions in `package.json` (no `^` or `~`) and the lockfile, each at least two weeks old when added.
- An upgrade is its own pull request.
- Every engine sits behind a dynamic `import()`. The menus are static; dialogs and engines are lazy.
- The drive shell's entry chunk, measured gzipped from the built output as the bundle-weight pass measured it, grows by no more than 2 KiB per pull request. The pull request states the before and after.
- The archive reader is small and opens like a viewer, so it joins the post-unlock preload in `lib/preload.ts`. pdf-lib, `wasm-vips` and the HEIC decoder load on first use, like editing's image editor (section 5 says what that reveals).

## 4. Permissions

| Who                      | Browse, preview, download entries | Results into the same folder                     | Results into my files            | New version (page edits)          |
| ------------------------ | --------------------------------- | ------------------------------------------------ | -------------------------------- | --------------------------------- |
| Owner                    | Yes                               | Yes                                              | Not needed                       | Yes                               |
| Editor on a share        | Yes                               | Yes, counted against the owner's storage         | Yes                              | Yes                               |
| Viewer on a share        | Yes                               | No                                               | Yes, as Save a copy              | No                                |
| Link visitor, signed in  | Yes                               | No                                               | Yes, signed as saved from a link | No                                |
| Link visitor, no account | Yes                               | No                                               | No                               | No                                |
| Family member            | Yes                               | Yes, while the folder is writable on this device | Yes                              | Yes, while the folder is writable |

- **A viewer** can open an archive in a share, preview and download its entries, and extract, convert or compress into their own files. Nothing goes into the owner's folder; the server refuses it (403) whatever the page does.
- **Family folders** write through the area's ledger like every upload: the run is refused while the folder is read-only on this device or its keys changed, and waits while a key change runs (`writeRefusal`, `waitsForKeyChange`). Family folders have no sharing, so the tools offer no sharing step. A result in a family folder can be opened by every member, as any upload can.
- **Editors' runs** are drawn in the owner's workspace and count against the owner's storage. The editor cannot see the owner's free space, so the quota check before starting covers only the editor's own and family destinations; in a share, the first 402 stops the run and cleans up.

## 5. What the server learns

- **About archive contents: nothing.** Not entry names, not the number of entries, not sizes, not the compression, not whether an archive has a password. The same for every PDF page and every image pixel.
- **The results, as any upload tells it:** that new files (or a new version) were created, how many, when, in which folder, and their sizes rounded to a Padmé bucket.
- **Patterns it can infer.** The timing and shape of those uploads say something on their own. A burst of hundreds of files into a new folder right after one large file was read looks like an extraction; a PDF appearing beside a set of images looks like One PDF.
- **Which parts of the source were read.** An archive over 16 MiB is read by range, so the object store sees which 8 MiB chunks were fetched (the end first, for the central directory, then the chunks holding the entries opened), as it already sees for PDF previews and media seeking.
- **Code fetches.** pdf-lib, `wasm-vips` and the HEIC decoder load on first use, so whoever serves the app can tell that someone on this account used a PDF or image tool at that moment. The upload that follows says nearly as much. The archive reader is preloaded and reveals nothing.

The security page states these points when the first tool ships.

## 6. Phones

iOS and Android come later, on the same rules, limits and save contract.

- **The Rust core** (`crates/hushos-core`) has `chunk_range` and `chunk_decrypt` and the upload sealing. File tools there need:
    - a seekable decrypting reader over a version (`Read + Seek`, fetching chunks through the app's HTTP layer);
    - archive listing and extraction with the `zip` crate (MIT) and `tar` with `flate2` (MIT or Apache-2.0), wrapped in the caps, overlap check and path function of section 3, ported to Rust;
    - an in-memory upload source, and the run journal with ids only.
- **One set of rules, held by fixtures.** The fixtures of section 7 and a table of their expected outcomes are shared, so the Rust port is held to the web's behaviour byte for byte. Moving the web onto the Rust rules through WebAssembly is possible later; it is not this milestone.
- **Images.** The phones' own decoders (ImageIO on iOS, ImageDecoder on Android 9 and later) read HEIC, so neither app ships libheif.
- **PDF.** iOS has PDFKit for merge, split and rotate. Android renders with `PdfRenderer` but needs a writer, such as the Rust `lopdf` crate (MIT) in the core.
- **Limits** are lower on phones where memory is: the large-file card's thresholds take the device's memory into account.

## 7. Tests and verification

Each test fails on a defect a person, operator or attacker would notice (AGENTS.md).

### Fixtures are real malicious archives

A generator script (`apps/web/e2e/fixtures/archives/make.ts`) writes every archive byte by byte with its own minimal zip and tar writers, never through a library that would clean names or fix sizes. Small fixtures are committed; large ones are generated when the tests run.

A Vitest suite checks that each fixture is what it claims, through an independent reader (`python3 -I` with `zipfile` and `tarfile`, or `bsdtar -tv`): the traversal fixture really lists `../evil.txt`, the bomb really declares what it declares. A fixture that stopped being malicious would fail there, not pass quietly everywhere else.

- **Bombs:**
    - one entry of 1 GiB of zeros (about 1 MiB deflated);
    - a nested 42.zip-style archive;
    - an overlapping-entry bomb in the zbsm style (small file, gigabytes declared through shared data);
    - an entry that declares 1 KiB and inflates to 100 MiB;
    - 10,001 empty entries, and 100,001 for listing;
    - a central directory declaring 65 MiB;
    - a ZIP64 archive with one 5 GiB entry of zeros (about 5 MiB);
    - a tar.gz of 40 GiB of zeros.
- **Paths:**
    - `../evil.txt`, `../../etc/passwd`, `a/../../b`, `a\..\..\b`;
    - `/abs.txt`, `\abs.txt`, `C:\win.txt`, `C:evil.txt`, `\\server\share\x`;
    - `./a`, `a//b`;
    - NFC and NFD spellings of the same name;
    - a 300-byte component; 40 levels deep;
    - a name with a NUL, one with a right-to-left override, `CON`, `aux.txt`;
    - a file and a folder of the same name;
    - a local header whose name differs from the central directory's.
- **Links and special entries:**
    - a zip with a symbolic link to `/etc/passwd`, then an entry written "through" it (`link/evil`);
    - a tar with a symbolic link, a hard link, a character and a block device, a FIFO, a pax `path` of `../x`, a GNU long name with `..`, a sparse entry;
    - a pax record of 2 MiB.
- **Encryption and damage:**
    - an AES-256 zip and a ZipCrypto zip with a known password;
    - a wrong password;
    - an AES entry with a flipped authentication code;
    - an entry with a wrong CRC-32;
    - a gzip of two concatenated members;
    - a PDF with a password; a PDF with a digital signature;
    - a PDF that loops pdf-lib's parser, for the watchdog.

### Unit tests beside the code

- The path function, by table, against every name above.
- The caps and the overlap check.
- The ratio counter on real inflate streams.
- The quota estimate against Padmé buckets and the server's own size checks (quota: required by AGENTS.md).
- The weakest-signature rule for outputs with several sources.

### End-to-end, per feature (Chromium and WebKit)

- **(a) Browsing**
    - A zip opens; a folder inside opens; a text entry previews; an entry downloads byte-identical (SHA-256).
    - The 5 GiB ZIP64 fixture lists while the page fetches less than 32 MiB (counted from network requests).
    - The AES zip asks for its password, refuses a wrong one, and opens with the right one.
    - The 65 MiB central directory is refused with its message.
- **(b) Images to PDF**
    - Three images reordered make a three-page PDF in that order, checked by reading it back with pdf.js.
    - A JPEG with GPS EXIF leaves none inside the PDF.
    - A rotated phone photo stands upright.
    - The result appears in the folder with its padded size.
- **(c) PDF tools**
    - Merge gives the sum of pages; split gives the ranges.
    - Rotate sets `/Rotate`; reorder changes the order.
    - Save as a new version makes a version and keeps the earlier one.
    - Save as images gives the right count and dimensions.
    - The signed PDF warns; the password PDF is refused.
- **(d) Extraction**
    - The tree is recreated byte-identical.
    - Every bomb, path and link fixture is refused or cleaned as section 3 says, with nothing left in Drive after a refusal.
    - Cancel half-way leaves no folder.
    - A run that doesn't fit is refused before anything is created.
    - In a family folder that is read-only on this device, the run is refused.
- **(e) Conversion**
    - An iPhone HEIC with GPS converts to JPEG, upright, with the Display P3 profile, GPS kept by default and gone when asked.
    - A 48 MP HEIC converts on WebKit.
    - Resize keeps the aspect ratio and never enlarges.
    - WebP output works on WebKit.
- **(f) Compress**
    - A folder of mixed files becomes a zip in Drive that Python's `zipfile` extracts to identical bytes, Unicode names and empty folders included.
    - A JPEG inside is stored; a text file is deflated.
    - A compress that doesn't fit is refused before starting.
- **(g) tar**
    - tar and tar.gz list, preview and download; the two-member gzip lists completely; every tar fixture of section 3 behaves.
- **Permissions**
    - A viewer on a share sees Extract only with a destination in their own files, and the server refuses a forced write into the share.
    - A link visitor without an account sees Preview and Download only.

### Plaintext checks, every feature

Each fixture carries a canary string. After a run, and again after a cancelled run, the test asserts the canary is absent from:

- every object in the bucket;
- IndexedDB, Cache Storage and the origin private file system, read from inside the page;
- the browser profile directory on disk (Playwright with a persistent context, scanning the user data directory, which is where a paged Blob would land).

### Verification

Every pull request gets the independent review and the verify-hushos live run with evidence before merge: the result opened by a second account where sharing applies, stored ciphertext shown to hold no canary, and the transfers panel screenshotted through cancel.

## 8. Order with editing

One sequence across both milestones, each step one pull request, ordered by what each needs. Editing's milestone 1 (editing-design.md, "Milestones") is split into three steps here; that document's decisions are unchanged.

1. **The large-file card**, from the JSON viewer pull request. Everything after uses it.
2. **The save path's two modes** (section 2): new version with the stale choices, new file with the next free name, the in-memory byte source, the quota estimate with its Vitest suite, signatures by source, the run journal with ids only. No interface of its own; its tests are the review.
3. **The tools worker harness:** the range port, the watchdog, cancel by terminate, the 512 MiB budget.
4. **Editing 1a:** the CodeMirror editor for text and code, explicit save as a new version through step 2, Save on top, Save as a copy and Open theirs.
5. **File tools (a):** browsing zips, on steps 1 and 3; the archive reader joins the preload.
6. **Editing 1b:** encodings and line endings, the Markdown preview beside the source, the editor in the post-unlock preload.
7. **File tools (b):** images to PDF; the first run in the transfers panel; pdf-lib arrives.
8. **Editing 1c:** sealed drafts.
9. **File tools (c):** PDF tools; page edits save new versions through step 2's first mode.
10. **File tools (d):** extraction; new folder, cleanup on cancel, every rule of section 3.
11. **File tools (e):** image conversion; builds the shared image module (`wasm-vips` worker, HEIC decoder). Editing milestone 3's image editor later sits on it.
12. **File tools (f):** compress.
13. **File tools (g):** tar and tar.gz.

Editing milestone 2 (the CSV grid and the `versionOf`/`amends` server change) fits after step 9 and tightens page edits' stale check to the server's refusal; milestone 3 (images) comes after step 11. Steps 4, 6 and 8 and steps 5, 7, 9 and 10 touch different code and can be reviewed in parallel, one heavy verification run at a time.

## 9. Editors

- **Milestone 1 (existing text, Markdown, code and CSV files as text): CodeMirror 6**, as editing-design.md already chose. Saves keep the file byte for byte except for the edit; Lexical's Markdown import and export would normalise and rewrite people's files, a lossy round trip, so it is not used for files people already have.
- **Markdown** shows a rendered preview beside the CodeMirror source. There is no WYSIWYG editing of `.md` files in milestone 1.
- **The CSV grid** has no library named in editing-design.md. Whichever is chosen keeps its data model ours (rows of raw cell text), so the model can later be shared rather than the grid replaced.
- **Notes and documents** (the roadmap's Later item, rich text written in HushOS): Lexical, with `@lexical/yjs` for editing together.

This agrees with editing-design.md; nothing there is overridden.

## 10. Later: editing together

Editing together will stream encrypted Yjs updates over a WebSocket relay: the server forwards ciphertext chunks to each connected client and never sees a document. The relay learns who is connected to which document, and the timing and size of updates.

What milestone 1 and File tools do now, so that is not painted into a corner:

- **Editors with Yjs bindings**, so none has to be replaced: CodeMirror 6 (`y-codemirror.next`), Lexical (`@lexical/yjs`), and a CSV grid whose model is ours (section 9).
- **No single-writer assumption that would be hard to undo.**
    - Every save states the version it started from and handles someone else's save (editing's stale choices).
    - There are no locks and no server state saying a file is being edited on one device.
    - Drafts are a per-device convenience, never the source of truth.
    - File tools read a pinned version and never assume the source is unchanged.

Risks to resolve then, not now:

- the keys for the update stream, and how they follow a share's key rotation;
- membership changes while people are connected (a removed editor must stop receiving updates);
- what the relay's view of timing and size reveals, and whether to batch or pad.

The protocol is not designed here.

## Open questions for the owner

1. **HEIC decoding outside Safari.** libheif with libde265 is LGPL and licence-compatible, but HEVC is patent-encumbered, and shipping a software decoder from hushos.com may need a licence in some countries. Ship it, or convert HEIC only where the browser decodes it (Safari) and say so elsewhere?
2. **editing-design.md assumes `wasm-vips` reads HEIC** (milestone 3, "HEIC to JPEG"). Its stock build reads HEIF as AVIF only, as far as is known, so editing needs the same decoder as question 1. Confirm before milestone 3 relies on it.
3. **pdf-lib's upstream** has had no release since 1.17.1 (2021), and it would parse untrusted PDFs. Use it pinned in a worker behind the watchdog, or the maintained MIT fork `@cantoo/pdf-lib`?
4. **Results don't survive a reload** (no plaintext stash; "Run it again" instead). Accept, or later seal queued results under a device-local key derived as editing's drafts are, so a reload resumes?
5. **Save a copy writes decrypted bytes to the origin private file system today** (`lib/stash.ts`), which this note forbids for tools. Leave it, or move it to the same sealed approach in its own change?
6. **Quota for an editor in someone else's share** is checked only by the server's 402 mid-run. Accept, or add a server check that a run's total would fit, which tells editors roughly how much room the owner has?
7. **Cancel deletes forever** what the run made, all or nothing. Confirm, rather than keeping finished files.
8. **Metadata.** One PDF leaves out image metadata by default; Convert keeps it unless asked. Confirm the difference.
9. **The limits** of section 3, above all 4 GiB and 10,000 entries for extraction and 256 MiB for PDF work.

Open in editing-design.md that bear on milestone 1 (that document's decisions are not changed here):

10. **When the stale check fires.** Until milestone 2's `versionOf`, a stale save is caught at upload completion, not at begin: the bytes go up and are then aborted or attached as a copy. Accept that for milestone 1, or move the begin-time check forward?
11. **Family folders.** editing-design.md names owners, editors, viewers and link visitors. Confirm that family members edit family files, refused while the folder is read-only on the device or its keys changed.
12. **Text above 8 MiB** opens read-only there. Should the large-file card's Continue allow editing up to a higher ceiling, or stay read-only? This note assumes read-only.

## Owner decisions (2026-10-19)

The open questions above are answered as recommended, with two changes:

- **Results and reload (4):** accepted that a tool's results don't survive a reload, but while any result is still waiting to upload, the page asks before it unloads (`beforeunload`), so a reload or close isn't silent.
- **Text over 8 MiB (12):** opens read only, with the large-file card offering editing behind a warning about memory and speed, up to the text ceiling.
- **PDF writing:** `@cantoo/pdf-lib` (MIT; 2.7.1, actively released, though its maintainers promise support only for their own roadmap), pinned to an exact version and run in a worker; vendored if it goes quiet. pdf.js stays the reader (rendering, PDF to images, page thumbnails).
- **HEIC (1):** convert only where the browser decodes HEIC; a software decoder waits for a licence and patent check. **wasm-vips and HEIC (2):** verified in that PR.
- **Save a copy (5):** its plaintext stash moves to sealed storage in its own PR, soon.
- **Out of room in someone else's share (6):** a clear "no room" message and a clean-up; the owner's free space is never revealed.
- **Cancel (7):** all or nothing, Trash for editors. **Metadata (8):** One PDF drops image metadata by default; Convert keeps it unless asked. **Limits (9):** as above. **Stale save (10):** accepted until milestone 2. **Family members edit family files (11):** yes.
