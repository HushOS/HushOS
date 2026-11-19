//! Images to PDF in the phone apps (docs/file-tools-design.md, feature (b)): the JPEG segment
//! cutter, the page geometry, and a small PDF writer, so both phones embed a JPEG byte for byte
//! the same way (Android's `PdfDocument` would re-encode every image).
//!
//! - **The cutter** keeps what a picture needs and nothing that says where or with what it was
//!   taken. It walks every segment of the file, between scans too, and keeps the frame header,
//!   tables, restart interval and scans, plus three application segments: APP0 `JFIF`, APP2
//!   `ICC_PROFILE` (the colour profile) and APP14 `Adobe` (how CMYK is stored). Every other
//!   application segment (EXIF, XMP, IPTC, MPF, makers' own) and every comment is cut, and so is
//!   anything after the end of the image (a second picture, as MPF files carry). The scans are
//!   copied unchanged, so the picture is the same to the bit. Its twin is
//!   `apps/web/src/lib/images-pdf/jpeg.ts`; both are held to `e2e/fixtures/images/expected.json`.
//! - **The orientation** a JPEG's EXIF names is read before the EXIF is cut, and applied by the
//!   page's drawing matrix (rotating or flipping on the page), never by re-encoding.
//! - **The writer** is a writer only, no parser: each image goes in as a DCTDecode stream (a cut
//!   JPEG, as it is) or as FlateDecode RGB with a soft mask when it has transparency (pixels the
//!   app decoded with the platform's decoder). One page per image, no document information
//!   dictionary, nothing else. Each image is written as it comes, so only the PDF so far and
//!   the current image are in memory.

use std::fmt::Write as _;
use std::io::Write as _;
use std::sync::{Arc, Mutex, MutexGuard};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use zeroize::Zeroizing;

use crate::{CoreError, RunControl};

const MIB: u64 = 1024 * 1024;

/// Past this much of images in one run, the dialog asks first (the large-file card).
pub const IMAGES_PDF_CARD_BYTES: u64 = 64 * MIB;
/// The most images, by their files' bytes, one PDF is made from.
pub const IMAGES_PDF_MAX_INPUT_BYTES: u64 = 256 * MIB;
/// The most images in one PDF.
pub const IMAGES_PDF_MAX_IMAGES: u32 = 500;
/// The largest PDF made: what can be held as one in-memory upload.
pub const IMAGES_PDF_MAX_OUTPUT_BYTES: u64 = 256 * MIB;
/// The most pixels of an image decoded to put in a PDF (a JPEG is never decoded).
pub const IMAGES_PDF_MAX_PIXELS: u64 = 100_000_000;

/// Points in a millimetre; margins are 12 mm.
const PT_PER_MM: f64 = 72.0 / 25.4;
const MARGIN_MM: f64 = 12.0;
/// The largest page side most readers accept (Acrobat's limit), in points.
const FIT_MAX: f64 = 14_400.0;

/// What a refused image or PDF is, as a code each app puts into words (the web uses the same).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageRefusal {
    /// Not a JPEG at all, or one whose structure is broken.
    Damaged,
    /// A real JPEG of a kind few readers show: arithmetic coding, lossless, hierarchical, 12-bit,
    /// a height given only after the scan.
    Unsupported,
    /// More decoded pixels than [`IMAGES_PDF_MAX_PIXELS`].
    TooManyPixels,
    /// The PDF would pass [`IMAGES_PDF_MAX_OUTPUT_BYTES`].
    TooLarge,
}

impl ImageRefusal {
    pub fn code(self) -> &'static str {
        match self {
            ImageRefusal::Damaged => "damaged",
            ImageRefusal::Unsupported => "unsupported",
            ImageRefusal::TooManyPixels => "too-many-pixels",
            ImageRefusal::TooLarge => "too-large",
        }
    }
}

/// Why an image did not go into the PDF: a refusal with its code, or the run ending underneath
/// it (a cancel, the watchdog), in the person's words.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum ImagesPdfError {
    #[error("{code}")]
    Refused { code: String },
    /* Not `message`, which Kotlin's Throwable already has. */
    #[error("{reason}")]
    Failed { reason: String },
}

impl From<ImageRefusal> for ImagesPdfError {
    fn from(refusal: ImageRefusal) -> Self {
        ImagesPdfError::Refused { code: refusal.code().into() }
    }
}

impl From<CoreError> for ImagesPdfError {
    fn from(error: CoreError) -> Self {
        ImagesPdfError::Failed { reason: error.to_string() }
    }
}

/// The limits above, for the apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ImagesPdfLimits {
    pub card_bytes: u64,
    pub max_input_bytes: u64,
    pub max_images: u32,
    pub max_output_bytes: u64,
    pub max_pixels: u64,
}

/// ```
/// let limits = hushos_core::images_pdf_limits();
/// assert_eq!(limits.max_images, 500);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn images_pdf_limits() -> ImagesPdfLimits {
    ImagesPdfLimits {
        card_bytes: IMAGES_PDF_CARD_BYTES,
        max_input_bytes: IMAGES_PDF_MAX_INPUT_BYTES,
        max_images: IMAGES_PDF_MAX_IMAGES,
        max_output_bytes: IMAGES_PDF_MAX_OUTPUT_BYTES,
        max_pixels: IMAGES_PDF_MAX_PIXELS,
    }
}

/// The most pixels a phone decodes for one image, from the device's memory: a decoded image takes
/// four bytes a pixel, held beside the PDF so far, so a sixty-fourth of the memory, between 16 and
/// 100 megapixels (docs/file-tools-design.md, section 6: phone limits follow the device's memory).
/// A JPEG is never decoded, so this never refuses one.
///
/// ```
/// assert_eq!(hushos_core::images_pdf_max_pixels(8 << 30), 100_000_000);
/// assert_eq!(hushos_core::images_pdf_max_pixels(4 << 30), 67_108_864);
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn images_pdf_max_pixels(device_memory_bytes: u64) -> u64 {
    (device_memory_bytes / 64).clamp(16_000_000, IMAGES_PDF_MAX_PIXELS)
}

// ---------------------------------------------------------------------------
// The cutter
// ---------------------------------------------------------------------------

/// A JPEG with its metadata cut, and what the PDF needs to know of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CutJpeg {
    pub bytes: Vec<u8>,
    /// As stored, before the orientation.
    pub width: u32,
    pub height: u32,
    /// 1 (grey), 3 (colour) or 4 (CMYK).
    pub components: u8,
    /// The EXIF orientation, 1 to 8; 1 when there is none or it can't be read.
    pub orientation: u8,
    /// An APP14 Adobe segment was kept.
    pub adobe: bool,
}

fn u16_be(bytes: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([bytes[at], bytes[at + 1]])
}

/// What the cutter keeps of an application segment or comment, by marker and identifier.
fn keeps(marker: u8, payload: &[u8]) -> bool {
    match marker {
        0xE0 => payload.starts_with(b"JFIF\0"),
        0xE2 => payload.starts_with(b"ICC_PROFILE\0"),
        0xEE => payload.starts_with(b"Adobe"),
        _ => false,
    }
}

/// The orientation an EXIF block's first image directory gives, if it gives one that makes sense.
fn exif_orientation(tiff: &[u8]) -> Option<u8> {
    if tiff.len() < 8 {
        return None;
    }
    let little = match &tiff[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let bytes: [u8; 2] = tiff.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if little { u16::from_le_bytes(bytes) } else { u16::from_be_bytes(bytes) })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let bytes: [u8; 4] = tiff.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if little { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let directory = u32_at(4)? as usize;
    let entries = u16_at(directory)? as usize;
    for index in 0..entries {
        let entry = directory.checked_add(2 + index * 12)?;
        if u16_at(entry)? != 0x0112 {
            continue;
        }
        // SHORT, one value, held in the entry itself.
        if u16_at(entry + 2)? != 3 || u32_at(entry + 4)? != 1 {
            return None;
        }
        let value = u16_at(entry + 8)?;
        return (1..=8).contains(&value).then_some(value as u8);
    }
    None
}

/// A cut JPEG, ended with its end-of-image marker (one the file stopped short of is added).
fn ended(
    mut out: Vec<u8>,
    frame: Option<(u32, u32, u8)>,
    orientation: Option<Option<u8>>,
    adobe: bool,
) -> Result<CutJpeg, ImageRefusal> {
    out.extend_from_slice(&[0xFF, 0xD9]);
    let (width, height, components) = frame.ok_or(ImageRefusal::Damaged)?;
    Ok(CutJpeg {
        bytes: out,
        width,
        height,
        components,
        orientation: orientation.flatten().unwrap_or(1),
        adobe,
    })
}

/// Cuts a JPEG's metadata (see the module's header) without touching its picture.
///
/// ```
/// use hushos_core::{cut_jpeg, ImageRefusal};
/// assert_eq!(cut_jpeg(b"not a jpeg"), Err(ImageRefusal::Damaged));
/// ```
pub fn cut_jpeg(input: &[u8]) -> Result<CutJpeg, ImageRefusal> {
    use ImageRefusal::{Damaged, Unsupported};
    if input.len() < 4 || input[0] != 0xFF || input[1] != 0xD8 {
        return Err(Damaged);
    }
    let mut out = Vec::with_capacity(input.len());
    out.extend_from_slice(&[0xFF, 0xD8]);
    let mut pos = 2;
    let mut frame: Option<(u32, u32, u8)> = None;
    let mut orientation: Option<Option<u8>> = None;
    let mut adobe = false;
    let mut scanned = false;
    loop {
        // Between segments: a marker, after any number of fill bytes.
        if pos >= input.len() {
            // The file stops between segments, after a scan: what is there is kept, ended.
            return if scanned { ended(out, frame, orientation, adobe) } else { Err(Damaged) };
        }
        if input[pos] != 0xFF {
            return Err(Damaged);
        }
        while pos < input.len() && input[pos] == 0xFF {
            pos += 1;
        }
        if pos >= input.len() {
            return if scanned { ended(out, frame, orientation, adobe) } else { Err(Damaged) };
        }
        let marker = input[pos];
        pos += 1;
        match marker {
            0xD9 => {
                // The end of the image; anything after it (a second picture) is cut.
                return if scanned { ended(out, frame, orientation, adobe) } else { Err(Damaged) };
            }
            0x00 | 0x01 | 0xD0..=0xD8 => return Err(Damaged),
            _ => {}
        }
        if pos + 2 > input.len() {
            return Err(Damaged);
        }
        let length = u16_be(input, pos) as usize;
        if length < 2 || pos + length > input.len() {
            return Err(Damaged);
        }
        let payload = &input[pos + 2..pos + length];
        let segment_end = pos + length;
        let keep = match marker {
            0xC0..=0xC2 => {
                if frame.is_some() || payload.len() < 6 {
                    return Err(Damaged);
                }
                let precision = payload[0];
                let height = u16_be(payload, 1) as u32;
                let width = u16_be(payload, 3) as u32;
                let components = payload[5];
                if payload.len() < 6 + 3 * components as usize {
                    return Err(Damaged);
                }
                if precision != 8 || !matches!(components, 1 | 3 | 4) || height == 0 {
                    return Err(Unsupported);
                }
                if width == 0 {
                    return Err(Damaged);
                }
                frame = Some((width, height, components));
                true
            }
            // Lossless, hierarchical, arithmetic coding and their tables, and markers set apart
            // for extensions: real JPEGs, but not ones a PDF reader can be counted on to show.
            0xC3 | 0xC5..=0xCF | 0xDC | 0xDE | 0xDF | 0xF0..=0xFD => return Err(Unsupported),
            0xC4 | 0xDB | 0xDD => true,
            0xDA => {
                if frame.is_none() {
                    return Err(Damaged);
                }
                true
            }
            0xE0..=0xEF | 0xFE => {
                if marker == 0xE1 && orientation.is_none() && payload.starts_with(b"Exif\0\0") {
                    // The first EXIF block decides, as browsers decide; a broken one says upright.
                    orientation = Some(exif_orientation(&payload[6..]));
                }
                let keep = keeps(marker, payload);
                if keep && marker == 0xEE {
                    adobe = true;
                }
                keep
            }
            _ => return Err(Damaged),
        };
        if keep {
            out.extend_from_slice(&[0xFF, marker]);
            out.extend_from_slice(&input[pos..segment_end]);
        }
        pos = segment_end;
        if marker != 0xDA {
            continue;
        }
        // The scan's data, copied as it is up to the next marker: stuffed zeros and restart
        // markers are part of it; a fill byte before a marker is not.
        scanned = true;
        loop {
            let Some(found) = input[pos..].iter().position(|&byte| byte == 0xFF) else {
                out.extend_from_slice(&input[pos..]);
                return ended(out, frame, orientation, adobe);
            };
            out.extend_from_slice(&input[pos..pos + found]);
            pos += found;
            match input.get(pos + 1) {
                None => return ended(out, frame, orientation, adobe),
                Some(0x00) | Some(0xD0..=0xD7) => {
                    out.extend_from_slice(&input[pos..pos + 2]);
                    pos += 2;
                }
                Some(0xFF) => pos += 1,
                Some(_) => break,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// The page every image gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PageSize {
    /// The image's own size, a pixel to a point (scaled down past 200 inches).
    Fit,
    A4,
    Letter,
}

/// Where an image goes on its page: the page's size in points, and the matrix that draws the
/// image (as stored) upright inside it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageLayout {
    pub width: f64,
    pub height: f64,
    pub matrix: [f64; 6],
}

/// For each orientation, where a stored point (s, t) of the unit square shows, y up:
/// (dX/ds, dX/dt, X at 0, dY/ds, dY/dt, Y at 0). EXIF's 2 to 8 are mirror, 180, flip, transpose,
/// 90 clockwise, transverse and 90 anticlockwise.
const AXES: [[f64; 6]; 8] = [
    [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    [-1.0, 0.0, 1.0, 0.0, 1.0, 0.0],
    [-1.0, 0.0, 1.0, 0.0, -1.0, 1.0],
    [1.0, 0.0, 0.0, 0.0, -1.0, 1.0],
    [0.0, -1.0, 1.0, -1.0, 0.0, 1.0],
    [0.0, 1.0, 0.0, -1.0, 0.0, 1.0],
    [0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
    [0.0, -1.0, 1.0, 1.0, 0.0, 0.0],
];

/// A4 and US Letter turn to match a wider-than-tall image; Fit takes the image's size. The image
/// fits the page inside the margins (12 mm when asked), centred, larger or smaller as needed.
///
/// ```
/// use hushos_core::{page_layout, PageSize};
/// let layout = page_layout(400, 300, 6, PageSize::Fit, false);
/// assert_eq!((layout.width, layout.height), (300.0, 400.0));
/// ```
pub fn page_layout(width: u32, height: u32, orientation: u8, size: PageSize, margin: bool) -> PageLayout {
    let margin = if margin { MARGIN_MM * PT_PER_MM } else { 0.0 };
    let orientation = if (1..=8).contains(&orientation) { orientation } else { 1 };
    let (shown_w, shown_h) =
        if orientation >= 5 { (height as f64, width as f64) } else { (width as f64, height as f64) };
    let (page_w, page_h, box_w, box_h, x, y);
    match size {
        PageSize::Fit => {
            let longest = shown_w.max(shown_h);
            let scale =
                if longest + 2.0 * margin > FIT_MAX { (FIT_MAX - 2.0 * margin) / longest } else { 1.0 };
            box_w = shown_w * scale;
            box_h = shown_h * scale;
            page_w = box_w + 2.0 * margin;
            page_h = box_h + 2.0 * margin;
            x = margin;
            y = margin;
        }
        PageSize::A4 | PageSize::Letter => {
            let (mut w, mut h) =
                if size == PageSize::A4 { (210.0 * PT_PER_MM, 297.0 * PT_PER_MM) } else { (612.0, 792.0) };
            if shown_w > shown_h {
                std::mem::swap(&mut w, &mut h);
            }
            let scale = ((w - 2.0 * margin) / shown_w).min((h - 2.0 * margin) / shown_h);
            box_w = shown_w * scale;
            box_h = shown_h * scale;
            page_w = w;
            page_h = h;
            x = (w - box_w) / 2.0;
            y = (h - box_h) / 2.0;
        }
    }
    let [xs, xt, x0, ys, yt, y0] = AXES[orientation as usize - 1];
    PageLayout {
        width: page_w,
        height: page_h,
        matrix: [box_w * xs, box_h * ys, box_w * xt, box_h * yt, x + box_w * x0, y + box_h * y0],
    }
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/// A number as a content stream or dictionary holds it: at most four decimals, no trailing zeros.
fn number(value: f64) -> String {
    let mut text = format!("{value:.4}");
    if text.contains('.') {
        text = text.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if text == "-0" {
        text = "0".into();
    }
    text
}

/* Object 1 is the catalogue and 2 the page tree, both written last; images and pages come between. */
const CATALOG: usize = 1;
const PAGE_TREE: usize = 2;

struct WriterState {
    out: Zeroizing<Vec<u8>>,
    /* The byte offset of each object, by number less one (0 until it is written). */
    offsets: Vec<usize>,
    pages: Vec<usize>,
    size: PageSize,
    margin: bool,
    finished: bool,
    /* IMAGES_PDF_MAX_OUTPUT_BYTES, less in tests. */
    max_output: u64,
}

impl WriterState {
    fn reserve(&mut self) -> usize {
        self.offsets.push(0);
        self.offsets.len()
    }

    fn begin(&mut self, object: usize) {
        self.offsets[object - 1] = self.out.len();
        self.out.extend_from_slice(format!("{object} 0 obj\n").as_bytes());
    }

    fn stream(&mut self, object: usize, dictionary: &str, data: &[u8]) {
        self.begin(object);
        self.out.extend_from_slice(format!("<< {dictionary} /Length {} >>\nstream\n", data.len()).as_bytes());
        self.out.extend_from_slice(data);
        self.out.extend_from_slice(b"\nendstream\nendobj\n");
    }

    fn object(&mut self, object: usize, body: &str) {
        self.begin(object);
        self.out.extend_from_slice(body.as_bytes());
        self.out.extend_from_slice(b"\nendobj\n");
    }

    /// The image's page: its drawing, then the page itself.
    fn page(&mut self, image: usize, layout: PageLayout) {
        let [a, b, c, d, e, f] = layout.matrix;
        let drawing = format!(
            "q {} {} {} {} {} {} cm /Im0 Do Q",
            number(a),
            number(b),
            number(c),
            number(d),
            number(e),
            number(f)
        );
        let contents = self.reserve();
        self.stream(contents, "", drawing.as_bytes());
        let page = self.reserve();
        self.object(
            page,
            &format!(
                "<< /Type /Page /Parent {PAGE_TREE} 0 R /MediaBox [0 0 {} {}] /Resources << /XObject << /Im0 {image} 0 R >> >> /Contents {contents} 0 R >>",
                number(layout.width),
                number(layout.height)
            ),
        );
        self.pages.push(page);
    }

    fn check_size(&self) -> Result<(), ImageRefusal> {
        if self.out.len() as u64 > self.max_output {
            return Err(ImageRefusal::TooLarge);
        }
        Ok(())
    }
}

/// Makes one PDF, an image a page, in the order the images are added. Each `add` call is
/// progress for the run's watchdog and fails once the run has ended (cancelled or timed out).
///
/// ```
/// use hushos_core::{ImagesPdfWriter, PageSize, RunControl};
/// let control = RunControl::new(30_000, None);
/// let writer = ImagesPdfWriter::new(PageSize::A4, true);
/// writer.add_pixels(vec![255, 0, 0, 255], 1, 1, false, control.clone()).unwrap();
/// let pdf = writer.finish().unwrap();
/// assert!(pdf.starts_with(b"%PDF-1.7"));
/// ```
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct ImagesPdfWriter {
    state: Mutex<WriterState>,
}

fn lock(mutex: &Mutex<WriterState>) -> MutexGuard<'_, WriterState> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Rows handed to the compressor between two progress calls.
const ROWS_PER_PROGRESS: u32 = 256;

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl ImagesPdfWriter {
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(size: PageSize, margin: bool) -> Arc<Self> {
        let mut out = Zeroizing::new(Vec::new());
        out.extend_from_slice(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
        Arc::new(ImagesPdfWriter {
            state: Mutex::new(WriterState {
                out,
                offsets: vec![0, 0],
                pages: Vec::new(),
                size,
                margin,
                finished: false,
                max_output: IMAGES_PDF_MAX_OUTPUT_BYTES,
            }),
        })
    }

    /// A JPEG, its metadata cut ([`cut_jpeg`]) and its orientation applied on the page.
    pub fn add_jpeg(&self, bytes: Vec<u8>, control: Arc<RunControl>) -> Result<(), ImagesPdfError> {
        control.progress()?;
        let bytes = Zeroizing::new(bytes);
        let cut = cut_jpeg(&bytes)?;
        drop(bytes);
        let cut_bytes = Zeroizing::new(cut.bytes);
        let mut state = lock(&self.state);
        if state.finished {
            return Err(ImagesPdfError::Failed { reason: "The PDF is already made.".into() });
        }
        let colour = match cut.components {
            1 => "/DeviceGray",
            4 => "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]",
            _ => "/DeviceRGB",
        };
        let image = state.reserve();
        state.stream(
            image,
            &format!(
                "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {colour} /BitsPerComponent 8 /Filter /DCTDecode",
                cut.width, cut.height
            ),
            &cut_bytes,
        );
        let layout = page_layout(cut.width, cut.height, cut.orientation, state.size, state.margin);
        state.page(image, layout);
        state.check_size()?;
        control.progress()?;
        Ok(())
    }

    /// Decoded pixels, upright already (the platform's decoder applied any orientation): RGBA,
    /// four bytes a pixel, row by row; `premultiplied` when the colour is multiplied by alpha
    /// (iOS's bitmap contexts). Fully opaque pixels go in as RGB alone; any transparency adds a
    /// soft mask.
    pub fn add_pixels(
        &self,
        rgba: Vec<u8>,
        width: u32,
        height: u32,
        premultiplied: bool,
        control: Arc<RunControl>,
    ) -> Result<(), ImagesPdfError> {
        control.progress()?;
        let rgba = Zeroizing::new(rgba);
        if width == 0 || height == 0 {
            return Err(ImageRefusal::Damaged.into());
        }
        if width as u64 * height as u64 > IMAGES_PDF_MAX_PIXELS {
            return Err(ImageRefusal::TooManyPixels.into());
        }
        if rgba.len() as u64 != width as u64 * height as u64 * 4 {
            return Err(ImageRefusal::Damaged.into());
        }
        let row = width as usize * 4;
        let opaque = rgba.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 255);
        let mut colour = ZlibEncoder::new(Vec::new(), Compression::default());
        let mut line = Zeroizing::new(vec![0u8; width as usize * 3]);
        for (index, source) in rgba.chunks_exact(row).enumerate() {
            for (pixel, rgb) in source.as_chunks::<4>().0.iter().zip(line.as_chunks_mut::<3>().0.iter_mut()) {
                let alpha = pixel[3] as u32;
                for (out, &value) in rgb.iter_mut().zip(&pixel[..3]) {
                    let value = value as u32;
                    *out = if premultiplied && alpha < 255 {
                        // Fully transparent colour is lost to premultiplying: black, under a mask of 0.
                        ((value * 255 + alpha / 2).checked_div(alpha).unwrap_or(0)).min(255) as u8
                    } else {
                        value as u8
                    };
                }
            }
            colour.write_all(&line).map_err(|_| ImageRefusal::Damaged)?;
            if (index as u32 + 1).is_multiple_of(ROWS_PER_PROGRESS) {
                control.progress()?;
            }
        }
        let colour = Zeroizing::new(colour.finish().map_err(|_| ImageRefusal::Damaged)?);
        let mask = if opaque {
            None
        } else {
            let mut mask = ZlibEncoder::new(Vec::new(), Compression::default());
            for (index, source) in rgba.chunks_exact(row).enumerate() {
                let alphas: Vec<u8> = source.as_chunks::<4>().0.iter().map(|pixel| pixel[3]).collect();
                mask.write_all(&alphas).map_err(|_| ImageRefusal::Damaged)?;
                if (index as u32 + 1).is_multiple_of(ROWS_PER_PROGRESS) {
                    control.progress()?;
                }
            }
            Some(Zeroizing::new(mask.finish().map_err(|_| ImageRefusal::Damaged)?))
        };
        drop(rgba);
        let mut state = lock(&self.state);
        if state.finished {
            return Err(ImagesPdfError::Failed { reason: "The PDF is already made.".into() });
        }
        let soft_mask = match mask {
            Some(mask) => {
                let object = state.reserve();
                state.stream(
                    object,
                    &format!(
                        "/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"
                    ),
                    &mask,
                );
                format!(" /SMask {object} 0 R")
            }
            None => String::new(),
        };
        let image = state.reserve();
        state.stream(
            image,
            &format!(
                "/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode{soft_mask}"
            ),
            &colour,
        );
        let layout = page_layout(width, height, 1, state.size, state.margin);
        state.page(image, layout);
        state.check_size()?;
        control.progress()?;
        Ok(())
    }

    /// Pages so far.
    pub fn pages(&self) -> u32 {
        lock(&self.state).pages.len() as u32
    }

    /// The PDF: the page tree, the catalogue, the cross-reference table. Once only; the writer
    /// keeps nothing after.
    pub fn finish(&self) -> Result<Vec<u8>, ImagesPdfError> {
        let mut state = lock(&self.state);
        if state.finished {
            return Err(ImagesPdfError::Failed { reason: "The PDF is already made.".into() });
        }
        if state.pages.is_empty() {
            return Err(ImageRefusal::Damaged.into());
        }
        state.finished = true;
        let kids = state.pages.iter().map(|page| format!("{page} 0 R")).collect::<Vec<_>>().join(" ");
        let count = state.pages.len();
        state.object(PAGE_TREE, &format!("<< /Type /Pages /Kids [{kids}] /Count {count} >>"));
        state.object(CATALOG, &format!("<< /Type /Catalog /Pages {PAGE_TREE} 0 R >>"));
        let xref = state.out.len();
        let objects = state.offsets.len();
        let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", objects + 1);
        for offset in &state.offsets {
            let _ = writeln!(table, "{offset:010} 00000 n ");
        }
        let _ = writeln!(
            table,
            "trailer\n<< /Size {} /Root {CATALOG} 0 R >>\nstartxref\n{xref}\n%%EOF",
            objects + 1
        );
        state.out.extend_from_slice(table.as_bytes());
        state.check_size()?;
        let out = std::mem::take(&mut *state.out);
        state.pages.clear();
        state.offsets.clear();
        Ok(out)
    }
}

#[cfg(test)]
impl ImagesPdfWriter {
    fn with_limit(size: PageSize, margin: bool, max_output: u64) -> Arc<Self> {
        let writer = Self::new(size, margin);
        lock(&writer.state).max_output = max_output;
        writer
    }
}

#[cfg(test)]
mod tests;
