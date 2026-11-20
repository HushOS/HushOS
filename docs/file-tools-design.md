# File tools: archives, PDFs and images

This document fixes how HushOS works on files without them leaving the device decrypted: browsing and extracting zip and tar archives, compressing a selection into a zip, turning images into a PDF, merging, splitting and rearranging PDFs, and converting images, HEIC included. It is written against [drive-design.md](drive-design.md) and [editing-design.md](editing-design.md), and shares that design's save path, image pipeline, workers and large-file card rather than building second ones. iOS and Android follow later.

Everything happens on the device. The server never opens an archive, never converts anything and never renders anything: a tool's result reaches it as new encrypted files (or, for page edits, a new encrypted version), through the upload pipeline that exists today.

Decisions settled with the owner (2026-10-19): the whole milestone, features (a) to (g) below, one pull request each; editing milestone 1 is built alongside it in the order of section 8. The numbers in section 3 and the remaining choices are this note's proposals; the questions the owner still has to answer are listed at the end.

## Principles

- **Plaintext stays in memory.** Decrypted bytes, inflated entries and produced files live in memory and blob URLs only, never in IndexedDB, Cache Storage, the origin private file system or anywhere else on disk. This is the preview engine's rule (`lib/viewers/previews.ts`, drive-design.md "Viewers") applied to tools.
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
- **Methods.** Stored, Deflate and Deflate64 open. Deflate64 was checked when the version was pinned (2026-11-17): zip.js 2.24.0 decodes it with its JavaScript inflater (the browser's `DecompressionStream` has no Deflate64), and the core with the `deflate64` crate (it decodes every entry itself, without the `zip` crate); `basic.zip`'s `deflate64.txt` holds both to it. BZip2, LZMA, Zstandard, PPMd and the rest are listed with "This item uses a kind of compression HushOS can't open. Download the archive to open it on your computer."
- **Names.** UTF-8 when the entry's flag says so or the Unicode path extra field (0x7075) is present and its CRC matches; otherwise strict UTF-8 if it decodes, else CP437. Names are shown as decoded; the path rules in section 3 apply when extracting.
- **Password-protected zips.** WinZip AES (AE-1, AE-2) and traditional ZipCrypto entries are listed with "Needs a password". **Decision: HushOS opens both with a password** typed in the viewer. The password is held in the archive worker for as long as the archive is open and dropped on close or lock; it is never stored. AES entries are shown only after their authentication code checks out, so a wrong password that passes the two-byte check never shows garbage. A typed password is tried on the entry it was asked for first, then on the archive's other locked entries (at most three entries and 32 MiB read); an entry is inflated in full to prove it only when it declares at most 16 MiB within the 200:1 declared ratio, so no unlock inflates a bomb, and when no entry qualifies the password verifier alone decides (AES's two bytes, ZipCrypto's one check byte). ZipCrypto is weak, but reading it protects nothing less than leaving the file locked; HushOS never **creates** password-protected zips (see (f)). Archives whose central directory is itself encrypted (PKWARE strong encryption) are refused: "This archive's list of contents is encrypted. HushOS can't open it."
- **Archives inside archives** are listed as files and are not opened in place: "Extract it first, or download it." This removes nested-archive bombs from browsing altogether.
- **Mac resource entries** (`__MACOSX/` and AppleDouble `._` files beside their originals) are hidden, with a count at the foot of the list.

### (b) Images to PDF

Select images, choose **Convert**, then **One PDF**. The dialog shows the images as a row of thumbnails to drag into order, a page size and margins, and the file name.

- **Engine:** `@cantoo/pdf-lib` in a worker (the owner's decision; "As built: (b)" below).
- **JPEG** is embedded as it is, without re-encoding. EXIF, XMP and IPTC segments are cut out losslessly; the colour profile (APP2) and Adobe marker (APP14) are kept. A PDF reader shows no image metadata, so location riding along inside a PDF would be invisible to the person; the dialog says "Location, camera and other photo details are left out." An EXIF orientation other than upright is applied by rotating the image on the page, not by re-encoding it.
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

Editing and File tools write through one module over the transfer manager (`lib/drive/transfers/transfers.ts`, `packages/drive/src/transfers.ts`):

- **A new version of the same file.** Editing's save, and page edits of one PDF. It is `enqueue` with `replaces` and the version the work started from. A version race must not quietly become a conflict copy here, as a dropped file does today. The save aborts and offers editing's choices: Save on top, Save as a copy, Open theirs (editing-design.md, "Someone else saved first"). Editing milestone 2's `versionOf`/`amends` contract replaces the client-side check when it lands.
- **A new file in a folder.** File tools' main case, and editing's "Save as a copy". The name is the next free one in the destination (`nextName`), shown before saving and editable. Results never replace an existing file and never ask the drop's replace-or-keep question.

What both modes add to the queue:

- **Uploads from memory.** A produced file is held as an `ArrayBuffer`, and goes through the engine's in-memory byte source beside `File` (`MemoryFile`, built for Save a copy; its buffers move to the worker, transferred, on first read). Results are not wrapped in a `Blob`: Chrome can page large Blobs to its profile directory, which would put plaintext on disk.
- **No stash, no journal rows with names.** Produced bytes are never written to the origin private file system (Save a copy seals what it stashes, since the change that followed question 5). The upload never resumes; an interrupted one starts over with fresh keys and nonce, which also keeps the journal's nonce rule trivially safe.
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
- **One run at a time per tab.** A second run waits in the transfers panel ("Waiting for the extraction to finish"). Only runs that produce results take the slot (extract, convert, compress, page edits, Save as images). Browsing an archive and previewing an entry are viewers, not runs: they never wait behind a run, so a browse never waits behind a paused extraction (owner, 2026-11-17).
- **Cancel terminates the worker**, which frees its memory and its WebAssembly heap. An idle worker stops at once; Chromium lets one busy in a loop run for up to two seconds after `terminate()` before it forcibly stops it (measured in `e2e/tools-harness.spec.ts`). The next run's worker may start meanwhile, so two heaps can overlap for that long. Results the page still holds are detached on cancel, so a reference kept anywhere holds nothing, and every source is closed. A lock or a sign-out cancels every run, running or waiting (`cancelAllToolRuns`).
- **A watchdog.** A worker that reports no progress for 30 seconds is terminated and the run fails with "This file couldn't be processed." A malicious PDF or archive that loops a parser costs half a minute, not a hung tab. Time the worker spends waiting on the page (a range being fetched, a full upload budget) is not counted, and a range read does not start the clock over. The clock is brought up to date each second and one tick adds at most two seconds, so a tab the browser froze, or a phone app iOS or Android suspended, does not fail an honest run for time it never had. The cost is in a hidden tab: Chrome runs a background tab's timers about once a minute after a few minutes, so each tick adds at most two seconds a minute and the watchdog can take about fifteen minutes to stop a hung worker there. The hung worker spends that time on its own thread, not the page's.
- **The page trusts no worker.** A worker may have one result waiting for acceptance at a time, in order, each at most 256 MiB, its name at most 1,024 characters and its type at most 255 (plain strings: they are outside the budget, so never a way to carry bytes); a worker can't say it is done while a result waits; each result costs the budget at least 64 KiB, so even empty ones fill it: at most 8,192 results wait unreleased across the tab, so the save path releases each as it uploads it, never at the run's end; a run holds at most 10,000 results not yet released, and produces at most 10,000 results and 4 GiB in all (section 3's caps by default, held by the page; a run may set its own); two reads in flight and 64 MiB of them; a refusal is a code the page puts into words; and what it reports when done is a plain summary (no bytes: those come as results, under the budget), checked in one bounded walk of at most 10,000 values, 4,096 entries per array or object, 64 KiB of strings and no object met twice, so a value built to hold the page's thread is refused at once. A worker that breaks any of these fails its run. Every message from a worker (a result, progress, a read request) is read once at the boundary: only its checked numbers, strings and one checked buffer are copied into a fresh record, and nothing the page keeps (the result handed to the save path, its `release()`, a read in flight) reaches the message itself, so anything else it carried is garbage at once. A run that ends lets go of its sources (each closed: a memory source drops its bytes), its input and its WebAssembly, so a handle kept afterwards holds none of the decrypted file.
- **A tool's reader** (the download engine's reader in its tool mode) keeps the file's last chunk for the run, fetches its padding once, and fetches at most four times the object before every read fails, so a parser made to seek without end cannot download the file over and over. With two chunks cached beside the last, four times is plenty for a tool that reads in offset order, and that is what tools do: extraction visits entries in the order of their offsets in the archive, not the order of the central directory, and compress and page edits read each source front to back. A tool that jumps about a large file can fail the limit on an honest file.
- **Padding, on every client.** Once a tool asks for the file's last chunk, every padding chunk after it is asked for too, whatever becomes of the tail's own fetch: past the fetch limit (the padding is not counted), past a cancel, a lock or a closed reader. Otherwise the store would see where the file ends inside its Padmé bucket. The padding is fetched as ciphertext only and thrown away, never opened: it needs the object's address, not the key, and holds nothing of the file (each of the file's own chunks is bound to the chunk count). Every padding chunk is attempted, one failing or not.
    - **Retries.** While the reader or run is live, a padding chunk is retried as the file's own chunks are (backoff, waiting for a network). Once it has ended, each is tried once, an expired address renewed once.
    - **A failure fails every later read, on every client**: the first padding chunk that fails to arrive fails the read waiting on it (the phones; on the web the tail is already returned) and every read after it. A run stops; it is not left to read on.
    - **On the web** the page fetches the padding beside the tail, streamed and counted (a store that sends more than asked is cut off, and one silent for two minutes is given up), so the read that wanted the tail doesn't wait. A closing reader drops its chunks, the tail's bytes and its key in the crypto worker first, then waits for the padding.
    - **On the phones** the core fetches the padding on the run's thread while the run goes on. Once the run has ended, it drops every opened chunk, hands the padding still owed to the app (`ObjectSource.drain_later`) and returns at once, so the one-run slot goes free at the cancel. The app drains those ranges in the background (`PaddingDrains`, ciphertext only, no key, no plaintext): one drain at a time for the process, at most 4 waiting behind it (more are dropped), and each drain gives up after 1 GiB of padding or 10 minutes, the deadline cutting off a request still in flight (at its next read: on Android a body that stalls outright ends at the 120 s read timeout). 1 GiB covers the padding of any file up to 8 GiB, past the 4 GiB extraction ceiling.
    - **On a metered network** (cellular, a hotspot, Low Data Mode) a background drain stops at 64 MiB, which covers the padding of files up to about 512 MiB. The trade-off: for a larger file whose run was cancelled on a metered network, the store sees where it ends, rather than the person paying for up to 1 GiB of bytes nobody reads.
    - **A sign-out** stops every background drain at once (`PaddingDrains.cancelAll`, from `AccountStore.wipe`): the waiting ones are dropped and the current request cut, since they hold the signed-out account's address and API client. Each reader takes the drains' generation when it is made, so padding a cancelled run hands over after the sign-out (its thread was still in the tail's fetch) is refused too. The cost: for a run cancelled shortly before signing out, the store sees where that file ends.
    - A drain cut short, for any of these reasons, leaves the store seeing where that file ends.
    - **Viewers** keep their own rule: they fetch the padding through the worker and ignore a failure.
- **The budget across accounts (phones).** A result released after a sign-out's clear takes nothing from the next account's count (`ToolBudget`'s generation).
- **The harness** is `apps/web/src/lib/tools/` (`run.ts` on the page, `worker.ts` in each tools worker, `sources.ts` for a Drive file as a source); `apps/web/scripts/check-worker-code.ts` fails the build if a shipped worker, or a chunk it imports, would need `unsafe-eval`, and if it can't find the workers the app is known to ship.
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
| Zip listing      | none             | central directory 16 MiB; 100,000 entries; 2,000,000 folders                               |
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
- **100,000 listed entries and a 16 MiB central directory** list any archive a person browses by hand (100,000 entries of ordinary names take about 10 MiB) and refuse a directory built to exhaust memory. The directory cap was 64 MiB until the listing kept every folder (below, phone limits); at 64 MiB a directory of nothing but folders took over a gigabyte between the worker and the page, so the web now has the phones' 16 MiB.
- **Depth 32** inside the archive leaves room under Drive's height bound of 64 for wherever the new folder sits. The extract also checks the destination's depth plus the archive's against 64 before starting.
- **Images: 100 megapixels and 64 MiB** are editing-design.md's limits, so one image module has one set.
- **1 GiB for Compress**, because the upload protocol needs the exact ciphertext size at begin, so the zip is finished in memory before it is queued. Streaming a store-only zip straight into an upload (its length is predictable) is later work.

### Zip bombs

- **Declared sizes first.** Before anything is created, the central directory's sums must be under the caps: total, count, per entry, and a declared compression ratio of at most 200:1 per entry once it declares over 1 MiB. A preview of an entry declaring more is refused before a byte is read.
- **Real bytes always.** Every entry is inflated through a counter.
    - Producing more than the entry declared is an error at that byte, not at the end. With the declared ratio capped, that bounds what an entry can produce; there is no running ratio for zip entries (owner, round 2 of the (a) review). A running one would only refuse honest files that start blank, such as a scanned page or a disk image, and adds nothing the declared size doesn't already bound.
    - The run's total and count are enforced on what was actually produced.
    - The CRC-32 (or AES authentication code) must match at the end of each entry, or the entry and the run fail.
- **Overlapping entries are refused.** Every entry's span, from its local header to the end of its data, must not overlap another's, and each local header's name and sizes must agree with the central directory's. This stops the non-recursive overlapping-file bomb and the parser confusion where two readers see different files.
- **Nested archives** are never opened by extraction or browsing; they are files.
- **tar.gz** has no declared sizes to hold it, so it keeps a running ratio: 200:1 on the gzip stream as a whole, once 1 MiB has come out, and 32 GiB decompressed for listing.
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
- **What a tools worker can still reach.** A tools worker's policy (below) names no source, so it sends nothing to any server: no fetch, no `import()` or `importScripts`, no socket, no worker of its own (`e2e/tools-harness.spec.ts` checks the server's log for every one of them). What no policy governs stays reachable, because the worker is same-origin: IndexedDB, Cache Storage, the origin private file system, BroadcastChannel and Web Locks. A worker taken over by a hostile file could read, fill or delete what the app keeps there (the tree mirror, its envelopes still sealed; the device key, non-exportable but usable; the sealed upload stash), write plaintext it was given to the device's storage, or tamper with the app's state through a channel or a lock. That is plaintext at rest on the device and tampering there, not plaintext leaving it: what the device key unlocks, the device bundle, is in `localStorage`, which workers cannot reach. Moving tools workers to an opaque origin (a sandboxed iframe) would close it; that is later work.

### Every result is encrypted before it leaves

Results go through the normal upload path and nothing else: fresh node and content keys, sealed metadata, the version envelope with its signature, Padmé padding, multipart upload with signed part lengths. No tool talks to the server except through that path and the existing read path.

### Cancellation and failure leave nothing

A cancel, a refusal, a 402, a watchdog or a closed tab:

1. terminates the run's workers, freeing their memory and WebAssembly heaps;
2. drops the page's buffers and revokes every blob URL the run made;
3. aborts the run's open uploads (`DELETE /api/drive/uploads/:id`; the server deletes their pending objects and releases the reservation);
4. deletes forever everything the run already published: the new folder for an extraction or Save as images, each new file otherwise. Deleted forever rather than moved to Trash, so the quota comes back at once and nothing half-made lingers. Where the person may not delete forever (to be checked for an editor in someone else's folder), the results go to Trash (checked: the server deletes forever only for a member of the workspace, so an editor's results go to the owner's Trash);
    - **New versions are not all or nothing.** A new version that already landed is kept, never rolled back (it may already be someone's current file, and earlier versions are untouched). The run says so: "The new version saved before that was kept", never "Nothing was saved".
    - A clean-up that cannot finish (no answer, an item refused, a delete forever left busy) keeps the run's row for the next open, which offers to delete what was made or keep it. One refused because the folder is no longer the person's (the share ended, the family was left) drops the row.
    - An upload the server is still completing after about ten seconds of asking is no answer, never taken as finished: the server publishes its node only once the store completes it, so it may still land. Its row stays, and the run says a new version among them may have been saved.
    - "Keep" at the next open always settles the row: it is marked kept (never offered, dropped by the open after), so a Delete chosen in another tab or screen from an older read finds it kept and sends nothing. On the web a run holds its own Web Lock for its whole life; Keep, Delete and the background settling of an interrupted run take that same lock only if it is free (or answer `busy` at once), so a run still live, a tab frozen with the lock held included, is never offered or recovered from under it, and two tabs' Keep and Delete never interleave. The phones take a per-run lock. Each reads the row again inside its turn before deciding, the next open's listing included: a row is retired, offered or settled only as read inside its run's lock. A run's clean-up, a folder that landed while it stopped included, finishes before its lock is let go, and a stop that fails still lets the lock go. This tab's own sign-out lets every upload's reservation go before its session ends on the server.
    - A completion's reply must name the node this run minted (or the file a version replaces), in the run's workspace; one naming anything else stops the run, and the row keeps the minted id, so a reply's id is never a deletion target. A result asked into another workspace than the run's is refused before anything is listed, minted or queued, and the phones refuse a destination their vault would resolve by id to another workspace's row.
    - A browser without IndexedDB or Web Locks starts no save run (the record would not outlive the tab, and nothing would keep other tabs from it), and offers nothing to recover. Every supported browser has both.
    - A folder creation's reply, and every re-look of a destination after a key change, must name the folder minted (or queued for) in the run's workspace; anything else stops the run and is never written into or removed. A folder creation refused outright for a key change (409 rotating) is asked again within ten minutes; one whose outcome is unknown is never sent again. The phones never write over a journal they can't read or decode (only a missing file is empty), and a folder sync that fails refuses the write.
    - Whether a clean-up may delete forever is true for the own Drive and a family folder this device knows, false only for a share the server lists, and not known otherwise (the row is kept after the trash, asked again later). A folder this client created is filed as it sent it, never as a reply describes it. A stale version gives back its thumbnail's room. On a server without the batch route the phones trash one item at a time, and a batch whose every item answers not found is uncertain: the row is kept and nothing settled (a folder not made yet and a space out of reach both answer 404). A row names the account that made it and the folders its run saves into: another account's row is never offered or acted on, and an item not found is taken for gone only by a member of the space, for a node never sent to be published, or while every one of those folders is still found. A waiting folder found in the Trash is recorded as holding an uncounted number of items, never none. A clean-up trashes or deletes forever in a family folder only while that folder may be written here (checked before every batch and resend); otherwise its row is kept. A sign-out while interrupted runs are read offers none of them.
    - An abort a family manager's pause refused (403 `held`, or `forbidden` with the pause's words from an older server) keeps its upload's id, as no answer does: in finish, in the quiet settling of a nodeless row, and when a stale version's reservation is let go. Uploads Keep could not abort are left to the server's expiry.
    - The row is written before anything it names is published: every id (an upload's, a new folder's, minted on the device) is on disk before the request that would publish it is sent. A write the device refuses is tried once more, and a second refusal stops the run.
    - One writer per journal file, removals included, so two runs starting at once never lose each other's row.
    - Every failure after a run starts, a folder's listing or creation included, stops it and cleans up.
    - What a stopped run says comes from what its clean-up found: "may still be there" for new files or folders it couldn't remove, "may have been saved" only for a new version whose completion was sent.
    - A finished run's row that the device won't remove is marked done: never offered for deletion, dropped by the next open. If neither the removal nor the mark is written, finish (or Keep) says the record couldn't be updated and can be asked again; it is never called done. The phones flush the journal file and its folder before relying on a row, as the web's strict IndexedDB writes do.
    - A begin answered after the run stopped is aborted, and a completion is never sent once it has: nothing lands that no row names.
    - A begin refused `stale` only because the file's key moved (its version the same) is looked up again and sealed afresh, never taken for someone else's save.
    - A stop cancels the run's uploads first, then waits for folder creations already sent, then its clean-up looks, so a folder the server makes after a cancel overtook it is still removed.
    - The web app's lock stops every run and cleans up, a result paused or completing included (the phones have no lock of their own: a sign-out abandons runs).
    - A new version whose completion was sent and whose abort answers 404 (the share may have ended) may have been saved, and is said so.
    - On iOS the journal records whose rows it holds (`AccountOwner`): signed in as another account, that account's rows are dropped unread; with nobody signed in nothing is read or deleted; a journal whose account is no longer the one signed in writes nothing. A journal's staging file goes when a write fails, at open (under the journal's lock), and at the sign-out's wipe.
    - A folder creation that got no answer (no network, a timeout, a 5xx, cancelled on its way) may still be made: a clean-up that doesn't find it keeps the row, says what was made may still be there, and the next open looks again. Only a refusal the server explained (a 4xx) settles that it wasn't made, except a 409 for the folder's own id: ids are minted on the device, so only an earlier send of the same request made it (a browser or URLSession may send a request again by itself when a reused connection drops; Android's DriveApi streams every write at a fixed length so it never does).
    - The row records each folder whose creation was sent as uncertain until it is answered. A clean-up that doesn't find an uncertain folder keeps the row: it may still be made for an hour after it was sent (`CREATION_SETTLE_MS`: the client's request timeout and the network's retransmissions bound it, not the server's upload window). If the person had answered "Delete what was made" and everything else went, the row keeps only those folders and the answer, and later opens only look for them in the background, never deleting: one found clears the answer, and the row is offered again with how many items the folder holds now; none found once the hour has passed lets the row go. The rows to offer come back before any of that runs. A folder, file or version still on its way (from the moment it is asked for, its folder listing included) makes finish refuse, and once a run has finished a later stop removes nothing. The background work, a live run's stop, and an interrupted run's clean-up send no request and write nothing after a sign-out, checked before each one: each trash batch, each delete forever, each retry of an abort or a busy delete, and each retry of the row's removal (never a `done` row written back for an account that signed out). A stop a sign-out cut short says what may still be there. A recovered row is compared and written in one transaction (the browser's IndexedDB readwrite transaction across tabs; the journal's lock on the phones), so another tab's Keep is never undone. An attach after a refused completion always lists the folder afresh. On the phones a clean-up's trash and delete forever go through the family write gate like any write, so a family folder's results are removed (the web's go through that folder's own client). Keep on the web also stops at a sign-out. A family manager's pause answers 403 `held` (not `forbidden`): a clean-up it refuses keeps its row, never taken for lost access, says that changes are paused in the family, and is asked about again at a later open. and leaves a row alone if it changed since it was read. A row with nothing made, only reservations to let go, is never offered.
    - A new version that lost a race and whose abort got no answer keeps its upload's id: a stop, finish and the next open ask again, and finish leaves a row with no nodes (never offered) when it still can't. Android's reservations ledger does this for its own uploads.
    - A key change's pause cut short stops the run like any other failure. A folder creation answered 409 for its own id is looked up and, when there, used as the folder.
    - A folder's creation is counted in the same locked step that checks the run isn't stopping and records its id, so a stop either refuses it or waits for it.
    - Two fault-injection tests on each client check this rule after failing every wait in turn. One drives a stand-in queue or drive (`save-runs.faults.test.ts`, `SaveRunFaultTests`, `SaveRunFaultTest`) with no network, a lost answer, a refusal, a full disk, a crash just after the server acted, an outage, the process dying, and a cancel, sign-out or lock at that wait. The other drives the real upload engine or vault over the fake server the engine's own tests use (`save-runs.engine.test.ts`, `SaveRunEngineTests`, `SaveRunEngineTest`), sampled with a fixed seed. Both also check the words: "Nothing was saved" only when nothing is there, kept versions that exist, "you'll be asked about it next time" only with a row the next open removes it by, and a finished save's results all there.
5. removes the run's journal row.

After a closed tab, steps 3 and 4 happen on the next open from the run's journal row, and the 24-hour upload expiry covers what is left.

### Content Security Policy

- **WebAssembly needs nothing new.** `script-src` already carries `'wasm-unsafe-eval'` (`apps/web/server/csp.ts`, for OPAQUE, libsodium, argon2 and pdf.js). `wasm-vips` and the HEIC decoder use the same permission. Nothing may need `'unsafe-eval'`.
    - The HEIC decoder's Emscripten glue must be built without dynamic code (`-sDYNAMIC_EXECUTION=0`).
    - A test fails the build if any shipped worker chunk contains `eval(` or `new Function(` reachable at runtime. OPAQUE's never-called js-sys detection stays the one known, inert exception.
- **Workers come from this origin.** New workers are module scripts Vite emits under `/assets/`, allowed by `worker-src 'self'`. New code creates no `blob:` or `data:` workers; zip.js's inline workers are turned off. WebAssembly files and pdf.js assets are fetched from this origin under `connect-src 'self'`.
- **Tools workers run under a policy that names no source.** A tools worker's file is `*.tool-worker.ts`; the server answers its script with a policy of its own (`buildToolWorkerCsp` in `apps/web/server/csp.ts`): `default-src 'none'; script-src 'wasm-unsafe-eval'; worker-src 'none'`. A `'self'` script source would not do: `import('/api/…?q=…')` would reach the server with the session cookie. So a tools worker is one self-contained file (the build fails on any import in one), and the page is its only way in or out: it compiles the WebAssembly the worker needs (`compileWasm`) and sends the Modules, and any data files as ArrayBuffers, in the start message. The dev server serves workers from source, outside this, so the policy is only in builds. Checked in Chromium; WebKit is not yet checked.
- **The nonce policy is untouched.** The per-request nonce only stamps TanStack's inline hydration script. Workers are not inline and need none. A production check confirms that worker script responses carry the same policy header (the Nitro `response` hook sets it on every response), so a worker's own policy is ours.

### Dependencies

| Library                           | Licence                                                                             | Use                                       | Status                       |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------- |
| `@zip.js/zip.js`                  | BSD-3-Clause                                                                        | Reading and writing zips, AES, ZipCrypto  | New (a), 2.24.0              |
| `zip` (Rust)                      | MIT                                                                                 | The phones' zip reading, AES, ZipCrypto   | New (a), 9.3.0               |
| `@cantoo/pdf-lib`                 | MIT                                                                                 | PDF writing: One PDF; later merge, split  | New (b), 2.11.1              |
| `pdfjs-dist`                      | Apache-2.0                                                                          | Page thumbnails, PDF to images            | Existing, 6.3.289            |
| `wasm-vips`                       | MIT; libvips LGPL-2.1-or-later; bundled codecs under BSD, MIT, IJG, libpng and LGPL | The image module                          | New (e), shared with editing |
| libheif and libde265 (Emscripten) | LGPL-3.0                                                                            | HEIC decoding where the browser has none  | New (e); see open questions  |
| `fflate`                          | MIT                                                                                 | Gzip fallback for multi-member tar.gz     | Existing                     |
| `client-zip`                      | MIT                                                                                 | Store-only zips for downloads (unchanged) | Existing, 2.5.0              |
| Tar parser                        | AGPL-3.0 (ours)                                                                     | tar and pax headers                       | New (g)                      |
| `pele`                            | MIT                                                                                 | Mermaid diagrams in Markdown (web only)   | New (editing), 1.13.0        |

All are compatible with AGPL-3.0:

- BSD, MIT and Apache-2.0 code may be combined into a GPLv3-family work.
- LGPL-2.1-or-later and LGPL-3.0 may be combined with AGPL-3.0. The LGPL libraries ship as separate `.wasm` files loaded at run time, so they can be replaced, and their source is published with ours.
- Each licence text goes into the third-party notices.

Rules:

- Exact versions in `package.json` (no `^` or `~`) and the lockfile, each at least two weeks old when added.
- An upgrade is its own pull request.
- Every engine sits behind a dynamic `import()`. The menus are static; dialogs and engines are lazy.
- The drive shell's entry chunk, measured gzipped from the built output as the bundle-weight pass measured it, grows by no more than 2 KiB per pull request. The pull request states the before and after.
- The archive reader is small and opens like a viewer, so it joins the post-unlock preload in `lib/viewers/preload.ts`. pdf-lib, `wasm-vips` and the HEIC decoder load on first use, like editing's image editor (section 5 says what that reveals).

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
- **Browsing a zip, as built (feature (a)).** On the web an archive over 16 MiB is read through the download engine's reader in its tool mode without the lifetime fetch cap (the person's actions, not a tool, drive its reads, and the page bounds each action's reads instead): its last chunk is kept, and the padding after it is fetched beside it and always to the end, so a zip refused at once still looks read to its end. Up to 16 MiB it is read whole, padding included. The phones keep one reader for each open archive, armed again for each call: the tail and its padding are fetched once for the session, and each call then fetches only the chunks it needs outside the two it caches and the tail. What is left: a call cancelled while the tail itself is being fetched fetches it again on the next call; a download runs on a second reader of its own (so previews don't wait), which fetches its own chunks; and up to three chunks of plaintext (about 24 MiB) stay in memory for as long as the archive is open.
- **Where the file ends, to an active store, a few bits.** The padding after a file is fetched as ciphertext and never opened, so it isn't authenticated. A store that changes bytes on purpose can flip a bit in one chunk and watch whether the tool run goes on: if it does, that chunk was padding. Each try costs it a run, and it learns a few bits of where the file ends inside its Padmé bucket. Viewers already allow the same, since they ignore a padding failure.
- **The shape of a tool's reads.** A store that knows the rule above sees, for an archive, the tail asked for and then the chunks after it asked for one by one; how many there are says how much of the object is padding, which is what Padmé exists to blur. The same pattern happens whether the run went on or was cancelled.
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
- **Limits** are lower on phones where memory is: the large-file card's thresholds take the device's memory into account. A zip's listing on a phone is capped at a 16 MiB central directory and 50,000 entries (the web: 16 MiB and 100,000).
- **Damaged items say one thing.** An entry whose bytes are damaged is refused with one sentence on every client, "This item is damaged, or isn't something HushOS can read.", whichever check noticed first (its stream, its declared size, its CRC, its AES code). The decoders behind each client notice damage at their own point on the same bytes (zlib-rs and the deflate64 crate in the core, zip.js's inflaters on the web), in both directions, so the codes can't be made to agree; the words can. The fuzz target `archive` and `apps/web/src/lib/archives/differential.ts` hold the web and the core to the same listing, the same bytes (by SHA-256) and the same words for every entry, and `bun run fuzz` runs both.
- **The listing is folders, not paths.** Every client lists the same way (`listEntries` in zip-format.ts, `list_entries` in the core): each entry is its folder's number and its name, and the folders are one array of parents and one string of names joined by `/` (a name never holds a separator), each folder after its parent. They are made a level at a time, every entry still going deeper taking its next part and finding the folder made already under the same parent, so nothing is held while listing but a few numbers an entry, and no entry keeps its parts. Memory grows with the directory's bytes and nothing else. A path more than 256 parts deep is listed flat under its whole path at the top (a directory entry listed flat makes no folder), and a listing makes at most 2,000,000 folders on every client: past that the archive is refused as `directory-too-large` ("This archive's list of contents is too large to open here."), since 2 million folders are about 24 MB of an app's arrays and a 16 MiB directory of nothing but folders could make 7.6 million. Mac resource entries under `__MACOSX/` make no folders, so every folder the list shows holds something it shows. The phones take the folders across the FFI once, as bytes (a little-endian u32 a folder), so an app holds two arrays and a string, never a million boxed numbers; the core keeps none after. Measured 2026-11-17 on the widest listings the caps allow (16 MiB directories, paths 256 parts deep), the core's peak with UniFFI's own lowering is about 108 MB for Fable's make_wide.py archive (12,450 entries, 2.1 million folders; 148 MB with the parts budget it replaced) and was about 161 MB for one whose 7.6 million folders are all different (29,967 entries of `<n>/a/a/…/f`), which the folder cap now refuses. Worker and page together on the web, under V8: about 360 and 470 MB at their peak, 140 and 240 MB kept.
- **The run harness** (built with step 3): the core's `VersionReader` (`crates/hushos-core/src/tools.rs`) reads a version by range through the app's `ObjectSource`, keeping two chunks and the file's last in memory, with the same fetch limit and padding rule as the web. `RunControl` holds cancel and the watchdog's clock; `ToolBudget`, one per process, holds the 512 MiB, so a finished run's results count until the save path releases them. `ToolRuns` in each app (`HushOSKit/Transfers/ToolRuns.swift`, `data/transfers/ToolRuns.kt`) runs one run at a time on a thread of its own. A thread cannot be terminated: a cancel or a timeout ends the run for the caller at once, cancels a request in flight and fails the work's next read, produce or progress call, and the next run starts only once that thread has returned. A sign-out ends every run (`ToolRuns.cancelAll`). When a run's thread returns, the app calls `RunControl.finish()`: a run not already cancelled or timed out is marked finished (not cancelled), and every reader made under it drops its chunks and key, again if an earlier end already did, since a read that passed its check just before the end refuses to cache what it opened once the run has ended.

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
2. **The save path's two modes** (section 2): new version with the stale choices, new file with the next free name, the in-memory byte source (already built for Save a copy), the quota estimate with its Vitest suite, signatures by source, the run journal with ids only. No interface of its own; its tests are the review.
3. **The tools worker harness:** the range port, the watchdog, cancel by terminate, the 512 MiB budget.
4. **Editing 1a:** the CodeMirror editor for text and code, explicit save as a new version through step 2, Save on top, Save as a copy and Open theirs.
5. **File tools (a):** browsing zips, on steps 1 and 3; the archive reader joins the preload.
6. **Editing 1b:** encodings and line endings, the Markdown preview beside the source, the editor in the post-unlock preload.
7. **File tools (b):** images to PDF; the first run in the transfers panel; pdf-lib arrives.
8. **Editing 1c:** sealed drafts.
9. **File tools (c):** PDF tools; page edits save new versions through step 2's first mode.
10. **File tools (d):** extraction; new folder, cleanup on cancel, every rule of section 3.
11. **File tools (e):** image conversion; builds the shared image module (`wasm-vips` worker, HEIC decoder). Editing milestone 3's image editor later sits on it. Open question 13 comes first.
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

## As built: (b) Images to PDF (2026-11-19)

On the web, the Rust core, iOS and Android together.

- **Entry.** Convert, then One PDF, on a selection that is all images a PDF takes (JPEG, PNG, HEIC, WebP, AVIF, GIF, BMP by type or extension; SVG, TIFF and icons are not offered): the row menu, the context menu and the selection bar's More on the web (a submenu), the item menu and the selection's More on iOS (a submenu), the item sheet and the selection's menu on Android (Convert opens a sheet whose one row is One PDF). Offered only where the person may add a file to the folder: their own folders and a family folder this device may write. Not yet in someone else's share, for an editor or a viewer ("into my files" is a follow-up).
- **Dialog.** The images in the list's order, to reorder by drag or by each image's Move earlier and Move later (buttons on the web and Android, VoiceOver and Switch Control actions on iOS, TalkBack actions on Android); page size Fit to each image, A4 or US Letter; margins None or 12 mm; the name, the first image's with `.pdf`, following the first image until typed. Letter when the browser's or phone's region is the US or Canada (on the web `Intl.Locale(...).maximize()`, so a bare `en` counts as the US), A4 elsewhere. "Location, camera and other photo details are left out." Past 64 MiB of images a sentence about memory and Continue; past 256 MiB or 500 images the dialog says so and offers nothing.
- **The JPEG cutter** (`lib/images-pdf/jpeg.ts`, `cut_jpeg` in `crates/hushos-core/src/images_pdf.rs`) is stricter than "cut EXIF, XMP and IPTC": it keeps the frame header (SOF0 to SOF2 at 8 bits, 1, 3 or 4 components), DHT, DQT, DRI and the scans, and of the application segments only APP0 `JFIF`, APP2 `ICC_PROFILE` and APP14 `Adobe`. Every other APPn (EXIF, XMP and extended XMP, IPTC in APP13, MPF, makers' own, JFXX thumbnails) and every comment is cut, between the scans of a progressive JPEG too, and so is everything after the end of the image (MPF's second picture with its own EXIF). Fill bytes before a marker go; stuffed zeros and restart markers in the scans stay. Arithmetic coding, lossless, hierarchical, 12-bit and a height set by DNL are refused as `unsupported`; a broken structure as `damaged`; a file that stops inside its scan data keeps what is there with an end marker added. The orientation is read from the first EXIF block before it goes (IFD0 tag 0x0112, SHORT, 1 to 8; anything else is upright).
- **Shared fixtures.** `e2e/fixtures/images/make.py` writes real JPEGs (libjpeg through Pillow, and cjpeg for restart markers and arithmetic coding) with segments around them, and works out each expected output from the parts it labels kept or dropped, not with either cutter. `expected.json` gives the output's SHA-256, size, frame, orientation and Adobe flag, or the refusal; `geometry.json` the page and matrix for every orientation, page size and margin. Both twins are held to both files.
- **Orientation and geometry** (`lib/images-pdf/geometry.ts`, `page_layout`). The image is drawn as stored and turned or mirrored by the page's matrix for each of the eight orientations; it is never re-encoded. Fit is a pixel to a point, scaled down when a side would pass 14,400 points (Acrobat's limit); on A4 and Letter the image fits inside the margins, larger or smaller as needed, centred, and the page turns landscape for a wider-than-tall image.
- **The web's engine.** `@cantoo/pdf-lib` 2.11.1 (exact), with its dependencies `culori` 4.0.2, `node-html-better-parser` 1.5.9 and `html-entities` 2.6.0 (for its SVG drawing, bundled but never called here), runs in `images-pdf.tool-worker.ts` under the harness: no `Info` dictionary (no Producer, Creator or dates), no object streams. A JPEG's image dictionary is written by our code (`lib/images-pdf/pdf.ts`), as the core writes it, rather than by pdf-lib's embedder, whose frame-header parse is looser than the cutter's; CMYK takes `Decode [1 0 1 0 1 0 1 0]`, as pdf-lib and pdfkit store Adobe's CMYK. A PNG goes through pdf-lib's embedder (its pixels, a soft mask for transparency, none of its chunks), embedded at once so its decoded pixels go. pdf-lib uses `Function` as a type tag in its argument checks; the Vite plugin `pdfLibWithoutFunctionTag` rewrites that tag to the string `'function'` (checked with `typeof`), so `check-worker-code.ts` passes with no exception added, and stops the build if pdf-lib's check moves.
- **Other kinds on the web.** HEIC, WebP, AVIF, GIF (the first frame) and BMP go through one function, `decodeForPdf` in `lib/images-pdf/decode.ts`: `createImageBitmap` (orientation applied) and `OffscreenCanvas`, JPEG at 0.92, or PNG when any pixel is transparent. It is the function step 11's image module replaces. Until then: the colour profile is not carried for these (the canvas draws sRGB); the encoded image is wrapped in a Blob for the browser to decode, one image at a time and no larger than the file, the exposure an image preview's blob URL already has; and HEIC opens only where the browser decodes it, elsewhere "This browser can’t open HEIC photos such as “…”. Use Safari, or HushOS on your phone."
- **Refusals** name the image (`damaged:<index>` and the rest, put into words by the page). The PDF is refused past 256 MiB (`too-large`); a decoded image past 100 megapixels on the web.
- **The run** (`lib/images-pdf/make.ts`). One save run (room checked as the images' total plus 1%, with a thumbnail allowance), then the tool run; the worker hands back a thumbnail of the first image (512 px, JPEG, at most 64 KiB) and the PDF, which is saved as a new file under the next free name, signed as the weakest of the images. Cancel, a refusal, a lock or a sign-out cancels the save run, which removes what it published.
- **First run in the transfers panel** (`lib/drive/runs/tool-run-rows.ts`). One row a run: "Making Trip.pdf", then "2 of 3 images", then the PDF's upload under the same row (its bytes, Pause and Resume; the upload's own row is left out while the run claims it, through the new `onQueued` on a produced file), then "Saved in …" or how it stopped. The header takes the run's headline while nothing else moves. Cancel asks "Stop making the PDF?" with "What was made so far is deleted." A sign-out forgets the rows.
- **First "interrupted" prompt** (`components/drive/interrupted-runs.tsx`, `lib/drive/runs/interrupted-runs.ts`). After each drive open, a run a closed tab left behind is offered: "Saving a file was interrupted. Delete what was made?" with Delete and Keep it. The row holds ids only, so it names a count, not a folder. The phones do not offer it yet: a phone run killed mid-save leaves its row for when they do.
- **The core's writer** (`ImagesPdfWriter`, UniFFI). A writer only, no PDF parser: a cut JPEG as a DCTDecode stream byte for byte, or RGBA pixels as FlateDecode RGB with a DeviceGray soft mask when any pixel is not opaque (premultiplied colour undone first); one page per image, written as each comes; then the page tree, the catalogue and the cross-reference table; no `Info`. Every call takes the run's `RunControl` (progress for the watchdog, and it fails once the run has ended). `images_pdf_max_pixels(memory)` is the phones' decoded-pixel cap, a sixty-fourth of the device's memory, 16 to 100 megapixels. `core-made.pdf` is the writer's output for six fixtures, held to the writer by a core test and opened with pdf.js by a web test; qpdf checks it where installed.
- **Phones.** iOS (`HushOSKit/Transfers/ImagesPdf.swift`, `App/Viewers/ImagesPdfSheet.swift`) decodes with ImageIO and Android (`data/transfers/ImagesPdf.kt`, `ui/viewers/ImagesPdfSheet.kt`) with ImageDecoder, both reading HEIC: a JPEG is never decoded; a PNG or any image with a transparent pixel goes in as pixels (lossless); anything else as JPEG at 92. The build runs in `ToolRuns` (its result counted in `ToolRuns.budget` until saved) and saves through `SaveRuns` as on the web. The run shows in the sheet (progress, Stop, which asks first), not yet in the phones' transfers lists.
- **Tests.** The cutter, orientation and geometry against the shared fixtures on both twins, plus every truncation of a progressive fixture; the writer read back by structure, by qpdf and by pdf.js; the web's PDF read back by pdf.js in Vitest (order, every orientation upright by sampled colour, margins, transparency, CMYK, grey, no metadata); iOS with PDFKit (order, upright, an ImageIO-made HEIC with orientation 6 upright on A4, PNG transparency, refusals); Android on the JVM (order, the cut stream's digest, the rotation matrix, refusals) and on a device with PdfRenderer (PNG transparency, WebP as JPEG, the pixel cap). The e2e (`e2e/images-pdf.spec.ts`), run against the production build: three images reordered read back with pdf.js, a GPS JPEG leaving nothing in the PDF's bytes, the phone photo upright, the PDF's stored size the padded size of its bytes, a cancel mid-upload leaving nothing on the server, and the plaintext checks.
- **After the first review.**
    - Only Adobe's complemented CMYK (an APP14 Adobe segment) takes `/Decode [1 0 1 0 1 0 1 0]`, in both writers; plain CMYK reads as it is (`plain-cmyk.jpg`).
    - On the web, an image's size is read from its header before anything decodes it (`lib/images-pdf/dimensions.ts`: PNG, JPEG, WebP, GIF, BMP, and HEIF/AVIF's largest `ispe`); unreadable or past 100 megapixels is refused, the thumbnail simply not made. Only kinds the browser must decode go to it as a Blob, and only up to `PREVIEW_LIMITS.image` (100 MiB): "“…” is too large to convert here. Save it as a JPEG or PNG first." The thumbnail is skipped past the same bound. A PNG is charged by the streams pdf-lib wrote for it, so the PDF stops growing before `save()`.
    - The worker tells the page when it is done with a source (`{ type: 'done' }` on its port), and the page closes that reader then, not at the run's end.
    - All three clients refuse images from more than one folder (search results can mix them): "These images are in different folders. Make a PDF from one folder at a time." The phones pin the destination when the sheet opens, from the selection, never from the order; Convert is offered only where the person may change the folder's files (`mayEdit`, `mayEditText`), not on an image shared on its own.
    - The phones read each image in pieces of 8 MiB (`readWhole`); the core refuses a read past 64 MiB. Their budget charge is a lease, given back however the run ends. A 401 under a read reaches the session check.
    - Android: Stop while saving holds the upload's completion (`holdTo`) and removes a PDF that landed first (`saveMade`); the run lives in `DriveViewModel` (`startImagesPdf`, `pdfRun`), so a rotation keeps it; the order and name are retained, page size and margins saved; rows are keyed by image, so a drag follows the finger past several rows. The decoded-pixel cap is the lower of the core's and a third of the app's heap (`memoryClass`, or `largeMemoryClass` with a large heap) at four bytes a pixel, and an opaque image goes to JPEG straight from its bitmap.
    - The in-app note is now "Location, camera and other photo details are left out." (a JPEG's ICC profile stays byte for byte and can name the device it was made for).
- **After the second review.**
    - Both cutters rewrite JFIF's APP0 to its 16 bytes with no thumbnail (version, units and density kept): its raw thumbnail was a second picture (`jfif-thumbnail.jpg`). JFXX is cut as before.
    - On the web a PNG is checked and stripped before pdf-lib sees it (`lib/images-pdf/png.ts`): an animated one (`acTL`) is refused ("“…” is animated. HushOS can’t put it in a PDF."); its image data is inflated once through a counter and refused past what its header says it holds; only IHDR, PLTE, tRNS, the image data and IEND reach pdf-lib; an `eXIf` orientation turns its page. HEIF's size comes from walking its boxes to the primary item's `ispe`.
    - The core's writer refuses an image before any of it is appended when it would pass the PDF's limit, and stops compressing pixels past what is left.
    - Run rows and the interrupted prompt are forgotten on a lock, on another account unlocking, and on a sign-out in another tab (`forgetOnLeaving`). A Stop confirmed after the run ended does nothing; a PDF saved whose record wasn't retired says "Saved in …. You may be asked about it next time."; a run waiting behind another says so from the start. Drive Home offers One PDF, into the images' own folder.
    - The phones' budget lease stays released: a charge taken after the release is given back at once. Android's sheet is a lazy list keyed by image (thumbnails decoded at the size drawn), and a swipe or a tap outside while it runs asks to Stop rather than hiding it (`Sheet(stayOpen)`).
    - The in-app note is "Location, camera and other photo details are left out." on every client; the security page says what is kept (a JPEG's colour profile) and what isn't.
- **After the third review.**
    - A JPEG that carries a whole ICC profile matching its components is drawn in it: `/ColorSpace [/ICCBased …]` with `/N` and the device space as `/Alternate`, in both writers (`iccProfile`, `jpeg_icc_profile`, held to `expected.json`'s `icc`); anything else falls back to the device space (`icc-mismatch.jpg`).
    - A PNG's header is held to the specification (depth for its colour type, compression and filter 0, interlace 0 or 1) before it bounds the inflation.
    - Forgetting run rows (a lock, another account, a sign-out elsewhere) removes the uploads they claimed too, one still on its way after it is cancelled; a failed run keeps its upload claimed. Interrupted-run lookups publish only for the unlock they began in. Past the ceiling the dialog shows only the refusal.
    - Android reads an image only when one array of it fits a third of the app's heap, and lowers the writer's output limit to a third of it too (`ImagesPdfWriter.limit_output`), so neither the input nor the PDF is larger than the heap can take ("The PDF would be too large to make on this phone. Choose fewer images."); each version reader is closed as soon as its image is read; a session's end cancels the run and clears its state.
- **After the fourth review.** Both cutters rewrite Adobe's APP14 to its 12 bytes, as they do JFIF (`adobe-trailing.jpg`); an ICC chunk numbered outside 1 to its count is no profile, never a crash (`icc-bad-sequence.jpg`). A PNG's palette and transparency are held to the specification's lengths for its colour type and depth. A start asked for while the engine loads is dropped if a lock came first (`toolRunRows.epoch`); Folder's and Home's shortcuts sleep while the dialog is open. Android closes its writer however a build ends. The interrupted prompt says what a recovered folder holds.
    - Follow-ups, not fixed here: HEIF's box walk allocates per box before the byte limit; a failed engine import closes the dialog without a word; Android's TalkBack reorder actions stay on while a run goes.
- **Left for later.** Results into one's own files from someone else's share; the phones' interrupted prompt and a run row in their transfers lists; the colour profile for decoded kinds (step 11); WebKit's e2e run (the spec runs there in CI); the oldest supported iPhone's memory, still unmeasured for 256 MiB of images.

## Open questions for the owner

1. **HEIC decoding outside Safari.** libheif with libde265 is LGPL and licence-compatible, but HEVC is patent-encumbered, and shipping a software decoder from hushos.com may need a licence in some countries. Ship it, or convert HEIC only where the browser decodes it (Safari) and say so elsewhere?
2. **editing-design.md assumes `wasm-vips` reads HEIC** (milestone 3, "HEIC to JPEG"). Its stock build reads HEIF as AVIF only, as far as is known, so editing needs the same decoder as question 1. Confirm before milestone 3 relies on it.
3. **pdf-lib's upstream** has had no release since 1.17.1 (2021), and it would parse untrusted PDFs. Use it pinned in a worker behind the watchdog, or the maintained MIT fork `@cantoo/pdf-lib`?
4. **Results don't survive a reload** (no plaintext stash; "Run it again" instead). Accept, or later seal queued results under a device-local key derived as editing's drafts are, so a reload resumes?
5. **Save a copy writes decrypted bytes to the origin private file system today** (`lib/drive/transfers/stash.ts`), which this note forbids for tools. Leave it, or move it to the same sealed approach in its own change?
6. **Quota for an editor in someone else's share** is checked only by the server's 402 mid-run. Accept, or add a server check that a run's total would fit, which tells editors roughly how much room the owner has?
7. **Cancel deletes forever** what the run made, all or nothing. Confirm, rather than keeping finished files.
8. **Metadata.** One PDF leaves out image metadata by default; Convert keeps it unless asked. Confirm the difference.
9. **The limits** of section 3, above all 4 GiB and 10,000 entries for extraction and 256 MiB for PDF work.

Open for step 11 (2026-11-17):

13. **wasm-vips needs threads, and a tools worker gets none.** wasm-vips's README (checked 2026-11-17) says a site using it must be cross-origin isolated: `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` on the page and on its script. That is for SharedArrayBuffer, which its Emscripten threads use, and those threads are workers it starts itself. HushOS sends COOP `same-origin` but no COEP, and a tools worker's policy refuses any worker of its own (`worker-src 'none'`) and any script load. So the stock build cannot run in a tools worker as built here. The ways on: a single-threaded build of wasm-vips (Emscripten without `-pthread`), slower on large images, which fits the policy as it is; or COEP `require-corp` on the whole app (every cross-origin resource, the object store's included, would need CORP or CORS headers) plus a narrow exception for the worker's own thread workers, which reopens part of what the policy closes. The recommendation is the single-threaded build, measured on the oldest supported iPhone before (e) ships. Nothing was added.

Open in editing-design.md that bear on milestone 1 (that document's decisions are not changed here):

10. **When the stale check fires.** Until milestone 2's `versionOf`, a stale save is caught at upload completion, not at begin: the bytes go up and are then aborted or attached as a copy. Accept that for milestone 1, or move the begin-time check forward?
11. **Family folders.** editing-design.md names owners, editors, viewers and link visitors. Confirm that family members edit family files, refused while the folder is read-only on the device or its keys changed.
12. **Text above 8 MiB** opens read-only there. Should the large-file card's Continue allow editing up to a higher ceiling, or stay read-only? This note assumes read-only.

## Owner decisions (2026-10-19)

The open questions above are answered as recommended, with two changes:

- **Results and reload (4):** accepted that a tool's results don't survive a reload, but while any result is still waiting to upload, the page asks before it unloads (`beforeunload`), so a reload or close isn't silent. One listener asks for everything that would be lost (uploads, results waiting to upload, results not yet handed over: `apps/web/src/lib/platform/leave-guard.ts`), so the browser never asks twice.
- **Text over 8 MiB (12):** opens read only, with the large-file card offering editing behind a warning about memory and speed, up to the text ceiling.
- **PDF writing:** `@cantoo/pdf-lib` (MIT; 2.7.1, actively released, though its maintainers promise support only for their own roadmap), pinned to an exact version and run in a worker; vendored if it goes quiet. pdf.js stays the reader (rendering, PDF to images, page thumbnails).
- **HEIC (1):** convert only where the browser decodes HEIC; a software decoder waits for a licence and patent check. **wasm-vips and HEIC (2):** verified in that PR.
- **Save a copy (5):** its stash is sealed in the worker under a key derived from the account key and deleted on an explicit lock or sign-out (done; drive-design.md, the queued-upload journal). The copy uploads from the in-memory byte source of section 2, which landed with it, so it is never a Blob.
- **Out of room in someone else's share (6):** a clear "no room" message and a clean-up; the owner's free space is never revealed.
- **Cancel (7):** all or nothing, Trash for editors. **Metadata (8):** One PDF drops image metadata by default; Convert keeps it unless asked. **Limits (9):** as above. **Stale save (10):** accepted until milestone 2. **Family members edit family files (11):** yes.
