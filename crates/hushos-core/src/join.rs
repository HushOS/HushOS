//! Joining a family (docs/groups-design.md 2.4 and 3.2), the newcomer's side,
//! all of it: the twin of the web worker's join (`packages/crypto/src/session-groups.ts`:
//! `groupJoinPreview`, `groupJoinCheck` and `groupAccept` with `joining`) and
//! of the escalation it runs (`packages/crypto/src/join-session.ts`), so
//! neither phone writes a rule of its own:
//!
//! - [`AreaLedger::group_join_preview`] verifies what route 5 served as
//!   acceptance would and shows the join code of the roster at which this
//!   account's entry last became active, with two hidden positions this core
//!   draws from the system CSPRNG when the code is first shown
//!   ([`JoinSession::hidden`]); they stay with that code until a match.
//!   Nothing is committed, kept, marked or set as a fork.
//! - [`AreaLedger::join_check`] is "They match": the served chain worked out
//!   again (another code is [`JoinCheck::Changed`], and the typed words are not
//!   checked against the old one), then the two typed words against the code
//!   at the positions issued for it. The first wrong pair for the family is
//!   [`JoinCheck::WrongWords`] and holds that code's positions; any later wrong
//!   pair for the family, for that code or another, is [`JoinCheck::Mismatch`].
//!   A match is [`JoinCheck::Matched`] with a [`JoinMatched`], which only this
//!   core makes, and the joins record that keeps it across a relaunch.
//! - [`AreaLedger::accept_joining`] commits the family with the compared code
//!   as its join mark, only for a [`JoinMatched`] whose code the served chain
//!   still gives. A joins record is a standing permission to commit the
//!   compared code for that family until the app deletes it; that a record
//!   was used only stops a double submission within one unlock.
//! - The escalation (the held positions and the family's wrong pair) goes in
//!   and out of [`AreaLedger::group_join_preview`] and [`AreaLedger::join_check`]
//!   as a sealed blob (`holds`): the core holds it in memory within an unlock,
//!   and the app keeps the blob so it survives a lock or the app being killed.
//!
//! Guessing the two hidden words is 22 bits at positions the server does not
//! know, which bounds finishing a join alone; the ten compared words are the
//! defence against a server grinding a made-up family, and holding the
//! positions after a wrong pair keeps a person who retries from handing such a
//! server fresh positions each time.
//!
//! The shared fixtures (`joinPreviews`, `joinChecks`, `joinSessions` in
//! `fixtures/web-join.json` and `packages/crypto/src/__fixtures__/core-join.json`)
//! hold the twins to each other, and the fuzz kinds `join_check` and
//! `join_preview` in `pins` compare them on any input.

use crate::area_ledger::{AreaLedger, ServedAccount, NOT_THIS_ACCOUNT, NO_ACCOUNT};
use crate::canonical::uuid;
use crate::device_record::{
    lost_race, open_bytes, overtaken, seal_bytes, ChainRecord, Marks, Reader, RecordCache, ServedAcceptance,
    ServedChain, BAD_CACHE,
};
use crate::error::{input, CoreError, CoreResult};
use crate::group_trust::{
    accept_rosters, group_pin_check, join_code, AcceptedRosters, ForkOf, GroupPin, JoinMark, MarkSide,
    OwnIdentities, RosterChain,
};
use crate::groups::{parse_roster, roster_digest, Roster, SignedGroupStatement};
use crate::signatures::digest as sha256_base64url;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use zeroize::Zeroizing;

/// A served roster in the run that reaches the head is missing: the code cannot be worked out.
const LEFT_OUT: &str = "The server left out part of the family’s member list.";
const NOT_ON_HISTORY: &str = "This member list is not on the family’s history.";
const BAD_CODE: &str = "Invalid join code.";
const BAD_HIDDEN: &str = "Invalid hidden positions.";
/// A check of a showing this ledger does not hold for the family: another
/// ledger's with other positions, one from before a lock, or one whose
/// positions a restored escalation replaced.
pub const NOT_SHOWN: &str = "Compare the join code again.";
/// A [`JoinMatched`] from before a lock or the app's relaunch, for this same account.
const STALE_MATCH: &str =
    "This join was compared before the app was locked. Open it again from its saved record.";
/// A kept escalation (`holds`) that does not open for this account and family: delete it.
pub const HOLDS_UNREADABLE: &str = "This saved join check could not be opened on this account.";
/// More codes shown for one family than a join ever needs, every one held by a wrong pair.
const TOO_MANY: &str = "Too many join codes were shown for this family. Compare it again later.";
/// The codes one family's book keeps, held ones first to stay.
pub(crate) const MAX_SHOWN_CODES: usize = 64;
/// A [`JoinMatched`] handed to another family's acceptance.
const OTHER_FAMILY: &str = "This join code was compared for another family.";
/// A [`JoinMatched`] (or its joins record) that already joined the family in this session.
const USED: &str = "This join code was already used to join. Compare it again.";
const JOINS: &str = "joins";
const HOLDS: &str = "holds";

/// What the person is told after a wrong pair, the calm line (`again` false)
/// or the alarm's (`again` true), with `them` the admin's name. The web's join
/// page says the same words (`joinCheckMessage` in `packages/crypto/src/join-session.ts`).
///
/// ```
/// assert!(hushos_core::join_check_message(false, "Maya".into()).contains("Ask Maya to read them again"));
/// assert!(hushos_core::join_check_message(true, "Maya".into()).contains("different member list"));
/// ```
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn join_check_message(again: bool, them: String) -> String {
    if again {
        format!(
            "The join code doesn’t match what {them} sees. HushOS may be showing you a different member list. Don’t use this family until you’ve sorted it out together."
        )
    } else {
        format!(
            "One of the words doesn’t match. Ask {them} to read them again. If they still don’t match, choose They don’t match."
        )
    }
}

/* The positions hidden for one code, whether a wrong pair holds them, and when it was first shown. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Issued {
    positions: [u32; 2],
    held: bool,
    seq: u64,
}

type CodeKey = (u64, Vec<String>);

/* One family's escalation: its wrong pair, and the positions issued for each code shown (bounded). */
#[derive(Default)]
struct Family {
    tried: bool,
    issued: HashMap<CodeKey, Issued>,
    seq: u64,
}

impl Family {
    /* Room for one more code: the earliest shown code no wrong pair holds goes; refused when all are held. */
    fn make_room(&mut self) -> CoreResult<()> {
        if self.issued.len() < MAX_SHOWN_CODES {
            return Ok(());
        }
        let oldest =
            self.issued.iter().filter(|(_, issued)| !issued.held).min_by_key(|(_, issued)| issued.seq);
        let Some((key, _)) = oldest else {
            return Err(input(TOO_MANY));
        };
        let key = key.clone();
        self.issued.remove(&key);
        Ok(())
    }

    fn insert(&mut self, key: CodeKey, positions: [u32; 2], held: bool) {
        self.seq += 1;
        self.issued.insert(key, Issued { positions, held, seq: self.seq });
    }
}

/// The join state an [`AreaLedger`] holds per family for the unlocked account
/// (dropped with it, by [`AreaLedger::clear`] or another account), and the
/// joins records that already joined each family this session.
#[derive(Default)]
pub struct JoinBook {
    families: HashMap<String, Family>,
    consumed: HashMap<String, HashSet<String>>,
}

impl JoinBook {
    /* A forgotten family's used joins records go (a join kept nowhere runs again); its escalation stays. */
    pub(crate) fn forget(&mut self, group_id: &str) {
        self.consumed.remove(group_id);
    }
}

/// One showing of a join code, as [`AreaLedger::group_join_preview`] makes
/// it: the code, and the two positions the screen hides, fixed when this
/// ledger first showed the code and kept until a match. Swift and Kotlin
/// cannot make one. A check takes it only while this ledger, in this unlock,
/// still holds these positions for its code: not after a lock, and not after
/// a restored escalation replaced them (another ledger's showing of the same
/// code with the same positions would pass, which changes nothing).
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct JoinSession {
    user_id: String,
    generation: u64,
    group_id: String,
    mark: JoinMark,
    positions: [u32; 2],
}

impl std::fmt::Debug for JoinSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinSession").field("group_id", &self.group_id).field("mark", &self.mark).finish()
    }
}

impl PartialEq for JoinSession {
    fn eq(&self, other: &Self) -> bool {
        self.group_id == other.group_id && self.mark == other.mark && self.positions == other.positions
    }
}
impl Eq for JoinSession {}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl JoinSession {
    /// The two positions (0 to 11, ascending) the screen hides and the person types.
    pub fn hidden(&self) -> Vec<u32> {
        self.positions.to_vec()
    }
    /// The roster the code is of: the one that let this account in.
    pub fn roster_version(&self) -> u64 {
        self.mark.roster_version
    }
    /// The twelve words; show the ten not hidden.
    pub fn code(&self) -> Vec<String> {
        self.mark.code.clone()
    }
    pub fn group_id(&self) -> String {
        self.group_id.clone()
    }
}

/// A code the person compared and whose two hidden words they typed right,
/// as [`AreaLedger::join_check`] returns it (or [`AreaLedger::join_matched_open`]
/// reopens it from its joins record). Swift and Kotlin cannot make one: no
/// joined family is committed without a match. It belongs to the unlock it
/// was made in; after a lock or a relaunch, reopen it from the record.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct JoinMatched {
    user_id: String,
    generation: u64,
    group_id: String,
    mark: JoinMark,
    checked_at: String,
    record: String,
}

impl std::fmt::Debug for JoinMatched {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinMatched").field("group_id", &self.group_id).field("mark", &self.mark).finish()
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl JoinMatched {
    /// The joins record: keep it (one per family) only between the match and
    /// the join's end, so a relaunch finishes the join without asking again
    /// ([`AreaLedger::join_matched_open`]); delete it once the family is
    /// joined. It is a standing permission to commit this code for this
    /// family until it is deleted.
    pub fn record(&self) -> String {
        self.record.clone()
    }
    pub fn group_id(&self) -> String {
        self.group_id.clone()
    }
    pub fn roster_version(&self) -> u64 {
        self.mark.roster_version
    }
}

/// What [`AreaLedger::group_join_preview`] found. Nothing of it is kept but the hidden positions.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum JoinPreview {
    /// The code to compare with the admin's screen: twelve words over the
    /// roster at `roster_version`, the one at which this account's entry last
    /// became active. Show the ten `session` does not hide.
    Code { roster_version: u64, code: Vec<String>, session: Arc<JoinSession> },
    /// The served chain holds no active entry for this account at its head:
    /// not let in yet (keep waiting), or no longer a member.
    NotAdmitted,
    /// The person's own marks (a rejoin's settings pin, this device's record,
    /// a chain this session holds) disagree with what was served: the hard
    /// warning. Nothing is set as a fork.
    Fork { of: ForkOf, version: u64, sides: Vec<MarkSide> },
    /// This device's chain record did not open (a master-key rotation):
    /// delete it and preview again without it.
    RecordUnreadable,
}

/// What [`AreaLedger::join_check`] found. `holds` is the family's escalation
/// after the check, sealed: keep it in place of the one kept before, or
/// delete what is kept when it is `None`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum JoinCheck {
    /// The two words are the code's: keep `matched.record()` as the joins
    /// record, then [`AreaLedger::accept_joining`] with the same served chain.
    /// The family's wrong pair and this code's hold are cleared.
    Matched { matched: Arc<JoinMatched>, holds: Option<String> },
    /// The family's first wrong pair: most likely misheard. Say
    /// [`join_check_message`] (`again` false) and keep the same showing; its
    /// positions are held. Nothing of the family was kept.
    WrongWords { holds: Option<String> },
    /// A wrong pair again for the family, for this code or another: the
    /// alarm ([`join_check_message`] with `again` true). Nothing was kept.
    Mismatch { holds: Option<String> },
    /// Not two words, or one blank: ask for both. Nothing was checked.
    Incomplete,
    /// The served chain now gives another code (the member list changed, or
    /// the server shows something else): show this one; the typed words were
    /// not checked and nothing was kept.
    Changed { session: Arc<JoinSession> },
    /// No active entry for this account at the served head: keep waiting.
    NotAdmitted,
    /// The hard warning, as [`JoinPreview::Fork`].
    Fork { of: ForkOf, version: u64, sides: Vec<MarkSide> },
    /// This device's chain record did not open: delete it and check again.
    RecordUnreadable,
}

/// What [`AreaLedger::accept_joining`] found: [`ServedAcceptance`]'s shapes,
/// and the join's own two.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum JoinAcceptance {
    /// Committed: keep `record` and settle `pin` as for [`ServedAcceptance::Accepted`],
    /// then delete the joins record.
    Accepted { chain: Arc<AcceptedRosters>, record: String, pin: GroupPin },
    /// This account was let in again at a later roster, and the chain still
    /// passes through the roster compared with its code: delete the joins
    /// record and compare this code. Nothing was kept. (Another code at the
    /// roster compared is [`JoinAcceptance::Fork`], never this.)
    Changed { session: Arc<JoinSession> },
    /// No active entry for this account at the served head: keep waiting.
    NotAdmitted,
    /// The hard warning. Nothing was kept.
    Fork { of: ForkOf, version: u64, sides: Vec<MarkSide> },
    /// This device's chain record did not open: delete it and accept again.
    RecordUnreadable,
    /// As [`ServedAcceptance::Overtaken`]: read the record again and retry.
    Overtaken { split: bool },
}

/*
 * The roster at which `user_id`'s entry last became active on a verified
 * chain: the earliest version of the run of active entries that reaches the
 * head. Only served rosters whose digest is the chain's at their version are
 * read, so what the server adds beside them changes nothing; one missing from
 * the run is refused. None when the head has no active entry for them. The
 * worker's admittedAt (onChain, runStart).
 */
pub(crate) fn admitted_at(
    roster_digests: &[String],
    served: &[SignedGroupStatement],
    user_id: &str,
) -> CoreResult<Option<u64>> {
    let mut on_chain: HashMap<u64, Roster> = HashMap::new();
    for signed in served {
        // Not a roster of this chain: ignored, as acceptance ignores it.
        let Ok(roster) = parse_roster(&signed.statement) else { continue };
        let at = roster.roster_version;
        let chain_digest = at
            .checked_sub(1)
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| roster_digests.get(index));
        if chain_digest == Some(&roster_digest(signed.statement.clone())) {
            on_chain.insert(at, roster);
        }
    }
    let active = |version: u64| -> CoreResult<bool> {
        let roster = on_chain.get(&version).ok_or_else(|| input(LEFT_OUT))?;
        Ok(roster
            .members
            .iter()
            .find(|member| member.user_id == user_id)
            .is_some_and(|m| m.active_with(None)))
    };
    let mut version = roster_digests.len() as u64;
    if version == 0 || !active(version)? {
        return Ok(None);
    }
    while version > 1 && active(version - 1)? {
        version -= 1;
    }
    Ok(Some(version))
}

/* The join code of the roster at `version` on a verified chain, under the group key it is under (the worker's codeAt). */
pub(crate) fn code_at(chain: &AcceptedRosters, version: u64) -> CoreResult<Vec<String>> {
    let digests = chain.roster_digests();
    if version < 1 || version > digests.len() as u64 {
        return Err(input(NOT_ON_HISTORY));
    }
    // The group key that roster is under: one above every succession tied to an earlier roster.
    let key_version =
        1 + chain.cache().successions.iter().filter(|out| out.last_roster_version < version).count() as u64;
    let key = chain.group_keys()[(key_version - 1) as usize].clone();
    join_code(digests[(version - 1) as usize].clone(), key, key_version)
}

/* What the served chain says of this account's admission, verified as acceptance would and kept nowhere. */
enum Admission {
    Code(JoinMark, Arc<AcceptedRosters>),
    NotAdmitted,
    Fork { of: ForkOf, version: u64, sides: Vec<MarkSide> },
    RecordUnreadable,
}

/* An admission, with the marks it was read against (none for an unreadable record). */
struct Admitted {
    admission: Admission,
    marks: Option<Marks>,
}

/* One of 0 to 11 from 32-bit draws, without modulo bias (the worker's position()); none when the draws run out. */
fn position(next: &mut dyn FnMut() -> Option<u32>) -> Option<u32> {
    const LIMIT: u64 = (1 << 32) - ((1 << 32) % 12);
    loop {
        let value = next()?;
        if u64::from(value) < LIMIT {
            return Some(value % 12);
        }
    }
}

/* Two distinct positions for one showing, ascending. */
fn hidden_positions(next: &mut dyn FnMut() -> Option<u32>) -> Option<[u32; 2]> {
    let first = position(next)?;
    let mut second = position(next)?;
    while second == first {
        second = position(next)?;
    }
    Some(if first < second { [first, second] } else { [second, first] })
}

/// The two positions a showing hides when its 32-bit draws are `draws` in
/// order, or none when they run out first: what the shared draws and the fuzz
/// kind `join_draws` hold the twins to.
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn join_draw_positions(draws: Vec<u32>) -> Option<Vec<u32>> {
    let mut draws = draws.into_iter();
    hidden_positions(&mut || draws.next()).map(|positions| positions.to_vec())
}

/* JavaScript's String.prototype.trim set (WhiteSpace and LineTerminator), so the twins read typed words alike. */
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{D}'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/* A code as join_code writes it: twelve words of 3 to 8 lowercase ASCII letters (the join mark's rule). */
fn code_shape(code: &[String]) -> bool {
    code.len() == 12
        && code
            .iter()
            .all(|word| (3..=8).contains(&word.len()) && word.bytes().all(|c| c.is_ascii_lowercase()))
}

/* Two words, neither blank. */
fn typed_complete(typed: &[String]) -> bool {
    typed.len() == 2 && typed.iter().all(|word| !word.trim_matches(js_space).is_empty())
}

/// The bare typed-words rule, for the shared cases and the fuzz targets: the
/// two words (trimmed with JavaScript's `trim` set, lowercased) against the
/// code at two strictly ascending positions in 0..=11. Apps never call it:
/// [`AreaLedger::join_check`] runs it at the positions this core issued.
#[cfg(feature = "fixtures")]
#[doc(hidden)]
pub fn join_words(code: Vec<String>, hidden: Vec<u32>, typed: Vec<String>) -> CoreResult<JoinWords> {
    words_rule(code, hidden, typed)
}

fn words_rule(code: Vec<String>, hidden: Vec<u32>, typed: Vec<String>) -> CoreResult<JoinWords> {
    if !code_shape(&code) {
        return Err(input(BAD_CODE));
    }
    if hidden.len() != 2 || hidden[0] >= hidden[1] || hidden[1] > 11 {
        return Err(input(BAD_HIDDEN));
    }
    if !typed_complete(&typed) {
        return Ok(JoinWords::Incomplete);
    }
    let same = hidden
        .iter()
        .zip(&typed)
        .all(|(at, word)| word.trim_matches(js_space).to_lowercase() == code[*at as usize]);
    Ok(if same { JoinWords::Match } else { JoinWords::NoMatch })
}

/// The bare typed-words rule's answer.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinWords {
    Match,
    NoMatch,
    Incomplete,
}

/*
 * The joins record's JSON, `{v:3, groupId, joinMark, checkedAt}`, which only
 * this core and the worker seal. Version 2 was sealed through the data layer
 * (the earlier join.ts) and is refused: a join in flight compares the code
 * once more.
 */
fn joins_value(group_id: &str, mark: &JoinMark, checked_at: &str) -> Value {
    json!({
        "v": 3,
        "groupId": group_id,
        "joinMark": { "rosterVersion": mark.roster_version, "code": mark.code },
        "checkedAt": checked_at,
    })
}

/* A joins record's mark and check time, or none: not version 3, another family's, or a mark no join takes. */
fn joins_read(group_id: &str, value: &Value) -> Option<(JoinMark, String)> {
    let record = value.as_object()?;
    if record.get("v")?.as_u64()? != 3 || record.get("groupId")?.as_str()? != group_id {
        return None;
    }
    let mark = record.get("joinMark")?.as_object()?;
    let code: Vec<String> = mark
        .get("code")?
        .as_array()?
        .iter()
        .map(|w| w.as_str().map(str::to_string))
        .collect::<Option<_>>()?;
    let roster_version = mark.get("rosterVersion")?.as_u64()?;
    if !code_shape(&code) || !(1..=crate::signatures::MAX_SAFE_INTEGER).contains(&roster_version) {
        return None;
    }
    Some((JoinMark { roster_version, code }, record.get("checkedAt")?.as_str()?.to_string()))
}

impl AreaLedger {
    /* The served chain's admission for this account, verified against the person's marks (the worker's admission). */
    fn admission(
        &self,
        me: &OwnIdentities,
        group_id: &str,
        record: Option<String>,
        served: &ServedChain,
    ) -> CoreResult<Admitted> {
        uuid(group_id, "group id")?;
        let Some(marks) = self.open_marks(me, group_id, record)? else {
            return Ok(Admitted { admission: Admission::RecordUnreadable, marks: None });
        };
        let (cache, record_pin) = match &marks.record {
            None => (RecordCache::None, Ok(None)),
            Some(ChainRecord { cache, pin }) => (cache.clone(), pin.clone()),
        };
        // The person's pins in the worker's order (settings, then the record's), then the cache.
        if let Some(pin) = &marks.settings_pin {
            group_pin_check(group_id.into(), pin.clone())?;
        }
        let record_pin = record_pin?;
        let cache = match cache {
            RecordCache::None => None,
            RecordCache::Held(cache) => Some(*cache),
            RecordCache::Refused { .. } => return Err(input(BAD_CACHE)),
        };
        let pins: Vec<GroupPin> = marks.settings_pin.clone().into_iter().chain(record_pin).collect();
        let marked = !pins.is_empty() || cache.is_some() || self.holds_family(group_id);
        // With no mark, over the served first keys, for the code only: the person compares it with
        // the admin's next, and only the acceptance that carries it vouches for anything.
        let chain = match accept_rosters(
            group_id.into(),
            served.first_keys.clone(),
            !marked,
            pins,
            served.rosters.clone(),
            served.successions.clone(),
            served.signer_keys.clone(),
            me.clone(),
            cache,
        )? {
            RosterChain::Fork { of, version, sides } => {
                return Ok(Admitted { admission: Admission::Fork { of, version, sides }, marks: Some(marks) })
            }
            RosterChain::Accepted { chain } => chain,
        };
        let admission = match admitted_at(&chain.roster_digests(), &served.rosters, &marks.account.user_id)? {
            None => Admission::NotAdmitted,
            Some(version) => Admission::Code(
                JoinMark { roster_version: version, code: code_at(&chain, version)? },
                Arc::clone(&chain),
            ),
        };
        Ok(Admitted { admission, marks: Some(marks) })
    }

    /* One showing of `mark`: the positions issued for it, drawn only when the code was never shown. */
    fn show(&self, user_id: &str, group_id: &str, mark: JoinMark) -> CoreResult<Arc<JoinSession>> {
        self.join_book(|book, generation| {
            let family = book.families.entry(group_id.to_string()).or_default();
            let key = (mark.roster_version, mark.code.clone());
            let positions = match family.issued.get(&key) {
                Some(issued) => issued.positions,
                None => {
                    family.make_room()?;
                    let positions =
                        hidden_positions(&mut || Some(self.next_u32())).expect("the CSPRNG never runs out");
                    family.insert(key, positions, false);
                    positions
                }
            };
            Ok(Arc::new(JoinSession {
                user_id: user_id.to_string(),
                generation,
                group_id: group_id.to_string(),
                mark,
                positions,
            }))
        })
    }

    /* Folds a kept escalation in (only ever more held); refused as sealed when it does not open here. */
    fn restore_holds(
        &self,
        account: &ServedAccount,
        group_id: &str,
        holds: Option<String>,
    ) -> CoreResult<()> {
        let Some(sealed) = holds else { return Ok(()) };
        let unreadable = || CoreError::Sealed(HOLDS_UNREADABLE.into());
        let plaintext = match open_bytes(&account.store_key, &account.user_id, group_id, HOLDS, &sealed) {
            Ok(plaintext) => plaintext,
            Err(CoreError::Sealed(_)) => return Err(unreadable()),
            Err(error) => return Err(error),
        };
        let value: Value = serde_json::from_slice(&plaintext).map_err(|_| unreadable())?;
        self.join_book(|book, _| {
            restore_into(book.families.entry(group_id.to_string()).or_default(), &value)
        });
        Ok(())
    }

    /* The family's escalation sealed for the app to keep, or none when nothing is held. */
    fn export_holds(&self, account: &ServedAccount, group_id: &str) -> CoreResult<Option<String>> {
        match self.join_book(|book, _| book.families.get(group_id).and_then(holds_value)) {
            None => Ok(None),
            Some(value) => {
                let plaintext = Zeroizing::new(value.to_string().into_bytes());
                seal_bytes(&account.store_key, &account.user_id, group_id, HOLDS, &plaintext).map(Some)
            }
        }
    }

    /* The join after a token's checks: the admission again, then the acceptance with the compared code. */
    fn accept_matched(
        &self,
        me: &OwnIdentities,
        group_id: &str,
        record: Option<String>,
        served: &ServedChain,
        matched: &JoinMatched,
    ) -> CoreResult<JoinAcceptance> {
        let Admitted { admission, marks } = self.admission(me, group_id, record, served)?;
        match admission {
            Admission::RecordUnreadable => return Ok(JoinAcceptance::RecordUnreadable),
            Admission::NotAdmitted => return Ok(JoinAcceptance::NotAdmitted),
            Admission::Fork { of, version, sides } => return Ok(JoinAcceptance::Fork { of, version, sides }),
            Admission::Code(current, chain) => {
                // Let in again at a later roster, on a chain that still passes through the roster
                // compared with its code: a new code to compare. Anything else that differs (another
                // code at that roster, a chain short of it) is the acceptance's to answer below,
                // with the compared code as its mark: the fork, or a refusal.
                let later = current.roster_version > matched.mark.roster_version
                    && code_at(&chain, matched.mark.roster_version)? == matched.mark.code;
                if later {
                    let account = &marks.as_ref().expect("read for a code").account;
                    let session = self.show(&account.user_id, group_id, current)?;
                    return Ok(JoinAcceptance::Changed { session });
                }
            }
        }
        let marks = marks.expect("read for a code");
        let (cache, record_pin) = match &marks.record {
            None => (RecordCache::None, Ok(None)),
            Some(ChainRecord { cache, pin }) => (cache.clone(), pin.clone()),
        };
        let reader = Reader { account: &marks.account, me, group_id, checked_at: &matched.checked_at };
        let outcome = match self.accept_once(
            &reader,
            served,
            &cache,
            marks.settings_pin.as_ref(),
            &record_pin,
            Some(&matched.mark),
            false,
        ) {
            Err(error) if lost_race(&error) => overtaken(&error),
            other => other?,
        };
        Ok(match outcome {
            ServedAcceptance::Accepted { chain, record, pin } => {
                JoinAcceptance::Accepted { chain, record, pin }
            }
            ServedAcceptance::Fork { of, version, sides } => JoinAcceptance::Fork { of, version, sides },
            ServedAcceptance::RecordUnreadable => JoinAcceptance::RecordUnreadable,
            ServedAcceptance::Overtaken { split } => JoinAcceptance::Overtaken { split },
            ServedAcceptance::FetchFromVersionOne => unreachable!("a join reads from version 1"),
        })
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl AreaLedger {
    /// The join code a newcomer compares with the admitting admin's screen
    /// (design 2.4, 3.2), over what route 5 served for `group_id` from version
    /// 1, and one showing of it. The chain is verified as acceptance verifies
    /// it, against the marks [`AreaLedger::accept_served`] reads (the settings
    /// pin, this device's chain record), with a chain this session committed
    /// or a fork it holds counted as a mark though not passed to acceptance
    /// (the worker's `marksOf`). With any mark the marks decide the first keys
    /// and the history (a rejoin); with none, the served version 1 keys are
    /// taken for the code only.
    ///
    /// `holds`, the family's escalation the app kept (from [`JoinCheck`]), is
    /// folded in first, before anything is verified: pass it on the first
    /// preview after an unlock, so a lock or a relaunch keeps the held
    /// positions and the family's wrong pair. Restoring only ever holds more.
    /// One that does not open here is refused as sealed with
    /// [`HOLDS_UNREADABLE`] (`CoreError::Sealed`): delete it, and preview
    /// again without it.
    ///
    /// The showing hides two positions this core draws from the system
    /// CSPRNG the first time it shows the code, and keeps for that code until
    /// a match. Nothing else is kept: no commit, no fork, no record or pin.
    /// `served.after` is not read. Refused, in the worker's order, for another
    /// account than the one [`AreaLedger::open_account`] opened, settings not
    /// open (after a record that does not open, which is
    /// [`JoinPreview::RecordUnreadable`]), and `me` without the account's
    /// signing key.
    ///
    /// ```
    /// use hushos_core::*;
    /// # fn main() -> CoreResult<()> {
    /// let (user, root) = ("00000001-abcd-4abc-8abc-abcdefabcdef".to_string(), vec![7u8; 32]);
    /// let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// let envelope = identity_create(user.clone(), root.clone(), 1)?;
    /// let keys = identity_open(user.clone(), root.clone(), envelope.clone())?;
    /// let public = public_identity(envelope)?;
    /// // A family whose first roster has this account as its only member.
    /// let entry = roster_entry_own(user.clone(), public.clone(), vec![GroupRole::Members])?;
    /// let roster = roster_first(group.clone(), GroupKind::Family, entry, None, None)?;
    /// let seed = vec![1u8; 64];
    /// let signed = roster_sign(roster, seed.clone(), keys)?;
    /// let ml_dsa = base64url_decode(public.ml_dsa_public_key.clone())?;
    /// let served = ServedChain {
    ///     after: 0,
    ///     first_keys: group_public_key(seed.clone())?,
    ///     rosters: vec![signed.clone()],
    ///     successions: vec![],
    ///     signer_keys: [(digest_base64url(key_digest(ml_dsa))?, public.ml_dsa_public_key.clone())].into(),
    /// };
    /// let me = OwnIdentities {
    ///     user_id: user.clone(),
    ///     identities: vec![ServedKeys {
    ///         key_version: 1,
    ///         encryption_public_key: public.encryption_public_key.clone(),
    ///         signing_public_key: public.signing_public_key.clone(),
    ///         ml_dsa_public_key: public.ml_dsa_public_key.clone(),
    ///         kem_public_key: public.kem_public_key.clone(),
    ///     }],
    /// };
    /// let ledger = AreaLedger::new();
    /// ledger.open_account(user.clone(), base64url_decode(public.signing_public_key.clone())?, root)?;
    /// // Settings first, as for any acceptance.
    /// assert!(ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), None).is_err());
    /// ledger.use_settings(user, Some(Default::default()), Default::default())?;
    /// let JoinPreview::Code { roster_version, code, session } =
    ///     ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), None)?
    /// else {
    ///     panic!("a code")
    /// };
    /// assert_eq!((roster_version, code), (1, join_code(roster_digest(signed.statement), group_public_key(seed)?, 1)?));
    /// let hidden = session.hidden();
    /// assert!(hidden.len() == 2 && hidden[0] < hidden[1] && hidden[1] <= 11);
    /// // Shown again: the same two positions, until a match.
    /// let JoinPreview::Code { session: again, .. } =
    ///     ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), None)?
    /// else {
    ///     panic!("a code")
    /// };
    /// assert_eq!(again.hidden(), hidden);
    /// // A kept escalation of someone else's is refused as sealed.
    /// assert!(matches!(
    ///     ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), Some("AAAA".into())),
    ///     Err(CoreError::Sealed(_))
    /// ));
    /// // Nothing was kept: with no mark at all, acceptance is still refused.
    /// assert!(ledger.accept_served(me, group, None, served, "2026-10-18T00:00:00.000Z".into()).is_err());
    /// # Ok(())
    /// # }
    /// ```
    pub fn group_join_preview(
        &self,
        me: OwnIdentities,
        group_id: String,
        record: Option<String>,
        served: ServedChain,
        holds: Option<String>,
    ) -> CoreResult<JoinPreview> {
        uuid(&group_id, "group id")?;
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        self.restore_holds(&account, &group_id, holds)?;
        let Admitted { admission, marks } = self.admission(&me, &group_id, record, &served)?;
        Ok(match admission {
            Admission::RecordUnreadable => JoinPreview::RecordUnreadable,
            Admission::NotAdmitted => JoinPreview::NotAdmitted,
            Admission::Fork { of, version, sides } => JoinPreview::Fork { of, version, sides },
            Admission::Code(mark, _) => {
                let user_id = marks.expect("read for a code").account.user_id;
                let session = self.show(&user_id, &group_id, mark.clone())?;
                JoinPreview::Code { roster_version: mark.roster_version, code: mark.code, session }
            }
        })
    }

    /// "They match": the person compared `session`'s code with the admin's
    /// screen and typed its two hidden words (`typed`, in the order of
    /// [`JoinSession::hidden`]). The twin of the web's confirmJoin and the
    /// worker's groupJoinCheck, in their order:
    ///
    /// - `holds`, the escalation the app kept, folded in as by
    ///   [`AreaLedger::group_join_preview`] (normally none here: pass it on
    ///   the first preview after an unlock);
    /// - `session` must be a showing whose positions this ledger still holds
    ///   for its code, for this account and family, in this unlock (refused
    ///   with [`NOT_SHOWN`] otherwise: preview again), and `typed` two words,
    ///   neither blank ([`JoinCheck::Incomplete`]), before anything is verified;
    /// - the served chain is worked out again as [`AreaLedger::group_join_preview`]
    ///   does; another code is [`JoinCheck::Changed`] with a showing of it, and
    ///   the typed words are never checked against a code no longer served;
    /// - the words are compared (trimmed, any case) with the code at the
    ///   positions issued for it. A match clears the family's wrong pair and
    ///   this code's hold and seals the joins record, checked at the settings
    ///   pin's check time when the account has one (a rejoin keeps its first
    ///   check), else `now`. A wrong pair holds the code's positions; it is
    ///   [`JoinCheck::WrongWords`] the first time for the family and
    ///   [`JoinCheck::Mismatch`] after that.
    ///
    /// Each of the three returns the escalation to keep (`holds`).
    ///
    /// ```
    /// use hushos_core::*;
    /// # fn main() -> CoreResult<()> {
    /// # let (user, root) = ("00000001-abcd-4abc-8abc-abcdefabcdef".to_string(), vec![7u8; 32]);
    /// # let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// # let envelope = identity_create(user.clone(), root.clone(), 1)?;
    /// # let keys = identity_open(user.clone(), root.clone(), envelope.clone())?;
    /// # let public = public_identity(envelope)?;
    /// # let entry = roster_entry_own(user.clone(), public.clone(), vec![GroupRole::Members])?;
    /// # let roster = roster_first(group.clone(), GroupKind::Family, entry, None, None)?;
    /// # let signed = roster_sign(roster, vec![1u8; 64], keys)?;
    /// # let ml_dsa = base64url_decode(public.ml_dsa_public_key.clone())?;
    /// # let signer_keys = [(digest_base64url(key_digest(ml_dsa))?, public.ml_dsa_public_key.clone())].into();
    /// # let served = ServedChain { after: 0, first_keys: group_public_key(vec![1u8; 64])?, rosters: vec![signed], successions: vec![], signer_keys };
    /// # let identities = vec![ServedKeys {
    /// #     key_version: 1,
    /// #     encryption_public_key: public.encryption_public_key.clone(),
    /// #     signing_public_key: public.signing_public_key.clone(),
    /// #     ml_dsa_public_key: public.ml_dsa_public_key.clone(),
    /// #     kem_public_key: public.kem_public_key.clone(),
    /// # }];
    /// # let me = OwnIdentities { user_id: user.clone(), identities };
    /// # let ledger = AreaLedger::new();
    /// # ledger.open_account(user.clone(), base64url_decode(public.signing_public_key.clone())?, root.clone())?;
    /// # ledger.use_settings(user.clone(), Some(Default::default()), Default::default())?;
    /// // A family whose one member previews their own admission, at roster 1.
    /// let preview = |holds| ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), holds);
    /// let JoinPreview::Code { session, .. } = preview(None)? else { panic!("a code") };
    /// let read_out: Vec<String> = session.hidden().iter().map(|at| session.code()[*at as usize].clone()).collect();
    /// let now = "2026-10-18T12:00:00.000Z".to_string();
    /// let other = if read_out[1] == "abandon" { "ability" } else { "abandon" };
    /// let misheard = vec![read_out[0].clone(), other.to_string()];
    /// let check = |session: std::sync::Arc<JoinSession>, typed: Vec<String>| {
    ///     ledger.join_check(me.clone(), group.clone(), None, served.clone(), session, typed, now.clone(), None)
    /// };
    /// // The first wrong pair is calm, holds the positions, and gives the escalation to keep.
    /// let JoinCheck::WrongWords { holds: Some(kept) } = check(session.clone(), misheard.clone())? else {
    ///     panic!("calm")
    /// };
    /// // The vault locks (the person went to ask the admin): what this ledger held is gone, and the
    /// // kept escalation brings it back on the next preview.
    /// ledger.clear();
    /// ledger.open_account(user.clone(), base64url_decode(public.signing_public_key.clone())?, root)?;
    /// ledger.use_settings(user, Some(Default::default()), Default::default())?;
    /// assert!(check(session.clone(), read_out.clone()).is_err(), "a showing from before the lock");
    /// let JoinPreview::Code { session, .. } = preview(Some(kept))? else { panic!("a code") };
    /// assert_eq!(session.hidden().iter().map(|at| session.code()[*at as usize].clone()).collect::<Vec<_>>(), read_out);
    /// assert!(matches!(check(session.clone(), misheard)?, JoinCheck::Mismatch { .. }));
    /// assert!(matches!(check(session.clone(), vec!["abandon".into()])?, JoinCheck::Incomplete));
    /// // As read out, any case: a match, its joins record to keep, and nothing left held.
    /// let JoinCheck::Matched { matched, holds } = check(session, read_out.iter().map(|w| w.to_uppercase()).collect())? else {
    ///     panic!("a match")
    /// };
    /// assert_eq!((matched.roster_version(), holds), (1, None));
    /// # Ok(())
    /// # }
    /// ```
    #[allow(clippy::too_many_arguments)]
    pub fn join_check(
        &self,
        me: OwnIdentities,
        group_id: String,
        record: Option<String>,
        served: ServedChain,
        session: Arc<JoinSession>,
        typed: Vec<String>,
        now: String,
        holds: Option<String>,
    ) -> CoreResult<JoinCheck> {
        uuid(&group_id, "group id")?;
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        self.restore_holds(&account, &group_id, holds)?;
        // A showing whose positions this ledger still holds for its code, in this unlock.
        let still_issued = self.join_book(|book, generation| {
            let key = (session.mark.roster_version, session.mark.code.clone());
            session.generation == generation
                && book
                    .families
                    .get(&group_id)
                    .and_then(|family| family.issued.get(&key))
                    .is_some_and(|issued| issued.positions == session.positions)
        });
        if session.group_id != group_id
            || !session.user_id.eq_ignore_ascii_case(&account.user_id)
            || !still_issued
        {
            return Err(input(NOT_SHOWN));
        }
        if !typed_complete(&typed) {
            return Ok(JoinCheck::Incomplete);
        }
        let Admitted { admission, marks } = self.admission(&me, &group_id, record, &served)?;
        let current = match admission {
            Admission::RecordUnreadable => return Ok(JoinCheck::RecordUnreadable),
            Admission::NotAdmitted => return Ok(JoinCheck::NotAdmitted),
            Admission::Fork { of, version, sides } => return Ok(JoinCheck::Fork { of, version, sides }),
            Admission::Code(current, _) => current,
        };
        let marks = marks.expect("read for a code");
        // Tests only: what a lock or a restore between the unlocked admission and the check does.
        #[cfg(test)]
        AFTER_ADMISSION.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(self)
            }
        });
        if current != session.mark {
            return Ok(JoinCheck::Changed { session: self.show(&account.user_id, &group_id, current)? });
        }
        let wrong = self.join_book(|book, generation| {
            let family = book.families.entry(group_id.clone()).or_default();
            let key = (current.roster_version, current.code.clone());
            let issued = family.issued.get_mut(&key).ok_or_else(|| input(NOT_SHOWN))?;
            // Read again after the admission ran unlocked: a lock, or a restore that replaced these
            // positions meanwhile, leaves a showing this unlock no longer holds.
            if generation != session.generation || issued.positions != session.positions {
                return Err(input(NOT_SHOWN));
            }
            let words = words_rule(current.code.clone(), issued.positions.to_vec(), typed.clone())?;
            if words == JoinWords::Match {
                issued.held = false;
                family.tried = false;
                return Ok(None);
            }
            let again = issued.held || family.tried;
            issued.held = true;
            family.tried = true;
            Ok::<_, CoreError>(Some(again))
        })?;
        let holds = self.export_holds(&account, &group_id)?;
        match wrong {
            Some(true) => return Ok(JoinCheck::Mismatch { holds }),
            Some(false) => return Ok(JoinCheck::WrongWords { holds }),
            None => {}
        }
        // A rejoin keeps the date the family was first checked on this account.
        let checked_at = marks.settings_pin.as_ref().map_or(now, |pin| pin.checked_at.clone());
        let plaintext =
            Zeroizing::new(joins_value(&group_id, &current, &checked_at).to_string().into_bytes());
        let record = seal_bytes(&account.store_key, &account.user_id, &group_id, JOINS, &plaintext)?;
        Ok(JoinCheck::Matched {
            matched: Arc::new(JoinMatched {
                user_id: account.user_id,
                generation: account.generation,
                group_id,
                mark: current,
                checked_at,
                record,
            }),
            holds,
        })
    }

    /// The [`JoinMatched`] a joins record keeps, after a relaunch: `None` when
    /// it does not open for this account and family (another root, a damaged
    /// or older record, version 2 included: delete it and compare the code
    /// again). Only this core writes joins records. Reopen it after every
    /// unlock: a [`JoinMatched`] belongs to the unlock it was made in.
    ///
    /// ```
    /// use hushos_core::*;
    /// # fn main() -> CoreResult<()> {
    /// # let (user, root) = ("00000001-abcd-4abc-8abc-abcdefabcdef".to_string(), vec![7u8; 32]);
    /// # let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// # let envelope = identity_create(user.clone(), root.clone(), 1)?;
    /// # let keys = identity_open(user.clone(), root.clone(), envelope.clone())?;
    /// # let public = public_identity(envelope)?;
    /// # let entry = roster_entry_own(user.clone(), public.clone(), vec![GroupRole::Members])?;
    /// # let roster = roster_first(group.clone(), GroupKind::Family, entry, None, None)?;
    /// # let signed = roster_sign(roster, vec![1u8; 64], keys)?;
    /// # let ml_dsa = base64url_decode(public.ml_dsa_public_key.clone())?;
    /// # let signer_keys = [(digest_base64url(key_digest(ml_dsa))?, public.ml_dsa_public_key.clone())].into();
    /// # let served = ServedChain { after: 0, first_keys: group_public_key(vec![1u8; 64])?, rosters: vec![signed], successions: vec![], signer_keys };
    /// # let identities = vec![ServedKeys {
    /// #     key_version: 1,
    /// #     encryption_public_key: public.encryption_public_key.clone(),
    /// #     signing_public_key: public.signing_public_key.clone(),
    /// #     ml_dsa_public_key: public.ml_dsa_public_key.clone(),
    /// #     kem_public_key: public.kem_public_key.clone(),
    /// # }];
    /// # let me = OwnIdentities { user_id: user.clone(), identities };
    /// # let ledger = AreaLedger::new();
    /// # ledger.open_account(user.clone(), base64url_decode(public.signing_public_key.clone())?, root)?;
    /// # ledger.use_settings(user, Some(Default::default()), Default::default())?;
    /// // A family whose one member previews their own admission, at roster 1.
    /// let JoinPreview::Code { session, .. } = ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), None)? else {
    ///     panic!("a code")
    /// };
    /// let read_out: Vec<String> = session.hidden().iter().map(|at| session.code()[*at as usize].clone()).collect();
    /// let now = "2026-10-18T12:00:00.000Z".to_string();
    /// let JoinCheck::Matched { matched, .. } =
    ///     ledger.join_check(me, group.clone(), None, served, session, read_out, now, None)?
    /// else {
    ///     panic!("a match")
    /// };
    /// // After a relaunch, the kept record is the same match.
    /// let reopened = ledger.join_matched_open(group.clone(), matched.record())?.expect("it opens");
    /// assert_eq!(reopened.roster_version(), matched.roster_version());
    /// // An app's own sealing of the same JSON is no joins record.
    /// let forged = ledger.group_device_record_seal(group.clone(), DeviceStore::Outbox, r#"{"v":3}"#.into())?;
    /// assert!(ledger.join_matched_open(group, forged)?.is_none());
    /// # Ok(())
    /// # }
    /// ```
    pub fn join_matched_open(
        &self,
        group_id: String,
        joins_record: String,
    ) -> CoreResult<Option<Arc<JoinMatched>>> {
        uuid(&group_id, "group id")?;
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        let plaintext =
            match open_bytes(&account.store_key, &account.user_id, &group_id, JOINS, &joins_record) {
                Ok(plaintext) => plaintext,
                Err(CoreError::Sealed(_)) => return Ok(None),
                Err(error) => return Err(error),
            };
        let Some((mark, checked_at)) =
            serde_json::from_slice::<Value>(&plaintext).ok().and_then(|value| joins_read(&group_id, &value))
        else {
            return Ok(None);
        };
        Ok(Some(Arc::new(JoinMatched {
            user_id: account.user_id,
            generation: account.generation,
            group_id,
            mark,
            checked_at,
            record: joins_record,
        })))
    }

    /// Commits the family the person joined: the twin of the worker's
    /// groupAccept with `joining`. Refused for a [`JoinMatched`] of another
    /// account, of this account from before a lock or relaunch (reopen it
    /// from its record), or of another family, and for one whose joins record
    /// was already taken in this unlock: checked and taken under the ledger's
    /// lock, given back when nothing is committed, and given back by
    /// forgetting the family (a join that was not kept runs again). That only
    /// stops a double submission; the record itself stands until the app
    /// deletes it.
    ///
    /// Then the served chain is worked out again. This account let in again
    /// at a later roster, on a chain that still passes through the roster
    /// compared with its code, is [`JoinAcceptance::Changed`]: compare the new
    /// code. Otherwise the chain is accepted with the compared code as its
    /// join mark (vouching for the first keys only where nothing marks the
    /// family): another code at the roster compared is the fork, a chain short
    /// of it refused, and the rest committed as [`AreaLedger::accept_served`]
    /// commits: never below or beside the family's floor, the record sealed,
    /// the pin after it checked at the joins record's time. Store the record
    /// in commit order, settle the pin, then delete the joins record.
    ///
    /// ```
    /// use hushos_core::*;
    /// # fn main() -> CoreResult<()> {
    /// # let (user, root) = ("00000001-abcd-4abc-8abc-abcdefabcdef".to_string(), vec![7u8; 32]);
    /// # let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a".to_string();
    /// # let envelope = identity_create(user.clone(), root.clone(), 1)?;
    /// # let keys = identity_open(user.clone(), root.clone(), envelope.clone())?;
    /// # let public = public_identity(envelope)?;
    /// # let entry = roster_entry_own(user.clone(), public.clone(), vec![GroupRole::Members])?;
    /// # let roster = roster_first(group.clone(), GroupKind::Family, entry, None, None)?;
    /// # let signed = roster_sign(roster, vec![1u8; 64], keys)?;
    /// # let ml_dsa = base64url_decode(public.ml_dsa_public_key.clone())?;
    /// # let signer_keys = [(digest_base64url(key_digest(ml_dsa))?, public.ml_dsa_public_key.clone())].into();
    /// # let served = ServedChain { after: 0, first_keys: group_public_key(vec![1u8; 64])?, rosters: vec![signed], successions: vec![], signer_keys };
    /// # let identities = vec![ServedKeys {
    /// #     key_version: 1,
    /// #     encryption_public_key: public.encryption_public_key.clone(),
    /// #     signing_public_key: public.signing_public_key.clone(),
    /// #     ml_dsa_public_key: public.ml_dsa_public_key.clone(),
    /// #     kem_public_key: public.kem_public_key.clone(),
    /// # }];
    /// # let me = OwnIdentities { user_id: user.clone(), identities };
    /// # let ledger = AreaLedger::new();
    /// # ledger.open_account(user.clone(), base64url_decode(public.signing_public_key.clone())?, root)?;
    /// # ledger.use_settings(user, Some(Default::default()), Default::default())?;
    /// // A family whose one member previews their own admission, at roster 1.
    /// let JoinPreview::Code { session, .. } = ledger.group_join_preview(me.clone(), group.clone(), None, served.clone(), None)? else {
    ///     panic!("a code")
    /// };
    /// let read_out: Vec<String> = session.hidden().iter().map(|at| session.code()[*at as usize].clone()).collect();
    /// let now = "2026-10-18T12:00:00.000Z".to_string();
    /// let JoinCheck::Matched { matched, .. } =
    ///     ledger.join_check(me.clone(), group.clone(), None, served.clone(), session, read_out, now.clone(), None)?
    /// else {
    ///     panic!("a match")
    /// };
    /// let joined = ledger.accept_joining(me.clone(), group.clone(), None, served.clone(), matched.clone())?;
    /// let JoinAcceptance::Accepted { pin, .. } = joined else { panic!("joined") };
    /// assert_eq!((pin.roster_version, pin.checked_at), (1, now));
    /// // A second submission in this unlock is refused.
    /// assert!(ledger.accept_joining(me, group, None, served, matched).is_err());
    /// # Ok(())
    /// # }
    /// ```
    pub fn accept_joining(
        &self,
        me: OwnIdentities,
        group_id: String,
        record: Option<String>,
        served: ServedChain,
        matched: Arc<JoinMatched>,
    ) -> CoreResult<JoinAcceptance> {
        uuid(&group_id, "group id")?;
        let account = self.served_account().ok_or_else(|| input(NO_ACCOUNT))?;
        if !matched.user_id.eq_ignore_ascii_case(&account.user_id) {
            return Err(input(NOT_THIS_ACCOUNT));
        }
        if matched.generation != account.generation {
            return Err(input(STALE_MATCH));
        }
        if matched.group_id != group_id {
            return Err(input(OTHER_FAMILY));
        }
        // Taken under the lock: a second submission of the same record meanwhile is refused.
        let used = sha256_base64url(matched.record.as_bytes());
        self.join_book(|book, _| {
            if book.consumed.entry(group_id.clone()).or_default().insert(used.clone()) {
                Ok(())
            } else {
                Err(input(USED))
            }
        })?;
        let outcome = self.accept_matched(&me, &group_id, record, &served, &matched);
        if !matches!(outcome, Ok(JoinAcceptance::Accepted { .. })) {
            self.join_book(|book, _| book.consumed.get_mut(&group_id).map(|taken| taken.remove(&used)));
        }
        outcome
    }
}

/* The family's escalation as kept: `{v:1, tried, held:[{rosterVersion, code, positions}]}`, sorted, or none. */
fn holds_value(family: &Family) -> Option<Value> {
    let mut held: Vec<(CodeKey, [u32; 2])> = family
        .issued
        .iter()
        .filter(|(_, issued)| issued.held)
        .map(|(key, issued)| (key.clone(), issued.positions))
        .collect();
    if !family.tried && held.is_empty() {
        return None;
    }
    held.sort();
    Some(json!({
        "v": 1,
        "tried": family.tried,
        "held": held.iter().map(|((version, code), positions)| json!({
            "rosterVersion": version, "code": code, "positions": positions,
        })).collect::<Vec<_>>(),
    }))
}

/*
 * Folds a kept escalation in: only ever more held. A code held here keeps its
 * positions; a code shown here but not held takes the kept positions, held
 * (showings of the old ones are then refused). Entries that do not read as a
 * roster version (1 to 2^53 - 1), a code and two positions are skipped, and
 * so is one with no room left.
 */
fn restore_into(family: &mut Family, value: &Value) {
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return;
    }
    if value.get("tried").and_then(Value::as_bool) == Some(true) {
        family.tried = true;
    }
    for entry in value.get("held").and_then(Value::as_array).into_iter().flatten() {
        let code: Option<Vec<String>> = entry
            .get("code")
            .and_then(Value::as_array)
            .and_then(|code| code.iter().map(|w| w.as_str().map(str::to_string)).collect());
        let version = entry.get("rosterVersion").and_then(Value::as_u64);
        let positions: Option<Vec<u32>> = entry
            .get("positions")
            .and_then(Value::as_array)
            .and_then(|list| list.iter().map(|p| p.as_u64().and_then(|p| u32::try_from(p).ok())).collect());
        let (Some(code), Some(version), Some(positions)) = (code, version, positions) else { continue };
        if !code_shape(&code)
            || !(1..=crate::signatures::MAX_SAFE_INTEGER).contains(&version)
            || positions.len() != 2
            || positions[0] >= positions[1]
            || positions[1] > 11
        {
            continue;
        }
        let key = (version, code);
        match family.issued.get_mut(&key) {
            Some(issued) if issued.held => {}
            Some(issued) => {
                issued.positions = [positions[0], positions[1]];
                issued.held = true;
            }
            None => {
                if family.make_room().is_ok() {
                    family.insert(key, [positions[0], positions[1]], true);
                }
            }
        }
    }
}

/* Tests only: called by join_check between its unlocked admission and the check under the lock. */
#[cfg(test)]
type AdmissionHook = Option<Box<dyn Fn(&AreaLedger)>>;
#[cfg(test)]
thread_local! {
    static AFTER_ADMISSION: std::cell::RefCell<AdmissionHook> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::decode;
    use crate::device_record::ServedAcceptance;
    use crate::device_record::{chain_record_seal_value, store_key};
    use crate::group_trust::{accept_rosters_joining, pin_after};
    use crate::groups::tests::{ml_dsa_keys, reader, History, Person, GROUP};
    use crate::groups::{group_public_key, group_sign, GroupPublicKey, GroupRole, MemberStatus};
    use std::sync::Arc;

    const ROOT: [u8; 32] = [9; 32];
    const CHECKED: &str = "2026-10-18T00:00:00.000Z";

    /*
     * The family person 2 joins: person 1 holds members; roster 2 lets person 2 in, roster 3
     * changes their roles, roster 4 marks them left, roster 5 lets them in again. `roles` are
     * the roles roster 2 admits them with (another admission is another code).
     */
    struct Join {
        p1: Person,
        p2: Person,
        h: History,
    }

    fn join_with(p1: &Person, p2: &Person, roles: &[GroupRole]) -> History {
        let owner = p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        let mut h = History::new();
        h.roster(p1, vec![owner.clone()], None);
        h.roster(p1, vec![owner.clone(), p2.entry(roles, 1, MemberStatus::Active)], None);
        h.roster(p1, vec![owner.clone(), p2.entry(&[GroupRole::Billing], 1, MemberStatus::Active)], None);
        h.roster(p1, vec![owner.clone(), p2.entry(&[GroupRole::Billing], 1, MemberStatus::Left)], None);
        h.roster(p1, vec![owner, p2.entry(&[], 1, MemberStatus::Active)], None);
        h
    }

    fn join() -> Join {
        let (p1, p2) = (Person::new(1), Person::new(2));
        let h = join_with(&p1, &p2, &[]);
        Join { p1, p2, h }
    }

    fn served(h: &History, people: &[&Person], through: usize) -> ServedChain {
        ServedChain {
            after: 0,
            first_keys: h.key(1),
            rosters: h.rosters[..through].to_vec(),
            successions: h.successions.clone(),
            signer_keys: ml_dsa_keys(people),
        }
    }

    /* The code the admitting admin's screen shows for roster `version`, under key `key_version`. */
    fn admin_code(h: &History, version: usize, key_version: u64) -> Vec<String> {
        join_code(roster_digest(h.rosters[version - 1].statement.clone()), h.key(key_version), key_version)
            .unwrap()
    }

    fn pin_at(h: &History, people: &[&Person], version: usize) -> GroupPin {
        let RosterChain::Accepted { chain } = accept_rosters(
            GROUP.into(),
            h.key(1),
            true,
            vec![],
            h.rosters[..version].to_vec(),
            vec![],
            ml_dsa_keys(people),
            reader(),
            None,
        )
        .unwrap() else {
            panic!("accepted")
        };
        pin_after(vec![], chain, CHECKED.into()).unwrap()
    }

    impl Join {
        fn people(&self) -> [&Person; 2] {
            [&self.p1, &self.p2]
        }

        fn served(&self, through: usize) -> ServedChain {
            served(&self.h, &self.people(), through)
        }

        fn me(&self) -> OwnIdentities {
            OwnIdentities { user_id: self.p2.user_id.clone(), identities: vec![self.p2.served_keys()] }
        }

        /* Person 2's ledger under ROOT, with settings that opened carrying `pin` (or none). */
        fn ledger(&self, pin: Option<GroupPin>) -> Arc<AreaLedger> {
            let ledger = AreaLedger::new();
            let signing = decode("k", &self.p2.keys.signing_public_key, None).unwrap();
            ledger.open_account(self.p2.user_id.clone(), signing, ROOT.to_vec()).unwrap();
            settings(&ledger, &self.p2.user_id, pin);
            ledger
        }

        fn preview(
            &self,
            ledger: &AreaLedger,
            record: Option<&str>,
            served: ServedChain,
        ) -> CoreResult<JoinPreview> {
            ledger.group_join_preview(self.me(), GROUP.into(), record.map(str::to_string), served, None)
        }

        fn accept(&self, ledger: &AreaLedger, served: ServedChain) -> ServedAcceptance {
            ledger.accept_served(self.me(), GROUP.into(), None, served, CHECKED.into()).unwrap()
        }

        /* The record person 2's device keeps after accepting the first `through` rosters (pinned at 2). */
        fn record_through(&self, through: usize) -> String {
            let ledger = self.ledger(Some(pin_at(&self.h, &self.people(), 2)));
            match self.accept(&ledger, self.served(through)) {
                ServedAcceptance::Accepted { record, .. } => record,
                other => panic!("expected an acceptance, got {other:?}"),
            }
        }
    }

    fn settings(ledger: &AreaLedger, user_id: &str, pin: Option<GroupPin>) {
        ledger
            .use_settings(
                user_id.into(),
                Some(pin.into_iter().map(|pin| (GROUP.to_string(), pin)).collect()),
                Default::default(),
            )
            .unwrap();
    }

    /* A preview's code, without its showing. */
    fn code(roster_version: u64, code: Vec<String>) -> Option<(u64, Vec<String>)> {
        Some((roster_version, code))
    }

    fn code_of(preview: &JoinPreview) -> Option<(u64, Vec<String>)> {
        match preview {
            JoinPreview::Code { roster_version, code, .. } => Some((*roster_version, code.clone())),
            _ => None,
        }
    }

    fn joining(
        h: &History,
        people: &[&Person],
        me: OwnIdentities,
        rosters: Vec<SignedGroupStatement>,
        first: GroupPublicKey,
        mark: JoinMark,
    ) -> RosterChain {
        accept_rosters_joining(
            GROUP.into(),
            first,
            true,
            vec![],
            rosters,
            h.successions.clone(),
            ml_dsa_keys(people),
            me,
            None,
            Some(mark),
        )
        .unwrap()
    }

    #[test]
    fn the_code_is_the_one_of_the_roster_that_last_let_them_in_as_the_admin_and_acceptance_work_it_out() {
        let j = join();
        let ledger = j.ledger(None);
        let at = |through| j.preview(&ledger, None, j.served(through)).unwrap();
        assert_eq!(at(1), JoinPreview::NotAdmitted);
        assert_eq!(code_of(&at(2)), code(2, admin_code(&j.h, 2, 1)));
        // The head moved on (their roles changed): still the admitting roster's code.
        assert_eq!(code_of(&at(3)), code(2, admin_code(&j.h, 2, 1)));
        // Marked left at the head: no code, whatever an earlier roster said.
        assert_eq!(at(4), JoinPreview::NotAdmitted);
        // Let in again: the roster that did it, not the first admission.
        assert_eq!(code_of(&at(5)), code(5, admin_code(&j.h, 5, 1)));
        // Acceptance works the same code out from the chain it verifies: the preview's code is a
        // join mark it takes, and the head's is not the admitting roster's.
        let JoinPreview::Code { roster_version, code, .. } = at(3) else { panic!("a code") };
        let rosters = j.h.rosters[..3].to_vec();
        assert!(matches!(
            joining(
                &j.h,
                &j.people(),
                j.me(),
                rosters.clone(),
                j.h.key(1),
                JoinMark { roster_version, code }
            ),
            RosterChain::Accepted { .. }
        ));
        let head = JoinMark { roster_version: 3, code: admin_code(&j.h, 3, 1) };
        let fork = joining(
            &j.h,
            &j.people(),
            j.me(),
            rosters.clone(),
            j.h.key(1),
            JoinMark { roster_version: 2, ..head },
        );
        assert!(matches!(fork, RosterChain::Fork { of: ForkOf::Roster, version: 2, .. }));
    }

    #[test]
    fn made_up_first_keys_or_another_admission_give_another_code_and_that_code_then_forks() {
        let j = join();
        let ledger = j.ledger(None);
        let honest = admin_code(&j.h, 2, 1);
        // The server's own version 1 keys, every roster group-signed again under them.
        let made = vec![150u8; 64];
        let remade: Vec<SignedGroupStatement> = j.h.rosters[..3]
            .iter()
            .map(|signed| SignedGroupStatement {
                signature: group_sign(made.clone(), signed.statement.clone()).unwrap(),
                ..signed.clone()
            })
            .collect();
        let madeup = ServedChain {
            first_keys: group_public_key(made.clone()).unwrap(),
            rosters: remade,
            ..j.served(3)
        };
        let JoinPreview::Code { roster_version: 2, code: shown, .. } =
            j.preview(&ledger, None, madeup).unwrap()
        else {
            panic!("a code over the made-up keys")
        };
        assert_ne!(shown, honest);
        // The code shown over them, compared with the admin's honest chain: the warning.
        let fork = joining(
            &j.h,
            &j.people(),
            j.me(),
            j.h.rosters[..3].to_vec(),
            j.h.key(1),
            JoinMark { roster_version: 2, code: shown },
        );
        assert!(matches!(fork, RosterChain::Fork { of: ForkOf::Roster, version: 2, .. }));
        // Another admission (other roles) is another roster, so another code.
        let other = join_with(&j.p1, &j.p2, &[GroupRole::Billing]);
        let JoinPreview::Code { roster_version: 2, code: theirs, .. } =
            j.preview(&ledger, None, served(&other, &j.people(), 2)).unwrap()
        else {
            panic!("a code over the other admission")
        };
        assert_eq!(theirs, admin_code(&other, 2, 1));
        assert_ne!(theirs, honest);
    }

    #[test]
    fn after_a_succession_the_code_names_the_key_the_admitting_roster_is_under() {
        let (p1, p2, p3) = (Person::new(1), Person::new(2), Person::new(3));
        let owner = p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        let mut h = History::new();
        h.roster(&p1, vec![owner.clone(), p3.entry(&[GroupRole::Members], 1, MemberStatus::Active)], None);
        h.roster(&p1, vec![owner.clone(), p3.entry(&[GroupRole::Members], 1, MemberStatus::Left)], None);
        h.succession(&p1);
        h.roster(
            &p1,
            vec![
                owner,
                p3.entry(&[GroupRole::Members], 1, MemberStatus::Left),
                p2.entry(&[], 1, MemberStatus::Active),
            ],
            Some(2),
        );
        let j = Join { p1, p2, h };
        let people = [&j.p1, &j.p2, &p3];
        let shown = j.preview(&j.ledger(None), None, served(&j.h, &people, 3)).unwrap();
        assert_eq!(code_of(&shown), code(3, admin_code(&j.h, 3, 2)));
        assert_ne!(code_of(&shown), code(3, admin_code(&j.h, 3, 1)));
    }

    #[test]
    fn the_preview_keeps_nothing_and_sets_no_fork() {
        let j = join();
        let ledger = j.ledger(None);
        assert!(matches!(j.preview(&ledger, None, j.served(3)).unwrap(), JoinPreview::Code { .. }));
        assert!(ledger.held_chain(GROUP).is_none() && !ledger.is_forked(GROUP));
        // Nothing vouches for the first keys after it: acceptance with no mark is still refused.
        assert!(ledger.accept_served(j.me(), GROUP.into(), None, j.served(3), CHECKED.into()).is_err());
        // A rejoin whose settings pin is on another history: the warning, and no fork kept.
        let other = join_with(&j.p1, &j.p2, &[GroupRole::Billing]);
        let pinned = j.ledger(Some(pin_at(&j.h, &j.people(), 2)));
        let shown = j.preview(&pinned, None, served(&other, &j.people(), 2)).unwrap();
        assert!(matches!(shown, JoinPreview::Fork { of: ForkOf::Roster, version: 2, .. }), "{shown:?}");
        assert!(pinned.held_chain(GROUP).is_none() && !pinned.is_forked(GROUP));
    }

    #[test]
    fn a_chain_or_a_fork_this_session_holds_is_a_mark_so_the_served_first_keys_are_not_taken() {
        let j = join();
        let pin = pin_at(&j.h, &j.people(), 2);
        // Committed through roster 2, then settings without the family's pin: the committed chain
        // still counts, so nothing is taken over the served first keys alone.
        let held = j.ledger(Some(pin.clone()));
        assert!(matches!(j.accept(&held, j.served(2)), ServedAcceptance::Accepted { .. }));
        settings(&held, &j.p2.user_id, None);
        assert!(j.preview(&held, None, j.served(3)).is_err());
        // The same after a fork.
        let other = join_with(&j.p1, &j.p2, &[GroupRole::Billing]);
        let forked = j.ledger(Some(pin));
        assert!(matches!(j.accept(&forked, served(&other, &j.people(), 2)), ServedAcceptance::Fork { .. }));
        settings(&forked, &j.p2.user_id, None);
        assert!(j.preview(&forked, None, j.served(3)).is_err());
        // A fresh session with no mark takes the served first keys for the code.
        assert!(matches!(j.preview(&j.ledger(None), None, j.served(3)).unwrap(), JoinPreview::Code { .. }));
    }

    #[test]
    fn the_record_s_cache_and_pin_are_marks() {
        let j = join();
        let record = j.record_through(3);
        let ledger = j.ledger(None);
        assert_eq!(
            code_of(&j.preview(&ledger, Some(&record), j.served(5)).unwrap()),
            code(5, admin_code(&j.h, 5, 1))
        );
        let other = join_with(&j.p1, &j.p2, &[GroupRole::Billing]);
        let shown = j.preview(&ledger, Some(&record), served(&other, &j.people(), 3)).unwrap();
        assert!(matches!(shown, JoinPreview::Fork { .. }), "{shown:?}");
        // The record of another account root (a master-key rotation): unreadable, even before settings.
        let rotated = AreaLedger::new();
        let signing = decode("k", &j.p2.keys.signing_public_key, None).unwrap();
        rotated.open_account(j.p2.user_id.clone(), signing, vec![8; 32]).unwrap();
        assert_eq!(j.preview(&rotated, Some(&record), j.served(5)).unwrap(), JoinPreview::RecordUnreadable);
        assert!(j.preview(&rotated, None, j.served(5)).is_err(), "settings first");
    }

    #[test]
    fn a_roster_of_the_run_the_server_left_out_is_refused_and_one_beside_the_chain_is_not_read() {
        let j = join();
        let record = j.record_through(2);
        let ledger = j.ledger(None);
        // The cache continues to roster 3, but roster 2 of the run is not served.
        let cut = ServedChain { rosters: j.h.rosters[2..3].to_vec(), ..j.served(3) };
        assert_eq!(j.preview(&ledger, Some(&record), cut), Err(input(LEFT_OUT)));
        // Another roster 2 that leaves person 2 out, served after the chain's own: a dead branch.
        let mut dead = History::new();
        let owner = j.p1.entry(&[GroupRole::Billing, GroupRole::Members], 1, MemberStatus::Active);
        dead.roster(&j.p1, vec![owner.clone()], None);
        dead.roster(&j.p1, vec![owner], None);
        let mut beside = j.served(3);
        beside.rosters.insert(2, dead.rosters[1].clone());
        assert_eq!(
            code_of(&j.preview(&j.ledger(None), None, beside).unwrap()),
            code(2, admin_code(&j.h, 2, 1))
        );
    }

    #[test]
    fn the_account_is_checked_in_the_worker_s_order() {
        let j = join();
        let ledger = j.ledger(None);
        // Another account than the one unlocked, before anything is read.
        let someone = OwnIdentities { user_id: j.p1.user_id.clone(), identities: vec![j.p1.served_keys()] };
        let refused = ledger.group_join_preview(someone, GROUP.into(), None, j.served(2), None);
        assert_eq!(refused, Err(input(NO_ACCOUNT)));
        // This account without its signing key among the identities: after the record, which
        // answers first when it does not open, and after the settings.
        let unopened = OwnIdentities { user_id: j.p2.user_id.clone(), identities: vec![j.p1.served_keys()] };
        let refused = ledger.group_join_preview(unopened.clone(), GROUP.into(), None, j.served(2), None);
        assert_eq!(refused, Err(input("Open your identity first.")));
        let foreign = chain_record_seal_value(&[8; 32], &j.p2.user_id, GROUP, &json!({ "v": 1 })).unwrap();
        let unreadable = ledger.group_join_preview(unopened, GROUP.into(), Some(foreign), j.served(2), None);
        assert_eq!(unreadable, Ok(JoinPreview::RecordUnreadable));
        assert_eq!(
            AreaLedger::new().group_join_preview(j.me(), GROUP.into(), None, j.served(2), None),
            Err(input(NO_ACCOUNT))
        );
    }

    /* A preview's showing, panicking when there is no code. */
    fn showing(j: &Join, ledger: &AreaLedger, served: ServedChain) -> Arc<JoinSession> {
        match j.preview(ledger, None, served).unwrap() {
            JoinPreview::Code { session, .. } => session,
            other => panic!("expected a code, got {other:?}"),
        }
    }

    /* The words at the session's hidden positions, as the admin reads them out. */
    fn read_out(session: &JoinSession) -> Vec<String> {
        session.hidden().iter().map(|at| session.code()[*at as usize].clone()).collect()
    }

    /* Two words of the code that are not the hidden ones (the code's own, at other positions). */
    fn misheard(session: &JoinSession) -> Vec<String> {
        let right = read_out(session);
        let other =
            |word: &String| if word == "abandon" { "ability".to_string() } else { "abandon".to_string() };
        vec![right[0].clone(), other(&right[1])]
    }

    const NOW: &str = "2026-10-18T12:00:00.000Z";

    impl Join {
        fn check(
            &self,
            ledger: &AreaLedger,
            served: ServedChain,
            session: &Arc<JoinSession>,
            typed: Vec<String>,
        ) -> CoreResult<JoinCheck> {
            ledger.join_check(
                self.me(),
                GROUP.into(),
                None,
                served,
                Arc::clone(session),
                typed,
                NOW.into(),
                None,
            )
        }

        fn matched(&self, ledger: &AreaLedger, served: ServedChain) -> Arc<JoinMatched> {
            let session = showing(self, ledger, served.clone());
            match self.check(ledger, served, &session, read_out(&session)).unwrap() {
                JoinCheck::Matched { matched, .. } => matched,
                other => panic!("expected a match, got {other:?}"),
            }
        }

        fn accept_joining(
            &self,
            ledger: &AreaLedger,
            served: ServedChain,
            matched: &Arc<JoinMatched>,
        ) -> CoreResult<JoinAcceptance> {
            ledger.accept_joining(self.me(), GROUP.into(), None, served, Arc::clone(matched))
        }
    }

    /* Person 2's ledger drawing positions from `draws`, its settings open with no pin. */
    fn drawn(j: &Join, draws: Vec<u32>) -> Arc<AreaLedger> {
        let ledger = AreaLedger::with_draws(draws);
        let signing = decode("k", &j.p2.keys.signing_public_key, None).unwrap();
        ledger.open_account(j.p2.user_id.clone(), signing, ROOT.to_vec()).unwrap();
        settings(&ledger, &j.p2.user_id, None);
        ledger
    }

    /* Person 2's ledger after a lock and an unlock: what it held in memory is gone. */
    fn relock(j: &Join, ledger: &AreaLedger) {
        ledger.clear();
        let signing = decode("k", &j.p2.keys.signing_public_key, None).unwrap();
        ledger.open_account(j.p2.user_id.clone(), signing, ROOT.to_vec()).unwrap();
        settings(ledger, &j.p2.user_id, None);
    }

    const LIMIT: u32 = u32::MAX - 3;

    #[test]
    fn positions_take_the_last_whole_run_of_twelve_and_reject_the_four_values_above_it() {
        // 2^32 - 4 is the first value past the last whole run of twelve: it and the three above it
        // are drawn again; 2^32 - 5, just below, is position 11. Then 18 is 6, 18 again is drawn
        // anew, and 16 is 4.
        assert_eq!(
            join_draw_positions(vec![LIMIT, LIMIT + 1, LIMIT + 2, u32::MAX, LIMIT - 1, 0]),
            Some(vec![0, 11])
        );
        assert_eq!(join_draw_positions(vec![18, 18, 16]), Some(vec![4, 6]));
        assert_eq!(join_draw_positions(vec![LIMIT - 1, LIMIT - 2]), Some(vec![10, 11]));
        // Draws that run out (only rejected values, or a repeat with nothing after) give no pair.
        assert_eq!(join_draw_positions(vec![LIMIT, u32::MAX]), None);
        assert_eq!(join_draw_positions(vec![5, 17]), None);
    }

    #[test]
    fn a_code_s_positions_are_drawn_once_and_another_code_draws_its_own() {
        let j = join();
        let ledger = drawn(&j, vec![LIMIT, 18, 18, 16, 1, 2]);
        let first = showing(&j, &ledger, j.served(2));
        assert_eq!(first.hidden(), vec![4, 6]);
        // Shown again and again: the same two words hidden, nothing drawn.
        for _ in 0..12 {
            assert_eq!(showing(&j, &ledger, j.served(2)).hidden(), vec![4, 6]);
        }
        // Another code (let in again at roster 5) draws the next two: 1 and 2.
        assert_eq!(showing(&j, &ledger, j.served(5)).hidden(), vec![1, 2]);
        // The system CSPRNG: positions are two ascending ones of twelve.
        let hidden = showing(&j, &j.ledger(None), j.served(2)).hidden();
        assert!(hidden[0] < hidden[1] && hidden[1] <= 11);
    }

    #[test]
    fn a_wrong_pair_holds_the_positions_and_the_family_s_second_is_the_alarm() {
        let j = join();
        let ledger = j.ledger(None);
        let first = showing(&j, &ledger, j.served(2));
        assert_eq!(j.check(&ledger, j.served(2), &first, misheard(&first)).unwrap().kind(), "wrong-words");
        // Held: every later showing of that code hides the same two words, and a session made
        // before reads them too.
        let held = first.hidden();
        for _ in 0..4 {
            assert_eq!(showing(&j, &ledger, j.served(2)).hidden(), held);
        }
        assert_eq!(j.check(&ledger, j.served(2), &first, misheard(&first)).unwrap().kind(), "mismatch");
        // The right words, any case and spacing, after all: a match.
        let typed = read_out(&first).iter().map(|w| format!(" {} ", w.to_uppercase())).collect();
        assert_eq!(j.check(&ledger, j.served(2), &first, typed).unwrap().kind(), "matched");
        // A match clears the family's wrong pair: the next wrong one is calm again.
        assert_eq!(j.check(&ledger, j.served(2), &first, misheard(&first)).unwrap().kind(), "wrong-words");
    }

    #[test]
    fn one_calm_try_per_family_another_code_after_a_wrong_pair_is_the_alarm() {
        let j = join();
        let ledger = j.ledger(None);
        let first = showing(&j, &ledger, j.served(2));
        assert_eq!(j.check(&ledger, j.served(2), &first, misheard(&first)).unwrap().kind(), "wrong-words");
        // Let in again at roster 5: another code, fresh positions, no fresh calm try.
        let other = showing(&j, &ledger, j.served(5));
        assert_eq!(j.check(&ledger, j.served(5), &other, misheard(&other)).unwrap().kind(), "mismatch");
    }

    #[test]
    fn a_code_held_before_a_match_on_another_stays_held_and_its_next_wrong_pair_is_the_alarm() {
        let j = join();
        let ledger = j.ledger(None);
        let first = showing(&j, &ledger, j.served(2));
        assert_eq!(j.check(&ledger, j.served(2), &first, misheard(&first)).unwrap().kind(), "wrong-words");
        // Another code matches, which clears the family's wrong pair but not the first code's hold.
        let other = showing(&j, &ledger, j.served(5));
        assert_eq!(j.check(&ledger, j.served(5), &other, read_out(&other)).unwrap().kind(), "matched");
        let again = showing(&j, &ledger, j.served(2));
        assert_eq!(again.hidden(), first.hidden());
        assert_eq!(j.check(&ledger, j.served(2), &again, misheard(&again)).unwrap().kind(), "mismatch");
    }

    #[test]
    fn another_code_served_is_changed_and_the_words_are_not_checked_against_the_old_one() {
        let j = join();
        let ledger = j.ledger(None);
        let first = showing(&j, &ledger, j.served(2));
        let other = join_with(&j.p1, &j.p2, &[GroupRole::Billing]);
        let JoinCheck::Changed { session } =
            j.check(&ledger, served(&other, &j.people(), 2), &first, misheard(&first)).unwrap()
        else {
            panic!("changed")
        };
        assert_eq!(session.code(), admin_code(&other, 2, 1));
        // No wrong pair counted: a miss on the new code is calm.
        let served_other = served(&other, &j.people(), 2);
        assert_eq!(
            j.check(&ledger, served_other, &session, misheard(&session)).unwrap().kind(),
            "wrong-words"
        );
    }

    #[test]
    fn typed_words_and_the_showing_are_checked_before_anything_is_verified() {
        let j = join();
        let ledger = j.ledger(None);
        let session = showing(&j, &ledger, j.served(2));
        let mut broken = j.served(2);
        broken.rosters[1].signature.ed25519 = vec![0; 64];
        for typed in [vec!["able".to_string()], vec!["able".into(), " ".into()], vec![]] {
            assert_eq!(j.check(&ledger, broken.clone(), &session, typed).unwrap().kind(), "incomplete");
        }
        // A showing of another ledger, or of this one before a lock: never this one's to check.
        let elsewhere = showing(&j, &j.ledger(None), j.served(2));
        assert_eq!(
            j.check(&ledger, j.served(2), &elsewhere, read_out(&elsewhere)).unwrap_err(),
            input(NOT_SHOWN)
        );
        ledger.clear();
        let signing = decode("k", &j.p2.keys.signing_public_key, None).unwrap();
        ledger.open_account(j.p2.user_id.clone(), signing, ROOT.to_vec()).unwrap();
        settings(&ledger, &j.p2.user_id, None);
        assert_eq!(
            j.check(&ledger, j.served(2), &session, read_out(&session)).unwrap_err(),
            input(NOT_SHOWN)
        );
    }

    #[test]
    fn a_match_keeps_its_code_in_a_joins_record_only_this_core_writes() {
        let j = join();
        let ledger = j.ledger(None);
        let matched = j.matched(&ledger, j.served(2));
        let reopened = ledger.join_matched_open(GROUP.into(), matched.record()).unwrap().unwrap();
        assert_eq!(
            (reopened.mark.clone(), reopened.checked_at.clone()),
            (matched.mark.clone(), NOW.to_string())
        );
        // A rejoin keeps the date the family was first checked: the settings pin's.
        let pin = pin_at(&j.h, &j.people(), 2);
        let pinned = j.ledger(Some(pin.clone()));
        assert_eq!(j.matched(&pinned, j.served(2)).checked_at, pin.checked_at);
        // What an app could seal as an outbox record, another family's, another account root's,
        // and an earlier version's record (the family's words compared) are no joins record.
        let value = joins_value(GROUP, &matched.mark, NOW);
        let as_outbox = ledger
            .group_device_record_seal(GROUP.into(), crate::DeviceStore::Outbox, value.to_string())
            .unwrap();
        let key = store_key(&ROOT).unwrap();
        let sealed = |user: &str, group: &str, value: &Value| {
            seal_bytes(&key, user, group, JOINS, &Zeroizing::new(value.to_string().into_bytes())).unwrap()
        };
        let older = json!({ "v": 1, "groupId": GROUP, "joinMark": null, "checkedAt": NOW });
        let mut newer = value.clone();
        newer["v"] = json!(4);
        // Version 2, which the data layer sealed before only the core and the worker did.
        let mut sealed_by_the_data_layer = value.clone();
        sealed_by_the_data_layer["v"] = json!(2);
        let mut elsewhere = value.clone();
        elsewhere["groupId"] = json!(crate::groups::tests::OTHER_GROUP);
        for record in [
            sealed(&j.p2.user_id, GROUP, &newer),
            sealed(&j.p2.user_id, GROUP, &sealed_by_the_data_layer),
            sealed(&j.p2.user_id, GROUP, &elsewhere),
            as_outbox,
            sealed(
                &j.p2.user_id,
                crate::groups::tests::OTHER_GROUP,
                &joins_value(crate::groups::tests::OTHER_GROUP, &matched.mark, NOW),
            ),
            sealed(&j.p2.user_id, GROUP, &older),
            seal_bytes(
                &store_key(&[8; 32]).unwrap(),
                &j.p2.user_id,
                GROUP,
                JOINS,
                &Zeroizing::new(value.to_string().into_bytes()),
            )
            .unwrap(),
        ] {
            assert!(ledger.join_matched_open(GROUP.into(), record).unwrap().is_none());
        }
        // The core's own sealing of the same JSON opens: the store, not the shape, is the guard.
        assert!(ledger
            .join_matched_open(GROUP.into(), sealed(&j.p2.user_id, GROUP, &value))
            .unwrap()
            .is_some());
    }

    #[test]
    fn a_match_joins_once_and_only_while_the_served_chain_gives_its_code() {
        let j = join();
        let ledger = j.ledger(None);
        let matched = j.matched(&ledger, j.served(2));
        // The member list changed meanwhile: nothing committed, and the new code to compare.
        let JoinAcceptance::Changed { session } = j.accept_joining(&ledger, j.served(5), &matched).unwrap()
        else {
            panic!("changed")
        };
        assert_eq!(session.roster_version(), 5);
        assert!(ledger.held_chain(GROUP).is_none());
        let JoinAcceptance::Accepted { chain, pin, .. } =
            j.accept_joining(&ledger, j.served(3), &matched).unwrap()
        else {
            panic!("accepted")
        };
        assert_eq!((chain.roster().roster_version, pin.checked_at.as_str()), (3, NOW));
        assert!(ledger.held_chain(GROUP).is_some());
        // Used: the token, and the same joins record reopened, are refused.
        assert_eq!(j.accept_joining(&ledger, j.served(3), &matched).unwrap_err(), input(USED));
        let reopened = ledger.join_matched_open(GROUP.into(), matched.record()).unwrap().unwrap();
        assert_eq!(j.accept_joining(&ledger, j.served(3), &reopened).unwrap_err(), input(USED));
        // A family forgotten (a join committed but not kept) may run its join again.
        ledger.forget_group(GROUP.into());
        assert!(matches!(
            j.accept_joining(&ledger, j.served(3), &reopened).unwrap(),
            JoinAcceptance::Accepted { .. }
        ));
    }

    #[test]
    fn a_match_is_this_account_s_and_this_family_s_alone() {
        let j = join();
        let ledger = j.ledger(None);
        let matched = j.matched(&ledger, j.served(2));
        let other_family = ledger.accept_joining(
            j.me(),
            crate::groups::tests::OTHER_GROUP.into(),
            None,
            j.served(2),
            Arc::clone(&matched),
        );
        assert_eq!(other_family.unwrap_err(), input(OTHER_FAMILY));
        // Another account's ledger: not this account's match.
        let theirs = AreaLedger::new();
        let signing = decode("k", &j.p1.keys.signing_public_key, None).unwrap();
        theirs.open_account(j.p1.user_id.clone(), signing, ROOT.to_vec()).unwrap();
        settings(&theirs, &j.p1.user_id, None);
        let refused = theirs.accept_joining(j.me(), GROUP.into(), None, j.served(2), Arc::clone(&matched));
        assert_eq!(refused.unwrap_err(), input(NOT_THIS_ACCOUNT));
    }

    fn kept(check: CoreResult<JoinCheck>) -> Option<String> {
        match check.unwrap() {
            JoinCheck::WrongWords { holds }
            | JoinCheck::Mismatch { holds }
            | JoinCheck::Matched { holds, .. } => holds,
            other => panic!("no escalation in {other:?}"),
        }
    }

    #[test]
    fn the_escalation_kept_survives_a_lock_and_a_relaunch_and_restoring_only_holds_more() {
        let j = join();
        let ledger = drawn(&j, vec![18, 18, 16, 1, 2, 3, 7]);
        let first = showing(&j, &ledger, j.served(2));
        let blob = kept(j.check(&ledger, j.served(2), &first, misheard(&first))).expect("held");
        // A lock (the person switched apps to ask the admin): memory gone, the showing too.
        relock(&j, &ledger);
        assert_eq!(j.check(&ledger, j.served(2), &first, read_out(&first)).unwrap_err(), input(NOT_SHOWN));
        // The kept escalation on the first preview after the unlock: the same two words, and the
        // family's wrong pair (a miss on another code, never held, is the alarm).
        let preview = |ledger: &AreaLedger, through, holds| match ledger
            .group_join_preview(j.me(), GROUP.into(), None, j.served(through), holds)
            .unwrap()
        {
            JoinPreview::Code { session, .. } => session,
            other => panic!("{other:?}"),
        };
        let again = preview(&ledger, 2, Some(blob.clone()));
        assert_eq!(again.hidden(), first.hidden());
        let other = preview(&ledger, 5, None);
        assert_eq!(j.check(&ledger, j.served(5), &other, misheard(&other)).unwrap().kind(), "mismatch");
        // The app killed and relaunched: a fresh ledger, the same blob, the same answer.
        let relaunched = drawn(&j, vec![30, 31, 32, 33]);
        let back = preview(&relaunched, 2, Some(blob.clone()));
        assert_eq!(back.hidden(), first.hidden());
        assert_eq!(j.check(&relaunched, j.served(2), &back, misheard(&back)).unwrap().kind(), "mismatch");
        // Without it, a relaunch is a new tab: other positions, and a calm first try.
        let fresh = drawn(&j, vec![30, 31]);
        let new = showing(&j, &fresh, j.served(2));
        assert_eq!(new.hidden(), vec![6, 7]);
        assert_ne!(new.hidden(), first.hidden());
        let fresh_blob = kept(j.check(&fresh, j.served(2), &new, misheard(&new))).expect("held");
        // Positions held here stay held: an older blob holding others moves nothing, and showings
        // of them stay good.
        assert_eq!(preview(&fresh, 2, Some(blob.clone())).hidden(), new.hidden());
        assert_eq!(j.check(&fresh, j.served(2), &new, misheard(&new)).unwrap().kind(), "mismatch");
        // Another family's blob, or none of this account's, is refused as sealed with the one message.
        let refused = fresh.group_join_preview(
            j.me(),
            crate::groups::tests::OTHER_GROUP.into(),
            None,
            j.served(2),
            Some(fresh_blob),
        );
        assert_eq!(refused, Err(CoreError::Sealed(HOLDS_UNREADABLE.into())));
    }

    #[test]
    fn a_restored_roster_version_is_one_javascript_holds_exactly_and_a_bad_entry_keeps_the_wrong_pair() {
        let code: Vec<String> =
            "abandon ability able about above absent absorb abstract absurd abuse access accident"
                .split(' ')
                .map(str::to_string)
                .collect();
        let kept = |version: Value| json!({ "v": 1, "tried": true, "held": [{ "rosterVersion": version, "code": code, "positions": [3, 8] }] });
        for version in [json!(0), json!(-1), json!(1.5), json!(1u64 << 53), json!(u64::MAX)] {
            let mut family = Family::default();
            restore_into(&mut family, &kept(version.clone()));
            assert!(family.issued.is_empty(), "{version}");
            // The family's wrong pair still counts: a damaged entry does not reset the alarm.
            assert!(family.tried, "{version}");
        }
        for version in [1, crate::signatures::MAX_SAFE_INTEGER] {
            let mut family = Family::default();
            restore_into(&mut family, &kept(json!(version)));
            assert_eq!(
                family.issued.get(&(version, code.clone())).map(|i| (i.positions, i.held)),
                Some(([3, 8], true))
            );
        }
    }

    #[test]
    fn a_lock_or_a_restore_while_the_chain_is_verified_leaves_a_showing_this_unlock_does_not_hold() {
        let j = Arc::new(join());
        let set = |hook: AdmissionHook| AFTER_ADMISSION.with(|cell| *cell.borrow_mut() = hook);
        // A lock and an unlock while the chain is verified, and the kept escalation restored at once:
        // the same code at the same positions again, but in another unlock.
        let ledger = drawn(&j, vec![18, 18, 16, 18, 18, 16]);
        let first = showing(&j, &ledger, j.served(2));
        let blob = kept(j.check(&ledger, j.served(2), &first, misheard(&first))).unwrap();
        let (jj, blob_again) = (Arc::clone(&j), blob.clone());
        set(Some(Box::new(move |ledger: &AreaLedger| {
            relock(&jj, ledger);
            let restored = ledger.group_join_preview(
                jj.me(),
                GROUP.into(),
                None,
                jj.served(2),
                Some(blob_again.clone()),
            );
            assert!(matches!(restored, Ok(JoinPreview::Code { .. })));
        })));
        let raced = j.check(&ledger, j.served(2), &first, read_out(&first));
        set(None);
        assert_eq!(raced.unwrap_err(), input(NOT_SHOWN));
        // A restore in the same unlock that replaced the positions on screen (not held here).
        let a = drawn(&j, vec![18, 18, 16]);
        let held_there = showing(&j, &a, j.served(2));
        let other = kept(j.check(&a, j.served(2), &held_there, misheard(&held_there))).unwrap();
        let b = drawn(&j, vec![30, 31]);
        let shown_here = showing(&j, &b, j.served(2));
        let jj = Arc::clone(&j);
        set(Some(Box::new(move |ledger: &AreaLedger| {
            let restored =
                ledger.group_join_preview(jj.me(), GROUP.into(), None, jj.served(2), Some(other.clone()));
            assert!(matches!(restored, Ok(JoinPreview::Code { .. })));
        })));
        let raced = j.check(&b, j.served(2), &shown_here, read_out(&shown_here));
        set(None);
        assert_eq!(raced.unwrap_err(), input(NOT_SHOWN));
        // Break-check: with no hook the same showing is checked.
        let c = drawn(&j, vec![30, 31]);
        let shown = showing(&j, &c, j.served(2));
        assert_eq!(j.check(&c, j.served(2), &shown, read_out(&shown)).unwrap().kind(), "matched");
    }

    #[test]
    fn a_showing_whose_positions_a_restored_escalation_replaced_is_refused() {
        let j = join();
        // Ledger A holds code 2 at [4, 6] after a wrong pair; ledger B has shown code 2 at [6, 7].
        let a = drawn(&j, vec![18, 18, 16]);
        let held_there = showing(&j, &a, j.served(2));
        let blob = kept(j.check(&a, j.served(2), &held_there, misheard(&held_there))).unwrap();
        let b = drawn(&j, vec![30, 31]);
        let shown_here = showing(&j, &b, j.served(2));
        assert_eq!(shown_here.hidden(), vec![6, 7]);
        // B restores A's escalation: code 2 was not held on B, so it takes the kept positions.
        let restored = b.group_join_preview(j.me(), GROUP.into(), None, j.served(2), Some(blob)).unwrap();
        let JoinPreview::Code { session, .. } = restored else { panic!("code") };
        assert_eq!(session.hidden(), vec![4, 6]);
        assert_eq!(
            j.check(&b, j.served(2), &shown_here, read_out(&shown_here)).unwrap_err(),
            input(NOT_SHOWN)
        );
        assert_eq!(j.check(&b, j.served(2), &session, misheard(&session)).unwrap().kind(), "mismatch");
    }

    #[test]
    fn a_match_clears_its_code_and_hands_back_only_what_is_still_held() {
        let j = join();
        let ledger = drawn(&j, vec![18, 18, 16, 1, 2]);
        let first = showing(&j, &ledger, j.served(2));
        assert!(kept(j.check(&ledger, j.served(2), &first, misheard(&first))).is_some());
        // A match on the same code: nothing held, nothing to keep.
        assert_eq!(kept(j.check(&ledger, j.served(2), &first, read_out(&first))), None);
        // A miss on code 2, then a match on code 5: code 2 stays held, and is all that is kept.
        let ledger = drawn(&j, vec![18, 18, 16, 1, 2]);
        let first = showing(&j, &ledger, j.served(2));
        kept(j.check(&ledger, j.served(2), &first, misheard(&first)));
        let other = showing(&j, &ledger, j.served(5));
        let left = kept(j.check(&ledger, j.served(5), &other, read_out(&other))).expect("code 2 still held");
        let value =
            crate::device_record::device_store_open_value(&ROOT, &j.p2.user_id, GROUP, HOLDS, &left).unwrap();
        assert_eq!(value["tried"], json!(false));
        assert_eq!(value["held"].as_array().unwrap().len(), 1);
        assert_eq!(value["held"][0]["rosterVersion"], json!(2));
    }

    #[test]
    fn a_family_keeps_at_most_sixty_four_codes_and_never_drops_a_held_one() {
        let mut family = Family::default();
        let code = |n: u64| (n, vec!["abandon".to_string(); 12]);
        for n in 1..=MAX_SHOWN_CODES as u64 {
            family.make_room().unwrap();
            family.insert(code(n), [0, 1], n % 2 == 0);
        }
        // Full: the earliest code no wrong pair holds goes (code 1), never a held one.
        family.make_room().unwrap();
        assert!(!family.issued.contains_key(&code(1)) && family.issued.contains_key(&code(2)));
        assert_eq!(family.issued.len(), MAX_SHOWN_CODES - 1);
        // All held: no room, and nothing goes.
        let mut held = Family::default();
        for n in 1..=MAX_SHOWN_CODES as u64 {
            held.insert(code(n), [0, 1], true);
        }
        assert_eq!(held.make_room(), Err(input(TOO_MANY)));
        assert_eq!(held.issued.len(), MAX_SHOWN_CODES);
    }

    #[test]
    fn another_code_at_the_roster_compared_is_the_fork_and_a_later_readmission_a_new_code() {
        let j = join();
        let ledger = j.ledger(None);
        let matched = j.matched(&ledger, j.served(2));
        // The server now serves another admission at roster 2: the person's compared code does not
        // hold there, the hard warning, never a fresh code to compare.
        let other = join_with(&j.p1, &j.p2, &[GroupRole::Billing]);
        let forked = j.accept_joining(&ledger, served(&other, &j.people(), 3), &matched).unwrap();
        assert!(matches!(forked, JoinAcceptance::Fork { of: ForkOf::Roster, version: 2, .. }), "{forked:?}");
        assert!(ledger.held_chain(GROUP).is_none());
        // The fork stays this session's mark. On another device, let in again at roster 5 on the same
        // history: roster 2's code still holds there, so compare the new one.
        let ledger = j.ledger(None);
        let matched = j.matched(&ledger, j.served(2));
        let JoinAcceptance::Changed { session } = j.accept_joining(&ledger, j.served(5), &matched).unwrap()
        else {
            panic!("changed")
        };
        assert_eq!(session.roster_version(), 5);
    }

    #[test]
    fn a_match_from_before_a_lock_is_reopened_from_its_record_not_called_another_account_s() {
        let j = join();
        let ledger = j.ledger(None);
        let matched = j.matched(&ledger, j.served(2));
        relock(&j, &ledger);
        assert_eq!(j.accept_joining(&ledger, j.served(3), &matched).unwrap_err(), input(STALE_MATCH));
        let reopened = ledger.join_matched_open(GROUP.into(), matched.record()).unwrap().unwrap();
        assert!(matches!(
            j.accept_joining(&ledger, j.served(3), &reopened).unwrap(),
            JoinAcceptance::Accepted { .. }
        ));
    }

    impl JoinCheck {
        fn kind(&self) -> &'static str {
            match self {
                JoinCheck::Matched { .. } => "matched",
                JoinCheck::WrongWords { .. } => "wrong-words",
                JoinCheck::Mismatch { .. } => "mismatch",
                JoinCheck::Incomplete => "incomplete",
                JoinCheck::Changed { .. } => "changed",
                JoinCheck::NotAdmitted => "not-admitted",
                JoinCheck::Fork { .. } => "fork",
                JoinCheck::RecordUnreadable => "record-unreadable",
            }
        }
    }

    fn words(text: &str) -> Vec<String> {
        text.split(' ').map(String::from).collect()
    }

    const CODE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident";

    #[test]
    fn two_words_match_only_at_the_hidden_positions_in_their_order() {
        let check = |hidden: Vec<u32>, typed: &[&str]| {
            join_words(words(CODE), hidden, typed.iter().map(|w| w.to_string()).collect()).unwrap()
        };
        assert_eq!(check(vec![0, 11], &["abandon", "accident"]), JoinWords::Match);
        assert_eq!(check(vec![0, 11], &["accident", "abandon"]), JoinWords::NoMatch);
        assert_eq!(check(vec![0, 11], &["abandon", "access"]), JoinWords::NoMatch);
        assert_eq!(check(vec![5, 6], &["ABSENT", "Absorb"]), JoinWords::Match);
        assert_eq!(check(vec![5, 6], &["absent"]), JoinWords::Incomplete);
        assert_eq!(check(vec![5, 6], &["absent", "absorb", "abstract"]), JoinWords::Incomplete);
        assert_eq!(check(vec![5, 6], &["\t\n", "absorb"]), JoinWords::Incomplete);
    }

    #[test]
    fn typed_words_are_trimmed_as_javascript_trims_them() {
        let check =
            |typed: &str| join_words(words(CODE), vec![1, 2], vec![typed.into(), "able".into()]).unwrap();
        // JavaScript's trim takes the byte order mark and Unicode spaces, never U+0085.
        assert_eq!(check("\u{FEFF}ability\u{3000}"), JoinWords::Match);
        assert_eq!(check("\u{2028} ability\u{A0}"), JoinWords::Match);
        assert_eq!(check("ability\u{85}"), JoinWords::NoMatch);
        assert_eq!(check("abi lity"), JoinWords::NoMatch);
    }

    #[test]
    fn positions_and_codes_never_issued_are_refused() {
        let typed = || vec!["able".to_string(), "about".to_string()];
        for hidden in [vec![4, 4], vec![5, 2], vec![3, 12], vec![1], vec![1, 2, 3], vec![]] {
            assert_eq!(
                join_words(words(CODE), hidden.clone(), typed()),
                Err(input(BAD_HIDDEN)),
                "{hidden:?}"
            );
        }
        let mut short = words(CODE);
        short.pop();
        let mut upper = words(CODE);
        upper[0] = "Abandon".into();
        let mut long = words(CODE);
        long[0] = "abandoned".into();
        for code in [short, upper, long] {
            assert_eq!(join_words(code, vec![2, 3], typed()), Err(input(BAD_CODE)));
        }
    }
}
