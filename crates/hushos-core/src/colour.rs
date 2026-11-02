//! A folder's colour, as the phones draw it: the twin of
//! `packages/drive/src/colour.ts` (which says what the colour is and where it lives)
//! and of the folder steps in `apps/web/src/styles.css` (the lightness and vividness
//! it is drawn at in each scheme). The colour is the folder's `colour` attribute,
//! a lowercase `#rrggbb`; a folder without one, or with one this client cannot
//! read, is drawn in the plain folder colour (the Alpine folder tokens).

use std::collections::HashMap;

use crate::error::{CoreError, CoreResult};

const COLOUR_ATTRIBUTE: &str = "colour";

/// The swatches offered for a folder beside the plain folder colour, in the web's order.
pub const FOLDER_COLOURS: [&str; 8] =
    ["#70adfb", "#53c48e", "#f28881", "#aa9cf7", "#00c3cb", "#e488be", "#8fbb5f", "#e99355"];

/// The swatches' names, in `FOLDER_COLOURS`' order, as the web's colour dialog says them.
const SWATCH_NAMES: [&str; 8] = ["Blue", "Mint", "Coral", "Violet", "Teal", "Pink", "Lime", "Orange"];

/// A swatch a person can pick for a folder: its stored colour and the name it is offered under.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct FolderSwatch {
    pub colour: String,
    pub name: String,
}

/// One scheme's folder steps: front and back lightness and vividness in OKLCH.
struct Steps {
    front_l: f64,
    front_c: f64,
    back_l: f64,
    back_c: f64,
}

const LIGHT: Steps = Steps { front_l: 0.8, front_c: 0.11, back_l: 0.66, back_c: 0.132 };
const DARK: Steps = Steps { front_l: 0.68, front_c: 0.121, back_l: 0.54, back_c: 0.121 };
const LIGHT_HIGH: Steps = Steps { front_l: 0.58, front_c: 0.15, back_l: 0.46, back_c: 0.15 };
const DARK_HIGH: Steps = Steps { front_l: 0.82, front_c: 0.1, back_l: 0.7, back_c: 0.11 };

/// A folder's two sheets in each of the four schemes, as ARGB (`0xFFrrggbb`), the
/// form the generated Alpine colours take on both phones.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct FolderShades {
    pub light_front: u32,
    pub light_back: u32,
    pub dark_front: u32,
    pub dark_back: u32,
    pub light_high_front: u32,
    pub light_high_back: u32,
    pub dark_high_front: u32,
    pub dark_high_back: u32,
}

fn is_colour(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A folder's own colour, or `None` when it is drawn in the plain folder colour.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn folder_colour(attributes: HashMap<String, String>) -> Option<String> {
    attributes.get(COLOUR_ATTRIBUTE).filter(|own| is_colour(own)).cloned()
}

/// A folder's sheets in every scheme from its attributes, or `None` for the plain folder colour.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn folder_shades(attributes: HashMap<String, String>) -> Option<FolderShades> {
    let (hue, strength) = hue_of(&folder_colour(attributes)?);
    let draw = |l: f64, c: f64| argb(l, c * strength, hue);
    Some(FolderShades {
        light_front: draw(LIGHT.front_l, LIGHT.front_c),
        light_back: draw(LIGHT.back_l, LIGHT.back_c),
        dark_front: draw(DARK.front_l, DARK.front_c),
        dark_back: draw(DARK.back_l, DARK.back_c),
        light_high_front: draw(LIGHT_HIGH.front_l, LIGHT_HIGH.front_c),
        light_high_back: draw(LIGHT_HIGH.back_l, LIGHT_HIGH.back_c),
        dark_high_front: draw(DARK_HIGH.front_l, DARK_HIGH.front_c),
        dark_high_back: draw(DARK_HIGH.back_l, DARK_HIGH.back_c),
    })
}

/// The swatches offered for a folder, in the web's order, beside the plain folder colour.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn folder_swatches() -> Vec<FolderSwatch> {
    FOLDER_COLOURS
        .iter()
        .zip(SWATCH_NAMES)
        .map(|(colour, name)| FolderSwatch { colour: (*colour).to_owned(), name: name.to_owned() })
        .collect()
}

/// A colour a person typed or picked, as it is stored (trimmed, lower case), or `None` when it is not one.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn to_colour(value: String) -> Option<String> {
    let lower = value.trim().to_ascii_lowercase();
    is_colour(&lower).then_some(lower)
}

/// A folder's attributes with its colour set, or with `None` taken back to the plain folder
/// colour; every other attribute is kept as it was. A colour that is not one is refused.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn with_folder_colour(
    attributes: HashMap<String, String>,
    colour: Option<String>,
) -> CoreResult<HashMap<String, String>> {
    let mut next = attributes;
    match colour {
        None => {
            next.remove(COLOUR_ATTRIBUTE);
        }
        Some(colour) => {
            let clean = to_colour(colour).ok_or_else(|| CoreError::Input("Choose a colour.".into()))?;
            next.insert(COLOUR_ATTRIBUTE.to_owned(), clean);
        }
    }
    Ok(next)
}

/// A colour as a picker draws its swatch, as ARGB: the web's `swatchColour`, at a folder
/// front's weight and the same in every scheme. A value that is not a colour draws grey.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn swatch_argb(colour: String) -> u32 {
    let (hue, strength) = to_colour(colour).map_or((0.0, 0.0), |clean| hue_of(&clean));
    argb(0.74, 0.13 * strength, hue)
}

/// A file's type colour as an OKLCH hue, by extension: the twin of `fileTypeHue` in
/// `packages/drive/src/colour.ts`. A type not listed keeps the plain ink label.
const FILE_TYPE_HUES: [(&str, f64); 45] = [
    ("pdf", 25.0),
    ("doc", 255.0),
    ("docx", 255.0),
    ("odt", 255.0),
    ("rtf", 255.0),
    ("txt", 255.0),
    ("md", 255.0),
    ("pages", 255.0),
    ("xls", 145.0),
    ("xlsx", 145.0),
    ("ods", 145.0),
    ("csv", 145.0),
    ("tsv", 145.0),
    ("numbers", 145.0),
    ("ppt", 55.0),
    ("pptx", 55.0),
    ("odp", 55.0),
    ("key", 55.0),
    ("png", 160.0),
    ("jpg", 160.0),
    ("jpeg", 160.0),
    ("heic", 160.0),
    ("gif", 160.0),
    ("webp", 160.0),
    ("svg", 160.0),
    ("mp4", 345.0),
    ("mov", 345.0),
    ("webm", 345.0),
    ("mkv", 345.0),
    ("mp3", 290.0),
    ("m4a", 290.0),
    ("wav", 290.0),
    ("flac", 290.0),
    ("zip", 85.0),
    ("gz", 85.0),
    ("tar", 85.0),
    ("7z", 85.0),
    ("rar", 85.0),
    ("json", 200.0),
    ("js", 200.0),
    ("ts", 200.0),
    ("html", 200.0),
    ("css", 200.0),
    ("py", 200.0),
    ("rs", 200.0),
];

fn file_type_hue(name: &str) -> Option<f64> {
    let dot = name.rfind('.').filter(|&at| at > 0)?;
    let extension = name[dot + 1..].to_ascii_lowercase();
    FILE_TYPE_HUES.iter().find(|(ext, _)| *ext == extension).map(|&(_, hue)| hue)
}

/// A file's page mark in its type's colour, as ARGB: the label in every scheme, and the
/// sheet's edge and fill, faintly tinted, in light and dark (high contrast keeps the plain
/// sheet). The twin of the `--sheet-*` steps in `apps/web/src/styles.css`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct SheetShades {
    pub light_label: u32,
    pub dark_label: u32,
    pub light_high_label: u32,
    pub dark_high_label: u32,
    pub light_edge: u32,
    pub dark_edge: u32,
    pub light_fill: u32,
    pub dark_fill: u32,
}

/// A file's page mark colours from its name, or `None` for a type with no colour of its own.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn sheet_shades(name: String) -> Option<SheetShades> {
    let hue = file_type_hue(&name)?;
    Some(SheetShades {
        light_label: argb(0.5, 0.15, hue),
        dark_label: argb(0.74, 0.136, hue),
        light_high_label: argb(0.42, 0.15, hue),
        dark_high_label: argb(0.84, 0.11, hue),
        light_edge: argb(0.86, 0.05, hue),
        dark_edge: argb(0.44, 0.04, hue),
        light_fill: argb(0.992, 0.012, hue),
        dark_fill: argb(0.27, 0.015, hue),
    })
}

fn to_linear(channel: u8) -> f64 {
    let c = f64::from(channel) / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(value: f64) -> u32 {
    let c = value.clamp(0.0, 1.0);
    let encoded = if c <= 0.003_130_8 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
    (encoded * 255.0).round() as u32
}

/// A `#rrggbb` colour's OKLCH hue in degrees and how vivid it is, 0 (grey) to 1 (a swatch).
fn hue_of(colour: &str) -> (f64, f64) {
    let n = u32::from_str_radix(&colour[1..], 16).unwrap_or(0);
    let (r, g, b) = (to_linear((n >> 16) as u8), to_linear((n >> 8) as u8), to_linear(n as u8));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    let a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
    let bb = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;
    let hue = (bb.atan2(a).to_degrees() + 360.0) % 360.0;
    (hue, (a.hypot(bb) / 0.12).min(1.0))
}

/// OKLCH to opaque sRGB ARGB, each channel clipped into range.
fn argb(lightness: f64, chroma: f64, hue: f64) -> u32 {
    let (a, b) = (chroma * hue.to_radians().cos(), chroma * hue.to_radians().sin());
    let l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b).powi(3);
    let red = from_linear(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s);
    let green = from_linear(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s);
    let blue = from_linear(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s);
    0xFF00_0000 | (red << 16) | (green << 8) | blue
}

#[cfg(test)]
mod tests {
    use super::*;

    fn colour(value: &str) -> HashMap<String, String> {
        HashMap::from([(COLOUR_ATTRIBUTE.to_owned(), value.to_owned())])
    }

    fn channels(argb: u32) -> (i32, i32, i32) {
        (((argb >> 16) & 0xFF) as i32, ((argb >> 8) & 0xFF) as i32, (argb & 0xFF) as i32)
    }

    fn luminance(argb: u32) -> f64 {
        let (r, g, b) = channels(argb);
        0.2126 * to_linear(r as u8) + 0.7152 * to_linear(g as u8) + 0.0722 * to_linear(b as u8)
    }

    #[test]
    fn its_own_colour_wins_and_none_or_one_it_cannot_read_is_the_plain_colour() {
        assert_eq!(folder_colour(colour("#123456")).as_deref(), Some("#123456"));
        for bad in ["blue", "#fff", "#ABCDEF", " #123456", "#1234567", "#12345g"] {
            assert_eq!(folder_colour(colour(bad)), None, "{bad}");
            assert_eq!(folder_shades(colour(bad)), None, "{bad}");
        }
        assert_eq!(folder_shades(HashMap::new()), None);
    }

    #[test]
    fn a_colour_change_keeps_every_other_attribute() {
        let mut attributes = colour("#123456");
        attributes.insert("zz-later".into(), "kept".into());
        let set = with_folder_colour(attributes.clone(), Some(" #7C5CBF ".into())).unwrap();
        assert_eq!(set.get("colour").map(String::as_str), Some("#7c5cbf"));
        assert_eq!(set.get("zz-later").map(String::as_str), Some("kept"));
        let plain = with_folder_colour(attributes, None).unwrap();
        assert_eq!(plain, HashMap::from([("zz-later".to_owned(), "kept".to_owned())]));
    }

    #[test]
    fn a_colour_that_is_not_one_is_refused() {
        for bad in ["blue", "#fff", "", "oklch(0.7 0.1 250)", "#12345g"] {
            assert!(with_folder_colour(HashMap::new(), Some(bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_swatches_are_the_webs_in_order_with_names() {
        let swatches = folder_swatches();
        assert_eq!(swatches.iter().map(|s| s.colour.as_str()).collect::<Vec<_>>(), FOLDER_COLOURS);
        assert_eq!(swatches[0].name, "Blue");
        assert_eq!(swatches[7].name, "Orange");
    }

    #[test]
    fn a_swatch_is_drawn_in_its_hue_and_a_bad_value_grey() {
        let (r, g, b) = channels(swatch_argb(FOLDER_COLOURS[0].into()));
        assert!(b > r && b > g, "{r} {g} {b}");
        let (r, g, b) = channels(swatch_argb("nope".into()));
        assert!((r - g).abs() <= 1 && (g - b).abs() <= 1, "{r} {g} {b}");
    }

    #[test]
    fn a_file_takes_its_types_hue_as_the_web_does() {
        // The same names and hues `packages/drive/src/colour.test.ts` pins.
        for (name, hue) in [
            ("Report.PDF", 25.0),
            ("notes.md", 255.0),
            ("budget.xlsx", 145.0),
            ("deck.key", 55.0),
            ("photo.heic", 160.0),
            ("clip.mov", 345.0),
            ("song.flac", 290.0),
            ("backup.tar.gz", 85.0),
            ("main.rs", 200.0),
        ] {
            assert_eq!(file_type_hue(name), Some(hue), "{name}");
        }
        for name in ["README", ".env", "archive.unknownext", "trailing."] {
            assert_eq!(file_type_hue(name), None, "{name}");
            assert_eq!(sheet_shades(name.into()), None, "{name}");
        }
    }

    #[test]
    fn the_type_table_is_the_webs_entry_for_entry() {
        let web = include_str!("../../../packages/drive/src/colour.ts");
        let start = web.find("const FILE_TYPE_HUES").expect("the web's table");
        let body = &web[start..start + web[start..].find("};").expect("its end")];
        let mut theirs: Vec<(String, f64)> = body
            .lines()
            .filter_map(|line| line.trim().strip_suffix(','))
            .filter_map(|entry| entry.split_once(": "))
            .map(|(ext, hue)| (ext.trim_matches('\'').to_owned(), hue.parse().expect("a hue")))
            .collect();
        let mut ours: Vec<(String, f64)> =
            FILE_TYPE_HUES.iter().map(|&(ext, hue)| (ext.to_owned(), hue)).collect();
        theirs.sort_by(|a, b| a.0.cmp(&b.0));
        ours.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(ours, theirs);
    }

    /// WCAG contrast between two opaque ARGB colours.
    fn contrast(a: u32, b: u32) -> f64 {
        let (x, y) = (luminance(a), luminance(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    #[test]
    fn every_type_label_meets_contrast_for_its_text_in_every_scheme() {
        // The label's text is the surface: white in light, #1c1c1e (#2c2c2e in an iOS sheet) in dark,
        // #0a0a0b in dark high contrast. AA in the standard schemes, AAA in high contrast (DESIGN.md Colors).
        for &(ext, _) in &FILE_TYPE_HUES {
            let s = sheet_shades(format!("a.{ext}")).unwrap();
            for (label, text, need, scheme) in [
                (s.light_label, 0xFFFF_FFFF, 4.5, "light"),
                (s.dark_label, 0xFF1C_1C1E, 4.5, "dark"),
                (s.dark_label, 0xFF2C_2C2E, 4.5, "dark, in a sheet"),
                (s.light_high_label, 0xFFFF_FFFF, 7.0, "light high contrast"),
                (s.dark_high_label, 0xFF0A_0A0B, 7.0, "dark high contrast"),
            ] {
                let ratio = contrast(label, text);
                assert!(ratio >= need, "{ext} in {scheme}: {ratio:.2}");
            }
        }
    }

    #[test]
    fn a_type_label_reads_on_its_sheet_and_keeps_its_hue() {
        let pdf = sheet_shades("a.pdf".into()).unwrap();
        // White text on the light label and the light high-contrast one; the sheet stays near white.
        assert!(
            luminance(pdf.light_label) < 0.25 && luminance(pdf.light_high_label) < luminance(pdf.light_label)
        );
        assert!(luminance(pdf.light_fill) > 0.9 && luminance(pdf.dark_fill) < 0.1);
        let (r, g, b) = channels(pdf.light_label);
        assert!(r > g && r > b, "coral is red-led: {r} {g} {b}");
        let (r, g, b) = channels(sheet_shades("a.docx".into()).unwrap().light_label);
        assert!(b > r && b > g, "a document is blue: {r} {g} {b}");
    }

    #[test]
    fn the_back_sheet_is_darker_than_the_front_in_every_scheme() {
        for swatch in FOLDER_COLOURS {
            let s = folder_shades(colour(swatch)).unwrap();
            for (front, back) in [
                (s.light_front, s.light_back),
                (s.dark_front, s.dark_back),
                (s.light_high_front, s.light_high_back),
                (s.dark_high_front, s.dark_high_back),
            ] {
                assert!(luminance(front) > luminance(back), "{swatch}");
                assert_eq!(front >> 24, 0xFF, "opaque");
            }
            // Dark mode draws it deeper than light, and light high contrast deeper still.
            assert!(luminance(s.dark_front) < luminance(s.light_front), "{swatch}");
            assert!(luminance(s.light_high_front) < luminance(s.light_front), "{swatch}");
        }
    }

    #[test]
    fn a_grey_stays_grey() {
        let s = folder_shades(colour("#808080")).unwrap();
        let (r, g, b) = channels(s.light_front);
        assert!((r - g).abs() <= 1 && (g - b).abs() <= 1, "{r} {g} {b}");
    }

    #[test]
    fn a_swatch_keeps_its_hue_when_drawn() {
        // The light front of the blue swatch is blue: more blue than red or green.
        let (r, g, b) = channels(folder_shades(colour(FOLDER_COLOURS[0])).unwrap().light_front);
        assert!(b > r && b > g, "{r} {g} {b}");
        // And the coral one is red-led.
        let (r, g, b) = channels(folder_shades(colour(FOLDER_COLOURS[2])).unwrap().light_front);
        assert!(r > g && r > b, "{r} {g} {b}");
    }
}
