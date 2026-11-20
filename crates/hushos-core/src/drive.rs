//! Drive: grants, nodes, metadata and version envelopes, content chunks, shares, links, reports and folder colours.

pub(crate) mod colour;
// `drive::drive` on purpose: the group is named after the module it grew from.
#[allow(clippy::module_inception)]
pub(crate) mod drive;
pub(crate) mod links;
pub(crate) mod reports;
pub(crate) mod shares;
