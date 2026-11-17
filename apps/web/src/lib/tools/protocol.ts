/*
 * What the page and a tools worker say to each other (docs/file-tools-design.md, section 2,
 * "Workers"). A tools worker holds no keys: it asks the page for byte ranges of its sources
 * over one MessagePort each, and hands back what it produces, one result at a time, each
 * transferred, never copied. Shared by the page side (run.ts) and the worker side (worker.ts),
 * so it imports nothing.
 *
 * The page does not trust the worker to keep to any of this: the worker parses files anyone
 * could have uploaded, and a parser bug could hand it to them. Every limit here is enforced
 * by the page, and a worker that breaks one fails its run.
 */

/* Produced plaintext waiting for upload, across every run of the tab, before producing pauses (section 3, "Memory"). */
export const TOOL_BUDGET_BYTES = 512 * 1024 * 1024;
/* A worker that reports no progress this long, not counting waits on the page, is stopped. */
export const TOOL_WATCHDOG_MS = 30_000;
/* How often the watchdog's clock is brought up to date, and the most one tick may add: a tab the browser froze for a minute adds two seconds, not the minute the worker never had. */
export const WATCHDOG_TICK_MS = 1_000;
export const WATCHDOG_TICK_CAP_MS = 2_000;
/* What a run that hung, crashed or met something it could not read tells the person. */
export const TOOL_FAILED = "This file couldn't be processed.";
/* The longest range one read may ask for (the zip listing's cap on a central directory), and the most a run may have asked for and not yet received, in reads and in bytes. */
export const RANGE_READ_MAX = 64 * 1024 * 1024;
export const READS_IN_FLIGHT = 2;
/* The largest result a worker may hand back: what can be held as one in-memory upload (section 3). */
export const RESULT_MAX_BYTES = 256 * 1024 * 1024;

/* From the page, on the worker itself. */
export type ToWorker =
    | {
          type: 'start';
          input: unknown;
          /* One per source file, in order: its size, and the port its ranges are read over. */
          sources: { size: number; port: MessagePort }[];
      }
    /* The output `id` was taken and the budget has room: the worker may produce the next. */
    | { type: 'accepted'; id: number };

/* From the worker, on the worker itself. */
export type ToPage =
    | { type: 'progress'; done: number; total: number | null }
    /* Ids count from 0, one at a time: the next only once the page accepted this one. */
    | { type: 'output'; id: number; name: string; mime: string | null; bytes: ArrayBuffer }
    | { type: 'done'; result: unknown }
    /* `code` names a refusal the tool understood; the page turns it into words, or TOOL_FAILED. Never text for the person. */
    | { type: 'fail'; code: string | null };

/* Over a source's port. */
export type RangeRequest = { type: 'read'; id: number; offset: number; length: number };
export type RangeAnswer =
    | { type: 'data'; id: number; bytes: ArrayBuffer }
    | { type: 'fail'; id: number; message: string };
