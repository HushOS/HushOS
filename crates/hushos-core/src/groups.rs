//! Groups: the group core, area ledgers and grants, joins, roster calls, rotations and successions.

pub(crate) mod area_ledger;
pub(crate) mod area_open;
pub(crate) mod group_trust;
pub(crate) mod group_verdicts;
// `groups::groups` on purpose: the group is named after the module it grew from.
#[allow(clippy::module_inception)]
pub(crate) mod groups;
pub(crate) mod join;
pub(crate) mod ledger_settings;
pub(crate) mod roster_calls;
pub(crate) mod rotation_records;
pub(crate) mod succession_path;
