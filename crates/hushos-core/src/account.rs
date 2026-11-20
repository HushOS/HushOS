//! The account and its devices: OPAQUE, signup, the account key, identities, recovery, two-step sign-in, device keys and records, drafts and notifications.

// `account::account` on purpose: the group is named after the module it grew from.
#[allow(clippy::module_inception)]
pub(crate) mod account;
pub(crate) mod consent;
pub(crate) mod device_approval;
pub(crate) mod device_record;
pub(crate) mod devices;
pub(crate) mod drafts;
pub(crate) mod identity;
pub(crate) mod notifications;
pub(crate) mod opaque;
pub(crate) mod recovery;
pub(crate) mod signup;
pub(crate) mod two_step;
