/*
 * The most Markdown the renderer takes, in UTF-8 bytes. A module of its own, with no imports, so the
 * text editor can ask it without loading the parser (remark, rehype, unified) for every file.
 */
export const MARKDOWN_LIMIT = 2 * 1024 * 1024;
