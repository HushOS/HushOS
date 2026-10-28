//! A folder's colour, as the phones draw it: the twin of
//! `packages/drive/src/colour.ts` (which says what the colour is and where it lives)
//! and of the folder steps in `apps/web/src/styles.css` (the lightness and vividness
//! it is drawn at in each scheme). The colour is the folder's `colour` attribute,
//! a lowercase `#rrggbb`; a folder without one, or with one this client cannot
//! read, shows a default worked out from its id, the same on every device.

use std::collections::HashMap;

const COLOUR_ATTRIBUTE: &str = "colour";

/// The swatches offered for a folder and the colours a new one starts with, in
/// the web's order: the default indexes into this list.
pub const FOLDER_COLOURS: [&str; 8] =
    ["#70adfb", "#53c48e", "#f28881", "#aa9cf7", "#00c3cb", "#e488be", "#8fbb5f", "#e99355"];

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

/// FNV-1a over the id's UTF-8 bytes, as the web computes it.
fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// The colour a folder with none of its own shows.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn default_folder_colour(node_id: String) -> String {
    FOLDER_COLOURS[fnv1a(&node_id) as usize % FOLDER_COLOURS.len()].to_owned()
}

/// The colour a folder is drawn in: its own, or its default when it has none it can use.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn folder_colour(node_id: String, attributes: HashMap<String, String>) -> String {
    match attributes.get(COLOUR_ATTRIBUTE) {
        Some(own) if is_colour(own) => own.clone(),
        _ => default_folder_colour(node_id),
    }
}

/// A folder's sheets in every scheme, from its id and its attributes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn folder_shades(node_id: String, attributes: HashMap<String, String>) -> FolderShades {
    let (hue, strength) = hue_of(&folder_colour(node_id, attributes));
    let draw = |l: f64, c: f64| argb(l, c * strength, hue);
    FolderShades {
        light_front: draw(LIGHT.front_l, LIGHT.front_c),
        light_back: draw(LIGHT.back_l, LIGHT.back_c),
        dark_front: draw(DARK.front_l, DARK.front_c),
        dark_back: draw(DARK.back_l, DARK.back_c),
        light_high_front: draw(LIGHT_HIGH.front_l, LIGHT_HIGH.front_c),
        light_high_back: draw(LIGHT_HIGH.back_l, LIGHT_HIGH.back_c),
        dark_high_front: draw(DARK_HIGH.front_l, DARK_HIGH.front_c),
        dark_high_back: draw(DARK_HIGH.back_l, DARK_HIGH.back_c),
    }
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

    /// The same ids and colours `packages/drive/src/colour.test.ts` pins.
    const PINNED: [(&str, &str); 5] = [
        ("00000000-0000-4000-8000-000000000000", "#e488be"),
        ("11111111-1111-4111-8111-111111111111", "#aa9cf7"),
        ("0195f3a2-7c4e-7b1a-9d2e-3f4a5b6c7d8e", "#f28881"),
        ("root", "#e488be"),
        ("é-ünïcode-✓", "#8fbb5f"),
    ];

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
    fn the_default_matches_the_web() {
        for (id, expected) in PINNED {
            assert_eq!(default_folder_colour(id.into()), expected, "{id}");
        }
    }

    #[test]
    fn its_own_colour_wins_and_one_it_cannot_read_shows_the_default() {
        let (id, fallback) = PINNED[1];
        assert_eq!(folder_colour(id.into(), colour("#123456")), "#123456");
        for bad in ["blue", "#fff", "#ABCDEF", " #123456", "#1234567", "#12345g"] {
            assert_eq!(folder_colour(id.into(), colour(bad)), fallback, "{bad}");
        }
        assert_eq!(folder_colour(id.into(), HashMap::new()), fallback);
    }

    #[test]
    fn the_back_sheet_is_darker_than_the_front_in_every_scheme() {
        for swatch in FOLDER_COLOURS {
            let s = folder_shades("x".into(), colour(swatch));
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
        let s = folder_shades("x".into(), colour("#808080"));
        let (r, g, b) = channels(s.light_front);
        assert!((r - g).abs() <= 1 && (g - b).abs() <= 1, "{r} {g} {b}");
    }

    #[test]
    fn a_swatch_keeps_its_hue_when_drawn() {
        // The light front of the blue swatch is blue: more blue than red or green.
        let (r, g, b) = channels(folder_shades("x".into(), colour(FOLDER_COLOURS[0])).light_front);
        assert!(b > r && b > g, "{r} {g} {b}");
        // And the coral one is red-led.
        let (r, g, b) = channels(folder_shades("x".into(), colour(FOLDER_COLOURS[2])).light_front);
        assert!(r > g && r > b, "{r} {g} {b}");
    }
}
