//! Edit pages in the phone apps (docs/file-tools-design.md, feature (c)): reading a PDF's pages, its
//! warnings and its refusals, and writing new PDFs from pages of one or several, with `lopdf`. Both
//! phones write PDFs here; PDFKit and PdfRenderer only draw (thumbnails, Save as images).
//!
//! The web's twin is `apps/web/src/lib/pdf-tools/structure.ts` (pdf-lib). Both are held to
//! `e2e/fixtures/pdfs/expected.json`, rule for rule:
//!
//! - **Refused:** an `/Encrypt` entry in the trailer (`encrypted`), before anything else is looked
//!   at; a file that doesn't load, a catalog or page tree that isn't a dictionary, a page tree node
//!   met twice (a cycle), deeper than [`PAGE_TREE_MAX_DEPTH`], a kid that is missing or isn't a
//!   dictionary, or no pages at all (`damaged`); more than [`PDF_TOOLS_MAX_PAGES`] pages
//!   (`too-many-pages`); an output past its limit (`too-large`).
//! - **The page tree is walked here,** without recursion and never by lopdf's own page walk. A node
//!   is a page when its /Type is /Page, a tree node when it is /Pages, and otherwise by whether it
//!   has /Kids. MediaBox, CropBox, Resources and Rotate are inherited down.
//! - **A page's size** is its MediaBox (US Letter when it has none); its rotation is /Rotate when it
//!   is a whole multiple of 90, turned into 0, 90, 180 or 270, and 0 otherwise.
//! - **Warnings:** `signed` when an AcroForm field (its /FT inherited from its parents) is /Sig and
//!   its value is a dictionary with /ByteRange; `outline` when the catalog's /Outlines has a /First;
//!   `form` when the AcroForm's /Fields is a non-empty array.
//! - **Every output is new:** pages copied into a new document, each with its inherited entries made
//!   its own and its /Rotate set; nothing else of the source's catalog (no outline, no AcroForm), no
//!   document information dictionary (no Producer, Creator or dates), no object streams, a classic
//!   cross-reference table.
//! - **Copying is bounded:** each object is copied once, by reference, with a work list rather than
//!   recursion through references (a reference cycle is copied as a cycle); a reference to another
//!   page or to a page tree node becomes null, so an annotation's /P never drags the whole source
//!   in; direct nesting deeper than [`NESTING_MAX_DEPTH`] is damage. lopdf's own parser refuses
//!   brackets nested past 100 and bounds each decompressed stream (here to the output limit).
//!
//! Hostile input is the normal case: the caller caps the input (the limits below), every step calls
//! the run's [`RunControl`] so the watchdog hears of it and a cancel stops it at the next, and
//! nothing here recurses on the file's structure.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use lopdf::xref::XrefType;
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId, Stream};
use zeroize::Zeroizing;

use crate::{CoreError, RunControl};

const MIB: u64 = 1024 * 1024;

/// Past this much of PDFs, the dialog asks first (the large-file card).
pub const PDF_TOOLS_CARD_BYTES: u64 = 64 * MIB;
/// The most PDFs, by their files' bytes, read in one run (all of them, when merging).
pub const PDF_TOOLS_MAX_INPUT_BYTES: u64 = 256 * MIB;
/// The most PDFs in one run.
pub const PDF_TOOLS_MAX_FILES: u32 = 100;
/// The most pages read from all of them.
pub const PDF_TOOLS_MAX_PAGES: u32 = 2_000;
/// The largest PDF made: what can be held as one in-memory upload.
pub const PDF_TOOLS_MAX_OUTPUT_BYTES: u64 = 256 * MIB;
/// Save as images: past this many pages the dialog asks first; at most this many, each at most
/// this many pixels.
pub const PDF_IMAGES_CARD_PAGES: u32 = 50;
pub const PDF_IMAGES_MAX_PAGES: u32 = 500;
pub const PDF_IMAGES_MAX_PIXELS: u64 = 40_000_000;

/// Page tree levels walked before a file is taken for damaged; real files use a handful.
pub const PAGE_TREE_MAX_DEPTH: usize = 256;
/// Arrays and dictionaries inside one another, directly, past which a page is damaged.
pub const NESTING_MAX_DEPTH: usize = 512;
/* AcroForm field levels and fields looked at for a signature; past them the search stops. */
const FIELD_MAX_DEPTH: usize = 64;
const FIELDS_MAX: usize = 10_000;
/* Objects copied between two progress calls. */
const OBJECTS_PER_PROGRESS: usize = 256;
/* Letter, when a page has no MediaBox anywhere above it (what readers assume). */
const DEFAULT_SIZE: (f64, f64) = (612.0, 792.0);
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// Why a PDF or an output was refused, as a code each app puts into words (the web uses the same).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfRefusal {
    Encrypted,
    Damaged,
    TooManyPages,
    TooLarge,
}

impl PdfRefusal {
    pub fn code(self) -> &'static str {
        match self {
            PdfRefusal::Encrypted => "encrypted",
            PdfRefusal::Damaged => "damaged",
            PdfRefusal::TooManyPages => "too-many-pages",
            PdfRefusal::TooLarge => "too-large",
        }
    }
}

/// A refusal with its code, or the run ending underneath it (a cancel, the watchdog), in the
/// person's words.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum PdfToolsError {
    #[error("{code}")]
    Refused { code: String },
    /* Not `message`, which Kotlin's Throwable already has. */
    #[error("{reason}")]
    Failed { reason: String },
}

impl From<PdfRefusal> for PdfToolsError {
    fn from(refusal: PdfRefusal) -> Self {
        PdfToolsError::Refused { code: refusal.code().into() }
    }
}

impl From<CoreError> for PdfToolsError {
    fn from(error: CoreError) -> Self {
        PdfToolsError::Failed { reason: error.to_string() }
    }
}

/// The limits above, for the apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PdfToolsLimits {
    pub card_bytes: u64,
    pub max_input_bytes: u64,
    pub max_files: u32,
    pub max_pages: u32,
    pub max_output_bytes: u64,
    pub images_card_pages: u32,
    pub images_max_pages: u32,
    pub images_max_pixels: u64,
}

/// The limits for a phone with `device_memory_bytes` of memory (docs/file-tools-design.md,
/// section 6: phone limits follow the device's memory). lopdf holds the parsed sources and the
/// output beside the input, several times the input at peak, so the input is held to a sixteenth
/// of the memory, between 32 MiB and the web's 256 MiB, and the card to a quarter of that, at most
/// 64 MiB. A phone app may lower them further for its own heap.
///
/// ```
/// let limits = hushos_core::pdf_tools_limits(8 << 30);
/// assert_eq!(limits.max_input_bytes, 256 << 20);
/// assert_eq!(limits.card_bytes, 64 << 20);
/// let small = hushos_core::pdf_tools_limits(2 << 30);
/// assert_eq!(small.max_input_bytes, 128 << 20);
/// assert_eq!(small.card_bytes, 32 << 20);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pdf_tools_limits(device_memory_bytes: u64) -> PdfToolsLimits {
    let max_input = (device_memory_bytes / 16).clamp(32 * MIB, PDF_TOOLS_MAX_INPUT_BYTES);
    PdfToolsLimits {
        card_bytes: (max_input / 4).min(PDF_TOOLS_CARD_BYTES),
        max_input_bytes: max_input,
        max_files: PDF_TOOLS_MAX_FILES,
        max_pages: PDF_TOOLS_MAX_PAGES,
        max_output_bytes: max_input.min(PDF_TOOLS_MAX_OUTPUT_BYTES),
        images_card_pages: PDF_IMAGES_CARD_PAGES,
        images_max_pages: PDF_IMAGES_MAX_PAGES,
        images_max_pixels: PDF_IMAGES_MAX_PIXELS,
    }
}

/// An image's size for a page of `width` by `height` points turned by `rotate`, at `dpi`: points are
/// 1/72 inch, rounded to the nearest pixel, at least one. Every client sizes the same way.
///
/// ```
/// assert_eq!(hushos_core::pdf_image_size(612.0, 792.0, 90, 300), vec![3300, 2550]);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pdf_image_size(width: f64, height: f64, rotate: u32, dpi: u32) -> Vec<u32> {
    let scale = dpi as f64 / 72.0;
    let w = (width * scale).round().max(1.0) as u32;
    let h = (height * scale).round().max(1.0) as u32;
    if rotate == 90 || rotate == 270 {
        vec![h, w]
    } else {
        vec![w, h]
    }
}

/// A page as its PDF has it: the MediaBox's size in points, unrotated, and its /Rotate.
#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PdfPage {
    pub width: f64,
    pub height: f64,
    pub rotate: u32,
}

/// What a PDF is: its pages in order, and what saving it may lose.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PdfInspection {
    pub pages: Vec<PdfPage>,
    pub signed: bool,
    pub outline: bool,
    pub form: bool,
}

/// One page of an output: which source (in the order added), which of its pages (from 0), and the
/// rotation it is to have (0, 90, 180 or 270).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PdfPagePlan {
    pub source: u32,
    pub page: u32,
    pub rotate: u32,
}

/// /Rotate as a reader takes it: a whole multiple of 90 turned into 0, 90, 180 or 270; else 0.
pub fn rotation_of(value: Option<f64>) -> u32 {
    match value {
        Some(value) if value.is_finite() && value.fract() == 0.0 && value % 90.0 == 0.0 => {
            ((value % 360.0 + 360.0) % 360.0) as u32
        }
        _ => 0,
    }
}

struct PageNode {
    /* The page's own dictionary as the source holds it. */
    leaf: Dictionary,
    /* Its object id, or None for a page written directly into its parent's /Kids. */
    id: Option<ObjectId>,
    /* Shared with its tree's other pages: one copy of what a node gives all below it. */
    inherited: Arc<Inherited>,
    info: PdfPage,
}

type Inherited = Vec<(&'static [u8], Object)>;

/* Optional content (layers): every group of the catalog's /OCProperties, and those off by default. */
struct Layers {
    groups: Vec<ObjectId>,
    off: HashSet<ObjectId>,
}

struct Source {
    doc: Document,
    pages: Vec<PageNode>,
    /* Every page tree node's id, pages included: a reference to one is never copied. */
    tree: HashSet<ObjectId>,
    layers: Option<Layers>,
}

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    match object {
        Object::Reference(id) => doc.objects.get(id),
        other => Some(other),
    }
}

fn get<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    dict.get(key).ok().and_then(|object| resolve(doc, object))
}

fn number(doc: &Document, object: Option<&Object>) -> Option<f64> {
    match object.and_then(|object| resolve(doc, object)) {
        Some(Object::Integer(value)) => Some(*value as f64),
        Some(Object::Real(value)) => Some(*value as f64),
        _ => None,
    }
}

fn size_of(doc: &Document, media_box: Option<&Object>) -> (f64, f64) {
    let Some(Object::Array(items)) = media_box.and_then(|object| resolve(doc, object)) else {
        return DEFAULT_SIZE;
    };
    if items.len() != 4 {
        return DEFAULT_SIZE;
    }
    let values: Option<Vec<f64>> = items.iter().map(|item| number(doc, Some(item))).collect();
    match values {
        Some(v) => ((v[2] - v[0]).abs(), (v[3] - v[1]).abs()),
        None => DEFAULT_SIZE,
    }
}

fn is_name(object: Option<&Object>, name: &[u8]) -> bool {
    matches!(object, Some(Object::Name(value)) if value == name)
}

/*
 * Parses `bytes`, refusing a password before anything else is looked at: by the trailer as written
 * (lopdf's metadata reader, which decrypts nothing), then by what loading found, since lopdf opens
 * a PDF whose user password is empty and takes /Encrypt out of the trailer it keeps.
 */
fn load(bytes: &[u8], max_stream: u64) -> Result<Document, PdfRefusal> {
    if Document::load_metadata_mem(bytes).is_ok_and(|metadata| metadata.encrypted) {
        return Err(PdfRefusal::Encrypted);
    }
    let options = LoadOptions { max_decompressed_size: Some(max_stream as usize), ..LoadOptions::default() };
    match Document::load_mem_with_options(bytes, options) {
        Ok(doc) if doc.trailer.has(b"Encrypt") || doc.encryption_state.is_some() => {
            Err(PdfRefusal::Encrypted)
        }
        Ok(doc) => Ok(doc),
        Err(_) => Err(PdfRefusal::Damaged),
    }
}

fn walk_pages(
    doc: &Document,
    max_pages: usize,
    control: &RunControl,
) -> Result<(Vec<PageNode>, HashSet<ObjectId>), PdfToolsError> {
    let catalog = match doc.trailer.get(b"Root").ok().and_then(|root| resolve(doc, root)) {
        Some(Object::Dictionary(catalog)) => catalog,
        _ => return Err(PdfRefusal::Damaged.into()),
    };
    let mut pages = Vec::new();
    let mut tree = HashSet::new();
    struct Work {
        node: Object,
        inherited: Arc<Inherited>,
        depth: usize,
    }
    let root = catalog.get(b"Pages").cloned().unwrap_or(Object::Null);
    let mut stack = vec![Work { node: root, inherited: Arc::new(Vec::new()), depth: 0 }];
    while let Some(Work { node, inherited, depth }) = stack.pop() {
        if depth > PAGE_TREE_MAX_DEPTH {
            return Err(PdfRefusal::Damaged.into());
        }
        let id = match node {
            Object::Reference(id) => {
                if !tree.insert(id) {
                    return Err(PdfRefusal::Damaged.into());
                }
                Some(id)
            }
            // Written directly into its parent: a value, so never met twice; the depth bounds it.
            _ => None,
        };
        let dict = match resolve(doc, &node) {
            Some(Object::Dictionary(dict)) => dict,
            _ => return Err(PdfRefusal::Damaged.into()),
        };
        // A node that sets nothing inheritable passes its parent's on as they are, shared.
        let mut own = inherited;
        for key in INHERITED {
            if let Ok(value) = dict.get(key) {
                if !matches!(value, Object::Null) {
                    let entries = Arc::make_mut(&mut own);
                    entries.retain(|(name, _)| *name != key);
                    entries.push((key, value.clone()));
                }
            }
        }
        let kind = get(doc, dict, b"Type");
        let kids = get(doc, dict, b"Kids");
        let is_tree =
            is_name(kind, b"Pages") || (!is_name(kind, b"Page") && matches!(kids, Some(Object::Array(_))));
        if is_tree {
            let Some(Object::Array(kids)) = kids else {
                return Err(PdfRefusal::Damaged.into());
            };
            // Work waiting is bounded as pages are: past it, more pages than a run takes.
            if stack.len() + kids.len() > max_pages + PAGE_TREE_MAX_DEPTH {
                return Err(PdfRefusal::TooManyPages.into());
            }
            for kid in kids.iter().rev() {
                stack.push(Work { node: kid.clone(), inherited: Arc::clone(&own), depth: depth + 1 });
            }
            continue;
        }
        if pages.len() >= max_pages {
            return Err(PdfRefusal::TooManyPages.into());
        }
        let find = |key: &[u8]| own.iter().find(|(name, _)| *name == key).map(|(_, value)| value);
        let (width, height) = size_of(doc, find(b"MediaBox"));
        // The boxes are in the page's own units: /UserUnit points each (not inherited).
        let unit = number(doc, dict.get(b"UserUnit").ok())
            .filter(|unit| unit.is_finite() && *unit > 0.0)
            .unwrap_or(1.0);
        let (width, height) = (width * unit, height * unit);
        let rotate = rotation_of(number(doc, find(b"Rotate")));
        pages.push(PageNode {
            leaf: dict.clone(),
            id,
            inherited: own,
            info: PdfPage { width, height, rotate },
        });
        if pages.len().is_multiple_of(100) {
            control.progress()?;
        }
    }
    if pages.is_empty() {
        return Err(PdfRefusal::Damaged.into());
    }
    Ok((pages, tree))
}

fn flags_of(doc: &Document) -> (bool, bool, bool) {
    let Some(Object::Dictionary(catalog)) = doc.trailer.get(b"Root").ok().and_then(|root| resolve(doc, root))
    else {
        return (false, false, false);
    };
    let outline = match get(doc, catalog, b"Outlines") {
        Some(Object::Dictionary(outlines)) => {
            matches!(get(doc, outlines, b"First"), Some(Object::Dictionary(_)))
        }
        _ => false,
    };
    let fields = match get(doc, catalog, b"AcroForm") {
        Some(Object::Dictionary(form)) => match get(doc, form, b"Fields") {
            Some(Object::Array(fields)) => Some(fields),
            _ => None,
        },
        _ => None,
    };
    let form = fields.is_some_and(|fields| !fields.is_empty());
    let signed = form && fields.is_some_and(|fields| has_signature(doc, fields));
    (signed, outline, form)
}

/* A field, its /FT inherited from its parents, that is /Sig with a value holding /ByteRange. */
fn has_signature(doc: &Document, fields: &[Object]) -> bool {
    let mut stack: Vec<(&Object, Option<&Object>, usize)> =
        fields.iter().map(|field| (field, None, 0)).collect();
    let mut seen: HashSet<*const Dictionary> = HashSet::new();
    let mut looked = 0;
    while let Some((node, inherited, depth)) = stack.pop() {
        if looked >= FIELDS_MAX {
            break;
        }
        let Some(Object::Dictionary(field)) = resolve(doc, node) else { continue };
        if depth > FIELD_MAX_DEPTH || !seen.insert(field as *const Dictionary) {
            continue;
        }
        looked += 1;
        let kind = get(doc, field, b"FT").or(inherited);
        if is_name(kind, b"Sig") {
            if let Some(Object::Dictionary(value)) = get(doc, field, b"V") {
                if value.has(b"ByteRange") {
                    return true;
                }
            }
        }
        if let Some(Object::Array(kids)) = get(doc, field, b"Kids") {
            for kid in kids {
                stack.push((kid, kind, depth + 1));
            }
        }
    }
    false
}

fn read(
    bytes: &[u8],
    max_pages: usize,
    max_stream: u64,
    control: &RunControl,
) -> Result<Source, PdfToolsError> {
    control.progress()?;
    let doc = load(bytes, max_stream)?;
    control.progress()?;
    let (pages, tree) = walk_pages(&doc, max_pages, control)?;
    let layers = layers_of(&doc);
    Ok(Source { doc, pages, tree, layers })
}

/*
 * The catalog's optional content: every group, and those off by its default configuration (/D):
 * with /BaseState /OFF, all but those listed /ON; otherwise those listed /OFF.
 */
fn layers_of(doc: &Document) -> Option<Layers> {
    let Some(Object::Dictionary(catalog)) = doc.trailer.get(b"Root").ok().and_then(|root| resolve(doc, root))
    else {
        return None;
    };
    let Some(Object::Dictionary(properties)) = get(doc, catalog, b"OCProperties") else { return None };
    let ids = |value: Option<&Object>| -> Vec<ObjectId> {
        match value {
            Some(Object::Array(items)) => items.iter().filter_map(|item| item.as_reference().ok()).collect(),
            _ => Vec::new(),
        }
    };
    let groups: Vec<ObjectId> = ids(get(doc, properties, b"OCGs"))
        .into_iter()
        .filter(|id| matches!(doc.objects.get(id), Some(Object::Dictionary(_))))
        .collect();
    if groups.is_empty() {
        return None;
    }
    let settings = match get(doc, properties, b"D") {
        Some(Object::Dictionary(settings)) => Some(settings),
        _ => None,
    };
    let list = |key: &[u8]| ids(settings.and_then(|settings| get(doc, settings, key)));
    let off: HashSet<ObjectId> =
        if is_name(settings.and_then(|settings| get(doc, settings, b"BaseState")), b"OFF") {
            let on: HashSet<ObjectId> = list(b"ON").into_iter().collect();
            groups.iter().copied().filter(|group| !on.contains(group)).collect()
        } else {
            list(b"OFF").into_iter().filter(|group| groups.contains(group)).collect()
        };
    Some(Layers { groups, off })
}

fn inspection(source: &Source) -> PdfInspection {
    let (signed, outline, form) = flags_of(&source.doc);
    PdfInspection { pages: source.pages.iter().map(|page| page.info).collect(), signed, outline, form }
}

/// What a PDF is, read and let go of: its pages, its warnings, or why it can't be edited.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn pdf_inspect(bytes: Vec<u8>, control: Arc<RunControl>) -> Result<PdfInspection, PdfToolsError> {
    let bytes = Zeroizing::new(bytes);
    let source = read(&bytes, PDF_TOOLS_MAX_PAGES as usize, PDF_TOOLS_MAX_OUTPUT_BYTES, &control)?;
    Ok(inspection(&source))
}

/* Resource categories a content stream names, and the operators that name them. */
const CATEGORIES: [&[u8]; 7] =
    [b"Font", b"XObject", b"ExtGState", b"ColorSpace", b"Pattern", b"Shading", b"Properties"];
/* Content streams scanned for one page, forms and glyphs included, before it is damage. */
const SCANNED_STREAMS_MAX: usize = 4_096;
/* Decoded content scanned for one page, in all. */
const SCANNED_BYTES_MAX: usize = 64 << 20;

/* The resource names a page's drawing uses, by category. */
#[derive(Default)]
struct Used {
    names: HashMap<&'static [u8], HashSet<Vec<u8>>>,
}

impl Used {
    fn add(&mut self, category: &'static [u8], name: Vec<u8>) {
        self.names.entry(category).or_default().insert(name);
    }
    fn has(&self, category: &[u8], name: &[u8]) -> bool {
        self.names.get(category).is_some_and(|names| names.contains(name))
    }
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | 0)
}

fn is_delimiter(byte: u8) -> bool {
    matches!(byte, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

/* A name's bytes, its #xx escapes decoded; `at` is just past the slash. Returns the name and where it ends. */
fn read_name(data: &[u8], mut at: usize) -> (Vec<u8>, usize) {
    let mut name = Vec::new();
    while at < data.len() && !is_space(data[at]) && !is_delimiter(data[at]) {
        if data[at] == b'#' && at + 2 < data.len() {
            if let Ok(value) =
                u8::from_str_radix(std::str::from_utf8(&data[at + 1..at + 3]).unwrap_or("zz"), 16)
            {
                name.push(value);
                at += 3;
                continue;
            }
        }
        name.push(data[at]);
        at += 1;
    }
    (name, at)
}

/*
 * Every resource name a content stream uses: Do (XObject), Tf (Font), gs (ExtGState), sh (Shading),
 * cs/CS (ColorSpace), scn/SCN with a name (Pattern), BDC/DP with a name (Properties), and an inline
 * image's /CS. Strings, arrays, dictionaries and inline image data are skipped whole, so a name inside
 * them is never taken for an operand. The web's twin is `usedNames` in lib/pdf-tools/content.ts.
 */
fn scan_content(data: &[u8], used: &mut Used) {
    #[derive(Clone)]
    enum Operand {
        Name(Vec<u8>),
        Other,
    }
    let mut operands: Vec<Operand> = Vec::new();
    let mut depth = 0usize;
    let mut at = 0usize;
    let last_name = |operands: &[Operand], back: usize| -> Option<Vec<u8>> {
        match operands.len().checked_sub(back).and_then(|i| operands.get(i)) {
            Some(Operand::Name(name)) => Some(name.clone()),
            _ => None,
        }
    };
    let device = |name: &[u8]| {
        matches!(
            name,
            b"DeviceGray"
                | b"DeviceRGB"
                | b"DeviceCMYK"
                | b"Pattern"
                | b"G"
                | b"RGB"
                | b"CMYK"
                | b"I"
                | b"Indexed"
        )
    };
    while at < data.len() {
        let byte = data[at];
        if is_space(byte) {
            at += 1;
            continue;
        }
        match byte {
            b'%' => {
                while at < data.len() && data[at] != b'\n' && data[at] != b'\r' {
                    at += 1;
                }
            }
            b'/' => {
                let (name, end) = read_name(data, at + 1);
                at = end;
                if depth == 0 {
                    operands.push(Operand::Name(name));
                }
            }
            b'(' => {
                let mut nesting = 0usize;
                while at < data.len() {
                    match data[at] {
                        b'\\' => at += 1,
                        b'(' => nesting += 1,
                        b')' => {
                            nesting -= 1;
                            if nesting == 0 {
                                at += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    at += 1;
                }
                if depth == 0 {
                    operands.push(Operand::Other);
                }
            }
            b'<' if data.get(at + 1) == Some(&b'<') => {
                depth += 1;
                at += 2;
            }
            b'>' if data.get(at + 1) == Some(&b'>') => {
                depth = depth.saturating_sub(1);
                at += 2;
                if depth == 0 {
                    operands.push(Operand::Other);
                }
            }
            b'<' => {
                while at < data.len() && data[at] != b'>' {
                    at += 1;
                }
                at += 1;
                if depth == 0 {
                    operands.push(Operand::Other);
                }
            }
            b'[' => {
                depth += 1;
                at += 1;
            }
            b']' => {
                depth = depth.saturating_sub(1);
                at += 1;
                if depth == 0 {
                    operands.push(Operand::Other);
                }
            }
            b'{' | b'}' | b'>' | b')' => at += 1,
            _ => {
                let start = at;
                while at < data.len() && !is_space(data[at]) && !is_delimiter(data[at]) {
                    at += 1;
                }
                let word = &data[start..at];
                if depth > 0 {
                    continue;
                }
                if word.first().is_some_and(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.'))
                    || word == b"true"
                    || word == b"false"
                    || word == b"null"
                {
                    operands.push(Operand::Other);
                    continue;
                }
                match word {
                    b"Do" => last_name(&operands, 1).into_iter().for_each(|name| used.add(b"XObject", name)),
                    b"Tf" => last_name(&operands, 2).into_iter().for_each(|name| used.add(b"Font", name)),
                    b"gs" => {
                        last_name(&operands, 1).into_iter().for_each(|name| used.add(b"ExtGState", name))
                    }
                    b"sh" => last_name(&operands, 1).into_iter().for_each(|name| used.add(b"Shading", name)),
                    b"cs" | b"CS" => last_name(&operands, 1)
                        .filter(|name| !device(name))
                        .into_iter()
                        .for_each(|name| used.add(b"ColorSpace", name)),
                    b"scn" | b"SCN" => {
                        last_name(&operands, 1).into_iter().for_each(|name| used.add(b"Pattern", name))
                    }
                    // A tag, then a property list: named when it is a resource.
                    b"BDC" | b"DP" if operands.len() >= 2 => {
                        last_name(&operands, 1).into_iter().for_each(|name| used.add(b"Properties", name))
                    }
                    b"BI" => {
                        // The inline image's dictionary up to ID: its colour space may be a resource name.
                        let mut key: Option<Vec<u8>> = None;
                        loop {
                            while at < data.len() && is_space(data[at]) {
                                at += 1;
                            }
                            if at >= data.len() {
                                break;
                            }
                            if data[at] == b'/' {
                                let (name, end) = read_name(data, at + 1);
                                at = end;
                                match key.take() {
                                    Some(k) if (k == b"CS" || k == b"ColorSpace") && !device(&name) => {
                                        used.add(b"ColorSpace", name)
                                    }
                                    Some(_) => {}
                                    None => key = Some(name),
                                }
                                continue;
                            }
                            let start = at;
                            while at < data.len() && !is_space(data[at]) && !is_delimiter(data[at]) {
                                at += 1;
                            }
                            if at == start {
                                at += 1;
                            }
                            if &data[start..at] == b"ID" {
                                break;
                            }
                            key = None;
                        }
                        // The data: up to EI between whitespace.
                        at += 1;
                        while at + 2 <= data.len() {
                            if &data[at..at + 2] == b"EI"
                                && at > 0
                                && is_space(data[at - 1])
                                && data.get(at + 2).is_none_or(|c| is_space(*c))
                            {
                                at += 2;
                                break;
                            }
                            at += 1;
                        }
                    }
                    _ => {}
                }
                operands.clear();
            }
        }
    }
}

/* A stream's decoded content, bounded; None when it can't be decoded. */
fn decoded(stream: &Stream, left: usize) -> Option<Vec<u8>> {
    stream.get_plain_content_with_limit(left).ok()
}

/*
 * The page's own resources (or its tree's) cut down to what its drawing names: its content streams, the
 * forms they draw that have no resources of their own (theirs come with them whole), the glyphs of Type 3
 * fonts without their own, and tiling patterns without their own. A page that shares one /Resources with
 * pages left out so brings none of theirs (a split that shares one page never carries the others' scans).
 * A content stream that can't be decoded is damage: copying everything would carry pages the person left
 * out, so the safe answer is a refusal.
 */
fn pruned_resources(
    doc: &Document,
    resources: &Object,
    contents: Option<&Object>,
) -> Result<Object, PdfRefusal> {
    let Some(Object::Dictionary(resources)) = resolve(doc, resources) else { return Ok(resources.clone()) };
    let mut used = Used::default();
    let mut streams: Vec<ObjectId> = Vec::new();
    let mut direct: Vec<&Stream> = Vec::new();
    match contents.and_then(|value| match value {
        Object::Reference(id) => doc.objects.get(id).map(|object| (Some(*id), object)),
        other => Some((None, other)),
    }) {
        Some((Some(id), Object::Stream(_))) => streams.push(id),
        Some((_, Object::Array(items))) => {
            for item in items {
                match item {
                    Object::Reference(id) => streams.push(*id),
                    Object::Stream(stream) => direct.push(stream),
                    _ => {}
                }
            }
        }
        Some((_, Object::Stream(stream))) => direct.push(stream),
        _ => {}
    }
    let mut left = SCANNED_BYTES_MAX;
    let mut scanned = 0usize;
    let mut seen: HashSet<ObjectId> = HashSet::new();
    let scan = |stream: &Stream, used: &mut Used, left: &mut usize| -> Result<(), PdfRefusal> {
        let data = decoded(stream, *left).ok_or(PdfRefusal::Damaged)?;
        *left = left.saturating_sub(data.len());
        scan_content(&data, used);
        Ok(())
    };
    for stream in direct {
        scan(stream, &mut used, &mut left)?;
    }
    let dict_of = |category: &[u8]| match resources.get(category).ok().and_then(|value| resolve(doc, value)) {
        Some(Object::Dictionary(dict)) => Some(dict),
        _ => None,
    };
    // Streams drawn against these resources, a work list: the page's content, then what it reaches.
    loop {
        while let Some(id) = streams.pop() {
            if !seen.insert(id) {
                continue;
            }
            scanned += 1;
            if scanned > SCANNED_STREAMS_MAX {
                return Err(PdfRefusal::Damaged);
            }
            match doc.objects.get(&id) {
                Some(Object::Stream(stream)) => scan(stream, &mut used, &mut left)?,
                _ => return Err(PdfRefusal::Damaged),
            }
        }
        let mut more = Vec::new();
        let reach = |category: &[u8], name: &Vec<u8>, more: &mut Vec<ObjectId>| {
            let Some(dict) = dict_of(category) else { return };
            let Ok(Object::Reference(id)) = dict.get(name) else { return };
            match doc.objects.get(id) {
                // A form or a tiling pattern with no resources of its own draws with these.
                Some(Object::Stream(stream)) if !stream.dict.has(b"Resources") => more.push(*id),
                // A Type 3 font with no resources of its own: its glyphs draw with these.
                Some(Object::Dictionary(font))
                    if is_name(font.get(b"Subtype").ok(), b"Type3") && !font.has(b"Resources") =>
                {
                    if let Some(Object::Dictionary(procs)) =
                        font.get(b"CharProcs").ok().and_then(|value| resolve(doc, value))
                    {
                        more.extend(procs.iter().filter_map(|(_, glyph)| glyph.as_reference().ok()));
                    }
                }
                _ => {}
            }
        };
        for (category, names) in &used.names {
            if matches!(*category, b"XObject" | b"Pattern" | b"Font") {
                for name in names {
                    reach(category, name, &mut more);
                }
            }
        }
        more.retain(|id| !seen.contains(id));
        if more.is_empty() {
            break;
        }
        streams.extend(more);
    }
    let mut kept = Dictionary::new();
    for (key, value) in resources.iter() {
        let Some(category) = CATEGORIES.iter().find(|category| **category == key.as_slice()) else {
            kept.set(key.clone(), value.clone());
            continue;
        };
        let Some(Object::Dictionary(dict)) = resolve(doc, value) else { continue };
        let mut only = Dictionary::new();
        for (name, entry) in dict.iter() {
            if used.has(category, name) {
                only.set(name.clone(), entry.clone());
            }
        }
        if !only.is_empty() {
            kept.set(key.clone(), Object::Dictionary(only));
        }
    }
    Ok(Object::Dictionary(kept))
}

/* Copies objects of one source into the new document: each reference once, without recursing into references. */
struct Copier<'a> {
    source: &'a Source,
    /* Pages of this source in the output, by id: links to them land on their copies. */
    page_ids: HashMap<ObjectId, ObjectId>,
    copied: HashMap<ObjectId, ObjectId>,
    pending: Vec<(ObjectId, ObjectId)>,
}

impl Copier<'_> {
    fn value(&mut self, object: &Object, out: &mut Document, depth: usize) -> Result<Object, PdfRefusal> {
        if depth > NESTING_MAX_DEPTH {
            return Err(PdfRefusal::Damaged);
        }
        Ok(match object {
            Object::Reference(id) => self.reference(*id, out),
            Object::Dictionary(dict) => Object::Dictionary(self.dictionary(dict, out, depth)?),
            Object::Array(items) => Object::Array(
                items.iter().map(|item| self.value(item, out, depth + 1)).collect::<Result<_, _>>()?,
            ),
            Object::Stream(stream) => {
                let dict = self.dictionary(&stream.dict, out, depth)?;
                Object::Stream(Stream::new(dict, stream.content.clone()).with_compression(false))
            }
            other => other.clone(),
        })
    }

    fn dictionary(
        &mut self,
        dict: &Dictionary,
        out: &mut Document,
        depth: usize,
    ) -> Result<Dictionary, PdfRefusal> {
        let mut copy = Dictionary::new();
        for (key, value) in dict.iter() {
            copy.set(key.clone(), self.value(value, out, depth + 1)?);
        }
        Ok(copy)
    }

    fn reference(&mut self, id: ObjectId, out: &mut Document) -> Object {
        if let Some(page) = self.page_ids.get(&id) {
            return Object::Reference(*page);
        }
        // Another page, or a node of the source's page tree: never copied (it would bring the tree).
        if self.source.tree.contains(&id) || !self.source.doc.objects.contains_key(&id) {
            return Object::Null;
        }
        if let Some(known) = self.copied.get(&id) {
            return Object::Reference(*known);
        }
        let to = out.new_object_id();
        self.copied.insert(id, to);
        self.pending.push((id, to));
        Object::Reference(to)
    }

    /* Copies every object referenced so far, and what they reference in turn. */
    fn drain(&mut self, out: &mut Document, control: &RunControl) -> Result<(), PdfToolsError> {
        let mut since = 0;
        while let Some((from, to)) = self.pending.pop() {
            let object = match self.source.doc.objects.get(&from) {
                Some(object) => self.value(object, out, 0)?,
                None => Object::Null,
            };
            out.objects.insert(to, object);
            since += 1;
            if since % OBJECTS_PER_PROGRESS == 0 {
                control.progress()?;
            }
        }
        Ok(())
    }
}

fn build(
    sources: &[Source],
    planned: &[PdfPagePlan],
    max_output: u64,
    control: &RunControl,
    flatten: bool,
) -> Result<Vec<u8>, PdfToolsError> {
    if planned.is_empty() || planned.len() > PDF_TOOLS_MAX_PAGES as usize {
        return Err(PdfToolsError::Failed { reason: "A PDF needs between one and the most pages.".into() });
    }
    let mut out = Document::with_version("1.7");
    out.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
    let tree_id = out.new_object_id();
    let catalog_id = out.new_object_id();
    // Each output page's id, made first, so a link from one copied page to another lands.
    let targets: Vec<ObjectId> = planned.iter().map(|_| out.new_object_id()).collect();
    let mut copiers: Vec<Copier> = sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let page_ids = planned
                .iter()
                .zip(&targets)
                .filter(|(page, _)| page.source as usize == index)
                .filter_map(|(page, target)| source.pages.get(page.page as usize)?.id.map(|id| (id, *target)))
                .collect();
            Copier { source, page_ids, copied: HashMap::new(), pending: Vec::new() }
        })
        .collect();
    for (page, target) in planned.iter().zip(&targets) {
        control.progress()?;
        let copier = copiers
            .get_mut(page.source as usize)
            .ok_or_else(|| PdfToolsError::Failed { reason: "A page asked for isn't in its PDF.".into() })?;
        let node =
            copier.source.pages.get(page.page as usize).ok_or_else(|| PdfToolsError::Failed {
                reason: "A page asked for isn't in its PDF.".into(),
            })?;
        if ![0, 90, 180, 270].contains(&page.rotate) {
            return Err(PdfToolsError::Failed { reason: "A page's rotation is a quarter turn.".into() });
        }
        let mut leaf = Dictionary::new();
        for (key, value) in node.leaf.iter() {
            // The parent is the new tree; the resources are cut to what the page draws, below.
            if key.as_slice() == b"Parent" || key.as_slice() == b"Resources" {
                continue;
            }
            // A null inherited entry is absent: the tree's value, found by the walk, is copied below.
            if INHERITED.contains(&key.as_slice())
                && matches!(resolve(&copier.source.doc, value), None | Some(Object::Null))
            {
                continue;
            }
            leaf.set(key.clone(), copier.value(value, &mut out, 0)?);
        }
        for (key, value) in node.inherited.iter() {
            if *key != b"Resources" && !leaf.has(key) {
                leaf.set(key.to_vec(), copier.value(value, &mut out, 0)?);
            }
        }
        // Only the resources this page's drawing names: never a shared dictionary's whole contents.
        let resources = node
            .leaf
            .get(b"Resources")
            .ok()
            .filter(|value| !matches!(resolve(&copier.source.doc, value), None | Some(Object::Null)))
            .or_else(|| node.inherited.iter().find(|(key, _)| *key == b"Resources").map(|(_, value)| value));
        if let Some(resources) = resources {
            let pruned = pruned_resources(&copier.source.doc, resources, node.leaf.get(b"Contents").ok())?;
            leaf.set("Resources", copier.value(&pruned, &mut out, 0)?);
        }
        leaf.set("Type", Object::Name(b"Page".to_vec()));
        leaf.set("Rotate", Object::Integer(page.rotate as i64));
        leaf.set("Parent", Object::Reference(tree_id));
        copier.drain(&mut out, control)?;
        if flatten {
            // The source's layers that are off, as they are numbered in the output.
            let hidden: HashSet<ObjectId> = copier
                .source
                .layers
                .as_ref()
                .map(|layers| {
                    layers.off.iter().filter_map(|group| copier.copied.get(group).copied()).collect()
                })
                .unwrap_or_default();
            flatten_annotations(&mut out, &mut leaf, &hidden);
        }
        out.objects.insert(*target, Object::Dictionary(leaf));
    }
    let mut tree = Dictionary::new();
    tree.set("Type", Object::Name(b"Pages".to_vec()));
    tree.set("Kids", Object::Array(targets.iter().map(|id| Object::Reference(*id)).collect()));
    tree.set("Count", Object::Integer(targets.len() as i64));
    out.objects.insert(tree_id, Object::Dictionary(tree));
    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(tree_id));
    // Every layer of a source a page came from, those off still off: copied pages keep their groups,
    // and without this a hidden layer would show.
    let mut groups = Vec::new();
    let mut off = Vec::new();
    for (index, copier) in copiers.iter_mut().enumerate() {
        let Some(layers) = &copier.source.layers else { continue };
        if !planned.iter().any(|page| page.source as usize == index) {
            continue;
        }
        for group in &layers.groups {
            let Object::Reference(copied) = copier.reference(*group, &mut out) else { continue };
            groups.push(Object::Reference(copied));
            if layers.off.contains(group) {
                off.push(Object::Reference(copied));
            }
        }
        copier.drain(&mut out, control)?;
    }
    if !groups.is_empty() {
        let mut settings = Dictionary::new();
        settings.set("Order", Object::Array(groups.clone()));
        if !off.is_empty() {
            settings.set("OFF", Object::Array(off));
        }
        let mut properties = Dictionary::new();
        properties.set("OCGs", Object::Array(groups));
        properties.set("D", Object::Dictionary(settings));
        catalog.set("OCProperties", Object::Dictionary(properties));
    }
    out.objects.insert(catalog_id, Object::Dictionary(catalog));
    // The trailer names the catalog and nothing else: no Info, no ID from any source.
    out.trailer = Dictionary::new();
    out.trailer.set("Root", Object::Reference(catalog_id));
    control.progress()?;
    // Written into a sink that refuses past the limit as it grows: the output is never held whole past it.
    let mut sink = CappedSink { bytes: Vec::new(), max: max_output as usize, over: false };
    if let Err(error) = out.save_to(&mut sink) {
        if sink.over {
            return Err(PdfRefusal::TooLarge.into());
        }
        return Err(PdfToolsError::Failed { reason: error.to_string() });
    }
    drop(out);
    let bytes = std::mem::take(&mut sink.bytes);
    control.progress()?;
    Ok(bytes)
}

/*
 * Whether optional content shows by default: an /OCG unless it is off, an /OCMD by its /P over its /OCGs
 * (AnyOn by default). A visibility expression (/VE) isn't evaluated: what it hides is taken as hidden, so
 * a note on a layer that is off is never drawn into an image.
 */
fn layer_visible(out: &Document, condition: &Object, hidden: &HashSet<ObjectId>) -> bool {
    let Object::Reference(id) = condition else { return true };
    let Some(Object::Dictionary(dict)) = out.objects.get(id) else { return true };
    if is_name(dict.get(b"Type").ok(), b"OCG") {
        return !hidden.contains(id);
    }
    if !is_name(dict.get(b"Type").ok(), b"OCMD") {
        return true;
    }
    if dict.has(b"VE") {
        return false;
    }
    let groups: Vec<ObjectId> = match dict.get(b"OCGs") {
        Ok(Object::Reference(group)) => vec![*group],
        Ok(Object::Array(items)) => items.iter().filter_map(|item| item.as_reference().ok()).collect(),
        _ => Vec::new(),
    };
    if groups.is_empty() {
        return true;
    }
    let on = groups.iter().filter(|group| !hidden.contains(group)).count();
    match dict.get(b"P").ok() {
        Some(Object::Name(policy)) if policy == b"AllOn" => on == groups.len(),
        Some(Object::Name(policy)) if policy == b"AnyOff" => on < groups.len(),
        Some(Object::Name(policy)) if policy == b"AllOff" => on == 0,
        _ => on > 0,
    }
}

/* An annotation's flags that keep it off the screen: Hidden (2) and NoView (32). Invisible (1) is for unknown types. */
const ANNOTATION_UNSEEN: i64 = 2 | 32;

fn numbers(out: &Document, value: Option<&Object>, count: usize) -> Option<Vec<f64>> {
    let Some(Object::Array(items)) = value.and_then(|value| resolve(out, value)) else { return None };
    if items.len() != count {
        return None;
    }
    items.iter().map(|item| number(out, Some(item))).collect()
}

/*
 * Each shown annotation's normal appearance (/AP /N, or its /AS state) drawn into the page's content where
 * the annotation sits (PDF 32000, 12.5.5: the appearance's BBox, through its Matrix, fitted to the Rect),
 * after the page's own content, wrapped so that content's graphics state can't leak into it; then the
 * page's /Annots removed. Annotations without an appearance draw nothing, as most readers draw them.
 */
fn flatten_annotations(out: &mut Document, leaf: &mut Dictionary, hidden: &HashSet<ObjectId>) {
    let annots: Vec<Object> = match leaf.get(b"Annots").ok().and_then(|value| resolve(out, value)) {
        Some(Object::Array(items)) => items.clone(),
        _ => return,
    };
    let mut drawn = Vec::new();
    for annot in &annots {
        let Some(Object::Dictionary(annot)) = resolve(out, annot) else { continue };
        let flags = number(out, annot.get(b"F").ok()).unwrap_or(0.0) as i64;
        if flags & ANNOTATION_UNSEEN != 0 {
            continue;
        }
        // On a layer that is off by default (its /OC group, or a membership dictionary over groups): not drawn.
        if let Ok(condition) = annot.get(b"OC") {
            if !layer_visible(out, condition, hidden) {
                continue;
            }
        }
        let Some(Object::Dictionary(appearances)) =
            annot.get(b"AP").ok().and_then(|value| resolve(out, value))
        else {
            continue;
        };
        let normal = appearances.get(b"N").ok();
        // A stream, or a dictionary of streams by state, the one named by /AS.
        let stream_id = match normal {
            Some(Object::Reference(id)) if matches!(out.objects.get(id), Some(Object::Stream(_))) => {
                Some(*id)
            }
            Some(value) => match resolve(out, value) {
                Some(Object::Dictionary(states)) => {
                    match annot.get(b"AS").ok().and_then(|value| resolve(out, value)) {
                        Some(Object::Name(state)) => match states.get(state) {
                            Ok(Object::Reference(id))
                                if matches!(out.objects.get(id), Some(Object::Stream(_))) =>
                            {
                                Some(*id)
                            }
                            _ => None,
                        },
                        _ => None,
                    }
                }
                _ => None,
            },
            None => None,
        };
        let Some(stream_id) = stream_id else { continue };
        let Some(Object::Stream(form)) = out.objects.get(&stream_id) else { continue };
        let Some(bbox) = numbers(out, form.dict.get(b"BBox").ok(), 4) else { continue };
        let matrix = numbers(out, form.dict.get(b"Matrix").ok(), 6)
            .unwrap_or_else(|| vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let Some(rect) = numbers(out, annot.get(b"Rect").ok(), 4) else { continue };
        // The BBox's corners through the Matrix, and the box they span.
        let corners =
            [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])].map(|(x, y)| {
                (matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5])
            });
        let (x0, x1) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), (x, _)| (lo.min(*x), hi.max(*x)));
        let (y0, y1) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), (_, y)| (lo.min(*y), hi.max(*y)));
        let (rx0, rx1) = (rect[0].min(rect[2]), rect[0].max(rect[2]));
        let (ry0, ry1) = (rect[1].min(rect[3]), rect[1].max(rect[3]));
        if x1 - x0 <= 0.0 || y1 - y0 <= 0.0 || !(x0.is_finite() && y0.is_finite()) {
            continue;
        }
        let (sx, sy) = ((rx1 - rx0) / (x1 - x0), (ry1 - ry0) / (y1 - y0));
        drawn.push((stream_id, [sx, 0.0, 0.0, sy, rx0 - sx * x0, ry0 - sy * y0]));
    }
    leaf.remove(b"Annots");
    if drawn.is_empty() {
        return;
    }
    // Names of our own in the page's XObjects, which become the page's own (a shared dictionary isn't changed).
    let mut resources = match leaf.get(b"Resources").ok().and_then(|value| resolve(out, value)) {
        Some(Object::Dictionary(resources)) => resources.clone(),
        _ => Dictionary::new(),
    };
    let mut xobjects = match resources.get(b"XObject").ok().and_then(|value| resolve(out, value)) {
        Some(Object::Dictionary(xobjects)) => xobjects.clone(),
        _ => Dictionary::new(),
    };
    let mut drawing = String::from("Q\n");
    let mut next = 0usize;
    for (stream_id, cm) in &drawn {
        // A name the page doesn't already use: its own drawing must keep what it names.
        let name = loop {
            let candidate = format!("HushAnnot{next}");
            next += 1;
            if !xobjects.has(candidate.as_bytes()) {
                break candidate;
            }
        };
        xobjects.set(name.clone(), Object::Reference(*stream_id));
        let cm: Vec<String> = cm.iter().map(|value| format!("{value:.4}")).collect();
        drawing.push_str(&format!("q {} cm /{name} Do Q\n", cm.join(" ")));
    }
    resources.set("XObject", Object::Dictionary(xobjects));
    leaf.set("Resources", Object::Dictionary(resources));
    let before = out.add_object(Object::Stream(Stream::new(Dictionary::new(), b"q\n".to_vec())));
    let after = out.add_object(Object::Stream(Stream::new(Dictionary::new(), drawing.into_bytes())));
    let mut contents = vec![Object::Reference(before)];
    match leaf.get(b"Contents").ok().cloned() {
        Some(Object::Array(items)) => contents.extend(items),
        Some(Object::Reference(id)) => match out.objects.get(&id) {
            Some(Object::Array(items)) => contents.extend(items.clone()),
            _ => contents.push(Object::Reference(id)),
        },
        _ => {}
    }
    contents.push(Object::Reference(after));
    leaf.set("Contents", Object::Array(contents));
}

/* An output being written, refused the moment it would pass `max` bytes. */
struct CappedSink {
    bytes: Vec<u8>,
    max: usize,
    over: bool,
}

impl std::io::Write for CappedSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(data.len()) > self.max {
            self.over = true;
            self.bytes = Vec::new();
            return Err(std::io::Error::other("The PDF would pass its limit."));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Edit pages' writer: the PDFs are added in order, each read and checked as it comes (its
/// inspection returned), then each output is built from pages of them. Every call takes the run's
/// [`RunControl`]: progress for the watchdog, and it fails once the run has ended.
///
/// ```
/// let control = hushos_core::RunControl::new(30_000, None);
/// let pdf = b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF";
/// let writer = hushos_core::PdfPagesWriter::new();
/// let read = writer.add(pdf.to_vec(), control.clone()).unwrap();
/// assert_eq!(read.pages.len(), 1);
/// let page = hushos_core::PdfPagePlan { source: 0, page: 0, rotate: 90 };
/// let out = writer.build(vec![page], control).unwrap();
/// assert!(out.starts_with(b"%PDF-1.7"));
/// ```
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct PdfPagesWriter {
    state: Mutex<WriterState>,
}

struct WriterState {
    sources: Vec<Source>,
    max_output: u64,
    closed: bool,
}

fn lock(mutex: &Mutex<WriterState>) -> MutexGuard<'_, WriterState> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl PdfPagesWriter {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Arc<Self> {
        Arc::new(PdfPagesWriter {
            state: Mutex::new(WriterState {
                sources: Vec::new(),
                max_output: PDF_TOOLS_MAX_OUTPUT_BYTES,
                closed: false,
            }),
        })
    }

    /// Reads the next PDF and keeps it for [`build`](Self::build); its pages and warnings, or why it
    /// is refused. All of them together have at most [`PDF_TOOLS_MAX_PAGES`] pages.
    pub fn add(&self, bytes: Vec<u8>, control: Arc<RunControl>) -> Result<PdfInspection, PdfToolsError> {
        let bytes = Zeroizing::new(bytes);
        let (left, max_stream) = {
            let state = lock(&self.state);
            if state.closed {
                return Err(PdfToolsError::Failed { reason: "The writer is closed.".into() });
            }
            if state.sources.len() >= PDF_TOOLS_MAX_FILES as usize {
                return Err(PdfToolsError::Failed { reason: "Too many PDFs for one run.".into() });
            }
            let pages: usize = state.sources.iter().map(|source| source.pages.len()).sum();
            (PDF_TOOLS_MAX_PAGES as usize - pages, state.max_output)
        };
        let source = read(&bytes, left, max_stream, &control)?;
        drop(bytes);
        let read = inspection(&source);
        let mut state = lock(&self.state);
        if state.closed {
            return Err(PdfToolsError::Failed { reason: "The writer is closed.".into() });
        }
        state.sources.push(source);
        Ok(read)
    }

    /// A new PDF of `pages`, copied from the PDFs added, in that order.
    pub fn build(&self, pages: Vec<PdfPagePlan>, control: Arc<RunControl>) -> Result<Vec<u8>, PdfToolsError> {
        let state = lock(&self.state);
        if state.closed {
            return Err(PdfToolsError::Failed { reason: "The writer is closed.".into() });
        }
        build(&state.sources, &pages, state.max_output, &control, false)
    }

    /// One page as a PDF to draw, not to keep: turned to its rotation, its annotations' appearances
    /// drawn into its content (as a reader shows them) and the annotations themselves left out, so a
    /// renderer that draws only page content (PDFKit into a bitmap, for one) shows what a viewer shows.
    /// Save as images draws from it on the phones.
    pub fn drawable(&self, page: PdfPagePlan, control: Arc<RunControl>) -> Result<Vec<u8>, PdfToolsError> {
        let state = lock(&self.state);
        if state.closed {
            return Err(PdfToolsError::Failed { reason: "The writer is closed.".into() });
        }
        build(&state.sources, &[page], state.max_output, &control, true)
    }

    /// Lowers the most an output may be (never raises it past 256 MiB): a phone whose app heap can't
    /// take one that large sets what it can, and an output past it is refused as `too-large`.
    pub fn limit_output(&self, bytes: u64) {
        let mut state = lock(&self.state);
        state.max_output = state.max_output.min(bytes);
    }

    /// Lets go of every PDF read; the writer refuses everything after. (Not `close`: Kotlin's
    /// AutoCloseable has one, which frees the writer itself.)
    pub fn clear(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        state.sources.clear();
    }
}

#[cfg(test)]
mod tests;
