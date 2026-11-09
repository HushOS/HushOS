//! Push notifications on the phones (docs/devices-design.md 5; docs/push-relay-plan.md, PR 4).
//!
//! A push from the relay carries only an event id and a tag. The phone checks the tag is its own
//! handle's, fetches the event over its own session (`GET /api/notifications/:id`) and writes the
//! notice itself, in the web's words (`apps/web/src/lib/web-push.ts`, `noticeFor`). What the apps
//! share is here: the tag, reading the event, the words, and which relay a phone may hand its push
//! token to. The fetching and the system's notification calls stay in each app.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::bytes::{decode, encode};
use crate::canonical::uuid;
use crate::error::{input, CoreResult};

/// What every push says until the phone has written something better, and what it falls back to
/// on every failure: the relay's own text (crates/hushos-push), so a ping is always seen.
pub const PUSH_FALLBACK_TEXT: &str = "New activity in HushOS";

/// The relay the apps are built for. Only it holds HushOS's Apple and Google credentials, so a
/// server naming any other relay is one whose pushes could never reach these apps.
pub const PUSH_RELAY: &str = "https://push.hushos.com";

/// The longest sender name a notice shows, in characters.
const NAME_CHARS: usize = 64;

/// [`PUSH_FALLBACK_TEXT`], for the apps.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_fallback_text() -> String {
    PUSH_FALLBACK_TEXT.to_owned()
}

fn handle_bytes(handle: &str) -> CoreResult<Vec<u8>> {
    decode("push handle", handle, Some(32))
}

/// The tag the relay puts beside the event id for `handle`:
/// `base64url(SHA-256("hushos-push tag" ‖ 0x00 ‖ handle)[0..16])`, the relay's `handle::tag`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_tag(handle: String) -> CoreResult<String> {
    let bytes = handle_bytes(&handle)?;
    let mut hasher = Sha256::new();
    hasher.update(b"hushos-push tag");
    hasher.update([0u8]);
    hasher.update(&bytes);
    Ok(encode(&hasher.finalize()[..16]))
}

/// Whether a push's tag is `handle`'s: only then is it from this phone's own server and account.
/// A push for another handle (an account signed out of since, a registration replaced) is shown
/// with the fallback text and never fetched for.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_tag_matches(handle: String, tag: String) -> bool {
    push_tag(handle).is_ok_and(|own| own == tag)
}

/// Which relays besides [`PUSH_RELAY`] a build may register with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PushLocalRelay {
    /// A release build: none.
    None,
    /// A development build: one on this computer (`localhost`, `127.0.0.1`), plain http.
    ThisComputer,
    /// A development build on the Android emulator: also its address for the computer it runs on (`10.0.2.2`).
    ThisComputerFromEmulator,
}

/// Which relay a phone registers with, from what its server says (`relay` in
/// `GET /api/notifications/settings`): [`PUSH_RELAY`] only, or in a development build a relay on
/// this computer over plain http (`local`). `None` turns phone pushes off: the server has none, or
/// names one these apps cannot use, and the push token (which identifies the phone to Apple or
/// Google) is never handed to a host a server chose.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_relay_usable(relay: Option<String>, local: PushLocalRelay) -> Option<String> {
    let relay = relay?;
    let trimmed = relay.trim().trim_end_matches('/');
    if trimmed.eq_ignore_ascii_case(PUSH_RELAY) {
        return Some(PUSH_RELAY.to_owned());
    }
    if local == PushLocalRelay::None {
        return None;
    }
    let rest = trimmed.strip_prefix("http://")?;
    let (host, port) = rest.rsplit_once(':')?;
    let local = matches!(host, "localhost" | "127.0.0.1")
        || (host == "10.0.2.2" && local == PushLocalRelay::ThisComputerFromEmulator);
    let port_ok = !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit());
    (local && port_ok).then(|| format!("http://{host}:{port}"))
}

/// The kinds of event a server sends (`packages/db/src/schema` `NotificationKind`). A kind this
/// build does not know is `Other` and gets the fallback text, so a newer server never breaks a
/// notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PushEventKind {
    NewDevice,
    DeviceRemoved,
    DevicesRemoved,
    PasswordAttempts,
    Shared,
    FamilyInvitation,
    FamilyWaiting,
    Other,
}

/// One event as the phone read it: what its notice needs and nothing more.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PushEvent {
    pub id: String,
    pub kind: PushEventKind,
    /// `devices-removed`: how many went; 0 for every other kind.
    pub count: u32,
    /// `shared`: whose share it is, to name them from this phone's own pins.
    pub granter_user_id: Option<String>,
    /// `family-invitation` and `family-waiting`: the family.
    pub group_id: Option<String>,
}

fn field_uuid(data: &Value, key: &str, what: &str) -> CoreResult<String> {
    let value = data.get(key).and_then(Value::as_str).ok_or_else(|| input(format!("Invalid {what}.")))?;
    Ok(uuid(value, what)?.to_owned())
}

/// Reads `GET /api/notifications/:id`'s answer, `{ notification: { id, kind, createdAt, data } }`.
/// Refused unless it is the event `expected_id` names: a server answering for another event would
/// put that event's words under this push.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_event_read(json: String, expected_id: String) -> CoreResult<PushEvent> {
    let body: Value =
        serde_json::from_str(&json).map_err(|_| input("The notification could not be read."))?;
    let event = body.get("notification").ok_or_else(|| input("The notification could not be read."))?;
    let read = event_of(event)?;
    if read.id != expected_id {
        return Err(input("The server answered for another notification."));
    }
    Ok(read)
}

/// The events `GET /api/notifications` handed over, oldest first, and whether more wait.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PushEventPage {
    pub events: Vec<PushEvent>,
    pub more: bool,
}

/// Reads `GET /api/notifications`' answer, `{ notifications: [...], more }`, for the catch-up an app
/// does when it opens. An event that doesn't read is left out rather than failing the others.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_events_read(json: String) -> CoreResult<PushEventPage> {
    let body: Value =
        serde_json::from_str(&json).map_err(|_| input("The notifications could not be read."))?;
    let list = body
        .get("notifications")
        .and_then(Value::as_array)
        .ok_or_else(|| input("The notifications could not be read."))?;
    Ok(PushEventPage {
        events: list.iter().filter_map(|event| event_of(event).ok()).collect(),
        more: body.get("more").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn event_of(event: &Value) -> CoreResult<PushEvent> {
    let id = event.get("id").and_then(Value::as_str).ok_or_else(|| input("Invalid notification id."))?;
    uuid(id, "notification id")?;
    let empty = Value::Object(Default::default());
    let data = event.get("data").unwrap_or(&empty);
    let mut read = PushEvent {
        id: id.to_owned(),
        kind: PushEventKind::Other,
        count: 0,
        granter_user_id: None,
        group_id: None,
    };
    match event.get("kind").and_then(Value::as_str) {
        Some("new-device") => read.kind = PushEventKind::NewDevice,
        Some("device-removed") => read.kind = PushEventKind::DeviceRemoved,
        Some("devices-removed") => {
            read.kind = PushEventKind::DevicesRemoved;
            read.count = data
                .get("count")
                .and_then(Value::as_u64)
                .filter(|count| *count >= 1)
                .and_then(|count| u32::try_from(count).ok())
                .ok_or_else(|| input("Invalid number of devices."))?;
        }
        Some("password-attempts") => read.kind = PushEventKind::PasswordAttempts,
        Some("shared") => {
            read.kind = PushEventKind::Shared;
            read.granter_user_id = Some(field_uuid(data, "granterUserId", "sharer")?);
        }
        Some("family-invitation") => {
            read.kind = PushEventKind::FamilyInvitation;
            read.group_id = Some(field_uuid(data, "groupId", "family")?);
        }
        Some("family-waiting") => {
            read.kind = PushEventKind::FamilyWaiting;
            read.group_id = Some(field_uuid(data, "groupId", "family")?);
        }
        Some(_) => {}
        None => return Err(input("The notification could not be read.")),
    }
    Ok(read)
}

/// The notification channel (Android) or thread (iOS) a notice goes in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PushChannel {
    Security,
    Shared,
    Families,
    /// The fallback, and kinds this build does not know.
    Other,
}

/// What a tap on the notice opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum PushOpen {
    /// Account, Devices.
    Devices,
    /// Shared, With me.
    Shared,
    /// Account, Families.
    Families,
    /// The app as it was.
    App,
}

/// A notice's words and where it belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct PushNotice {
    /// Empty for the fallback, which is a body alone (the relay's alert has no title).
    pub title: String,
    pub body: String,
    pub channel: PushChannel,
    pub open: PushOpen,
}

/// The notice for a push the phone could not read: not its handle's, a fetch that failed, an
/// event gone or of a kind this build does not know.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_notice_fallback() -> PushNotice {
    PushNotice {
        title: String::new(),
        body: PUSH_FALLBACK_TEXT.to_owned(),
        channel: PushChannel::Other,
        open: PushOpen::App,
    }
}

/// Unicode's format characters (general category Cf): invisible, and some reorder what follows
/// (U+202E turns "Maya\u{202E}fdp.exe" into "Mayaexe.pdf" on screen). The list is Unicode 16's.
fn is_format(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// A sender's name as a notice shows it: format characters dropped, control characters and runs of
/// spaces made one space, at most 64 characters. Nothing left reads as no name.
fn shown_name(name: &str) -> Option<String> {
    let visible: String = name.chars().filter(|c| !is_format(*c)).collect();
    let mut out = String::new();
    for word in visible.split(|c: char| c.is_whitespace() || c.is_control()).filter(|word| !word.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    if out.is_empty() {
        return None;
    }
    if out.chars().count() > NAME_CHARS {
        out = out.chars().take(NAME_CHARS - 1).collect::<String>().trim_end().to_owned();
        out.push('…');
    }
    Some(out)
}

/// The words for an event, the web's `noticeFor`. `checked_sender` is the sharer's name only when
/// this phone holds a pin of them that this person verified by words themselves (not one trusted
/// through a family, not a first-seen pin, whose name is whatever the sharer called themselves);
/// otherwise `None`, and the notice says "Someone", so a stranger's words never reach the lock
/// screen.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn push_notice(event: PushEvent, checked_sender: Option<String>) -> PushNotice {
    let notice = |title: &str, body: String, channel, open| PushNotice {
        title: title.to_owned(),
        body,
        channel,
        open,
    };
    match event.kind {
        PushEventKind::NewDevice => notice(
            "New sign-in",
            "A new device signed in to your account.".to_owned(),
            PushChannel::Security,
            PushOpen::Devices,
        ),
        PushEventKind::DeviceRemoved => notice(
            "Device removed",
            "A device was removed from your account.".to_owned(),
            PushChannel::Security,
            PushOpen::Devices,
        ),
        PushEventKind::DevicesRemoved => notice(
            "Devices removed",
            if event.count == 1 {
                "1 device was removed from your account.".to_owned()
            } else {
                format!("{} devices were removed from your account.", event.count)
            },
            PushChannel::Security,
            PushOpen::Devices,
        ),
        PushEventKind::PasswordAttempts => notice(
            "Password attempts",
            "Someone kept trying to confirm your password.".to_owned(),
            PushChannel::Security,
            PushOpen::Devices,
        ),
        PushEventKind::Shared => notice(
            "Shared with you",
            match checked_sender.as_deref().and_then(shown_name) {
                Some(name) => format!("{name} shared something with you."),
                None => "Someone shared something with you.".to_owned(),
            },
            PushChannel::Shared,
            PushOpen::Shared,
        ),
        PushEventKind::FamilyInvitation => notice(
            "Family invitation",
            "You’re invited to join a family.".to_owned(),
            PushChannel::Families,
            PushOpen::Families,
        ),
        PushEventKind::FamilyWaiting => notice(
            "Family",
            "Someone is waiting to join your family.".to_owned(),
            PushChannel::Families,
            PushOpen::Families,
        ),
        PushEventKind::Other => push_notice_fallback(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZERO_HANDLE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const COUNTING_HANDLE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const ID: &str = "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
    const MAYA: &str = "6c1f0a3e-2b4d-4c5e-9f60-718293a4b5c6";

    fn event(kind: &str, data: &str) -> String {
        format!(
            r#"{{"notification":{{"id":"{ID}","kind":"{kind}","createdAt":"2026-11-09T10:00:00.000Z","data":{data}}}}}"#
        )
    }

    // Vectors worked out apart from this code (Python's hashlib), so a changed domain, a missing
    // 0x00 or a tag of the wrong length fails here before any push is shown generic.
    #[test]
    fn the_tag_is_the_relays() {
        assert_eq!(push_tag(ZERO_HANDLE.into()).unwrap(), "nyrW0f083uUoLEZY9MnvdA");
        assert_eq!(push_tag(COUNTING_HANDLE.into()).unwrap(), "RJpyedHO9-nnaWbVsgULiA");
    }

    #[test]
    fn a_tag_matches_only_its_own_handle() {
        let tag = push_tag(COUNTING_HANDLE.into()).unwrap();
        assert!(push_tag_matches(COUNTING_HANDLE.into(), tag.clone()));
        assert!(!push_tag_matches(ZERO_HANDLE.into(), tag.clone()));
        // A handle the relay would never have given (31 bytes, padded) matches nothing.
        assert!(!push_tag_matches("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg".into(), tag.clone()));
        assert!(!push_tag_matches(format!("{COUNTING_HANDLE}="), tag));
        assert!(!push_tag_matches(COUNTING_HANDLE.into(), String::new()));
    }

    #[test]
    fn only_hushos_relay_is_used_by_a_release_build() {
        assert_eq!(
            push_relay_usable(Some("https://push.hushos.com".into()), PushLocalRelay::None).as_deref(),
            Some(PUSH_RELAY)
        );
        assert_eq!(
            push_relay_usable(Some("https://PUSH.hushos.com/".into()), PushLocalRelay::None).as_deref(),
            Some(PUSH_RELAY)
        );
        assert_eq!(push_relay_usable(None, PushLocalRelay::None), None);
        for other in [
            "http://push.hushos.com",
            "https://push.hushos.com.example.org",
            "https://push.hushos.com@example.org",
            "https://example.org",
            "https://push.hushos.com/v1",
            "http://localhost:8080",
            "",
        ] {
            assert_eq!(push_relay_usable(Some(other.into()), PushLocalRelay::None), None, "{other}");
        }
    }

    #[test]
    fn a_development_build_also_takes_a_relay_on_this_computer() {
        use PushLocalRelay::{ThisComputer, ThisComputerFromEmulator};
        // A development build still takes HushOS's own relay.
        assert_eq!(push_relay_usable(Some(PUSH_RELAY.into()), ThisComputer).as_deref(), Some(PUSH_RELAY));
        assert_eq!(
            push_relay_usable(Some("http://localhost:8080/".into()), ThisComputer).as_deref(),
            Some("http://localhost:8080")
        );
        assert_eq!(
            push_relay_usable(Some("http://127.0.0.1:8080".into()), ThisComputer).as_deref(),
            Some("http://127.0.0.1:8080")
        );
        // 10.0.2.2 is the emulator's name for its computer; anywhere else it is some other machine.
        assert_eq!(push_relay_usable(Some("http://10.0.2.2:8080".into()), ThisComputer), None);
        assert_eq!(
            push_relay_usable(Some("http://10.0.2.2:8080".into()), ThisComputerFromEmulator).as_deref(),
            Some("http://10.0.2.2:8080")
        );
        for other in [
            "http://localhost",
            "http://localhost:",
            "http://localhost:80a",
            "http://localhost.example.org:8080",
            "http://example.org:8080",
            "http://localhost:8080/path",
            "https://localhost:8080",
        ] {
            assert_eq!(push_relay_usable(Some(other.into()), ThisComputerFromEmulator), None, "{other}");
        }
    }

    #[test]
    fn an_answer_for_another_event_is_refused() {
        let other = "1f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
        assert!(push_event_read(event("new-device", "{}"), other.into()).is_err());
        assert!(push_event_read(event("new-device", "{}"), ID.to_uppercase()).is_err());
        assert_eq!(
            push_event_read(event("new-device", "{}"), ID.into()).unwrap().kind,
            PushEventKind::NewDevice
        );
    }

    #[test]
    fn events_are_read_with_what_their_notice_needs() {
        let shared = push_event_read(
            event("shared", &format!(r#"{{"granterUserId":"{MAYA}","shareId":"{ID}","role":"viewer"}}"#)),
            ID.into(),
        )
        .unwrap();
        assert_eq!((shared.kind, shared.granter_user_id.as_deref()), (PushEventKind::Shared, Some(MAYA)));
        let removed = push_event_read(event("devices-removed", r#"{"count":3}"#), ID.into()).unwrap();
        assert_eq!((removed.kind, removed.count), (PushEventKind::DevicesRemoved, 3));
        let waiting =
            push_event_read(event("family-waiting", &format!(r#"{{"groupId":"{MAYA}"}}"#)), ID.into())
                .unwrap();
        assert_eq!((waiting.kind, waiting.group_id.as_deref()), (PushEventKind::FamilyWaiting, Some(MAYA)));
        // A shared event naming no one, or something that is not an id, is not read as anyone's.
        assert!(push_event_read(event("shared", "{}"), ID.into()).is_err());
        assert!(push_event_read(event("shared", r#"{"granterUserId":"Maya"}"#), ID.into()).is_err());
        assert!(push_event_read(event("devices-removed", r#"{"count":0}"#), ID.into()).is_err());
        assert!(push_event_read("not json".into(), ID.into()).is_err());
        assert!(push_event_read(r#"{"notifications":[]}"#.into(), ID.into()).is_err());
        // An event that names no kind is not taken for one of a kind this build doesn't know.
        let kindless = format!(
            r#"{{"notification":{{"id":"{ID}","createdAt":"2026-11-09T10:00:00.000Z","data":{{}}}}}}"#
        );
        assert!(push_event_read(kindless, ID.into()).is_err());
    }

    #[test]
    fn a_catch_up_list_keeps_the_events_that_read() {
        let page = push_events_read(format!(
            r#"{{"notifications":[
                {{"id":"{ID}","kind":"new-device","createdAt":"x","data":{{}}}},
                {{"id":"not-an-id","kind":"new-device","data":{{}}}},
                {{"id":"{MAYA}","kind":"shared","data":{{"granterUserId":"Maya"}}}},
                {{"id":"{MAYA}","kind":"devices-removed","data":{{"count":2}}}}
            ],"more":true}}"#
        ))
        .unwrap();
        assert!(page.more);
        assert_eq!(
            page.events.iter().map(|e| (e.id.as_str(), e.kind)).collect::<Vec<_>>(),
            vec![(ID, PushEventKind::NewDevice), (MAYA, PushEventKind::DevicesRemoved)]
        );
        assert!(!push_events_read(r#"{"notifications":[]}"#.into()).unwrap().more);
        assert!(push_events_read(r#"{"notification":{}}"#.into()).is_err());
    }

    #[test]
    fn a_kind_this_build_does_not_know_gets_the_fallback() {
        let read = push_event_read(event("approval-request", r#"{"anything":1}"#), ID.into()).unwrap();
        assert_eq!(read.kind, PushEventKind::Other);
        assert_eq!(push_notice(read, Some("Maya".into())), push_notice_fallback());
    }

    #[test]
    fn the_sharer_is_named_only_when_checked() {
        let shared =
            push_event_read(event("shared", &format!(r#"{{"granterUserId":"{MAYA}"}}"#)), ID.into()).unwrap();
        assert_eq!(
            push_notice(shared.clone(), Some("Maya Lind".into())).body,
            "Maya Lind shared something with you."
        );
        assert_eq!(push_notice(shared.clone(), None).body, "Someone shared something with you.");
        // A name that is only blanks names nobody; one with line breaks stays on one line.
        assert_eq!(
            push_notice(shared.clone(), Some(" \n\t ".into())).body,
            "Someone shared something with you."
        );
        assert_eq!(
            push_notice(shared.clone(), Some("Maya\nYour account is locked".into())).body,
            "Maya Your account is locked shared something with you."
        );
        // Format characters are invisible or reorder what follows: dropped, never shown.
        assert_eq!(
            push_notice(shared.clone(), Some("Maya\u{202E}fdp.exe".into())).body,
            "Mayafdp.exe shared something with you."
        );
        assert_eq!(
            push_notice(shared.clone(), Some("\u{200B}\u{2066}\u{FEFF}".into())).body,
            "Someone shared something with you."
        );
        assert_eq!(
            push_notice(shared.clone(), Some("Ma\u{00AD}ya\u{E0041}".into())).body,
            "Maya shared something with you."
        );
        let long = push_notice(shared.clone(), Some("M".repeat(500))).body;
        assert_eq!(long, format!("{}… shared something with you.", "M".repeat(63)));
        let notice = push_notice(shared, None);
        assert_eq!(
            (notice.title.as_str(), notice.channel, notice.open),
            ("Shared with you", PushChannel::Shared, PushOpen::Shared)
        );
    }

    #[test]
    fn security_notices_go_in_their_own_channel_and_open_devices() {
        for (kind, data, title, body) in [
            ("new-device", "{}", "New sign-in", "A new device signed in to your account."),
            ("device-removed", "{}", "Device removed", "A device was removed from your account."),
            (
                "devices-removed",
                r#"{"count":1}"#,
                "Devices removed",
                "1 device was removed from your account.",
            ),
            (
                "devices-removed",
                r#"{"count":4}"#,
                "Devices removed",
                "4 devices were removed from your account.",
            ),
            ("password-attempts", "{}", "Password attempts", "Someone kept trying to confirm your password."),
        ] {
            let notice =
                push_notice(push_event_read(event(kind, data), ID.into()).unwrap(), Some("Maya".into()));
            assert_eq!(
                (notice.title.as_str(), notice.body.as_str(), notice.channel, notice.open),
                (title, body, PushChannel::Security, PushOpen::Devices),
                "{kind}"
            );
        }
    }

    #[test]
    fn family_notices_never_carry_the_inviters_words() {
        let group = format!(r#"{{"groupId":"{MAYA}","invitationId":"{ID}"}}"#);
        let invited = push_notice(
            push_event_read(event("family-invitation", &group), ID.into()).unwrap(),
            Some("Maya".into()),
        );
        assert_eq!(
            (invited.title.as_str(), invited.body.as_str()),
            ("Family invitation", "You’re invited to join a family.")
        );
        assert_eq!((invited.channel, invited.open), (PushChannel::Families, PushOpen::Families));
        let waiting = push_notice(push_event_read(event("family-waiting", &group), ID.into()).unwrap(), None);
        assert_eq!(
            (waiting.title.as_str(), waiting.body.as_str()),
            ("Family", "Someone is waiting to join your family.")
        );
    }
}
