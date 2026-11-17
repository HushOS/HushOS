/*
 * What the page and a tools worker say to each other (docs/file-tools-design.md, section 2,
 * "Workers"). A tools worker holds no keys: it asks the page for byte ranges of its sources
 * over one MessagePort each, and hands back what it produces, one result at a time, each
 * transferred, never copied. Shared by the page side (run.ts) and the worker side (worker.ts),
 * so it imports nothing.
 */

/* Produced plaintext a run may hold waiting for upload before producing pauses (section 3, "Memory"). */
export const TOOL_BUDGET_BYTES = 512 * 1024 * 1024;
/* A worker that reports no progress this long, not counting waits on the page, is stopped. */
export const TOOL_WATCHDOG_MS = 30_000;
/* What a run that hung, crashed or met something it could not read tells the person. */
export const TOOL_FAILED = "This file couldn't be processed.";
/* The longest range one read may ask for: the zip listing's cap on a central directory. */
export const RANGE_READ_MAX = 64 * 1024 * 1024;

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
    | { type: 'output'; id: number; name: string; mime: string | null; bytes: ArrayBuffer }
    | { type: 'done'; result: unknown }
    /* `message` is the person's words for a refusal the tool understood; anything else is TOOL_FAILED. */
    | { type: 'fail'; message: string };

/* Over a source's port. */
export type RangeRequest = { type: 'read'; id: number; offset: number; length: number };
export type RangeAnswer =
    | { type: 'data'; id: number; bytes: ArrayBuffer }
    | { type: 'fail'; id: number; message: string };
