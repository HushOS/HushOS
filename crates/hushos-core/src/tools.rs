//! File tools: zip archives, images to PDF, PDF pages, text editing, and the decrypting reader and run control they share.

pub(crate) mod archive;
pub(crate) mod images_pdf;
pub(crate) mod pdf_tools;
pub(crate) mod text_edit;
// `tools::tools` on purpose: the group is named after the module it grew from.
#[allow(clippy::module_inception)]
pub(crate) mod tools;
