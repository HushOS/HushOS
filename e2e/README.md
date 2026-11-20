# Browser tests

How to run them is in [CONTRIBUTING.md](../CONTRIBUTING.md#browser-tests). This file is about writing them so they pass on CI, not only on your machine.

## Writing e2e for CI

CI runs each spec on a two-worker shard of a slow runner, against the production build, with every other spec of the shard beside it. A test that passes locally can fail there for reasons that have nothing to do with the app. Each rule below comes from a flake that reached `main`.

### Run against the production build

- CI tests `bun run build` served by `bun run start`, not the dev server: chunk names (`/assets/rust-<hash>.js`, not `/src/...`), the production Content Security Policy, and no first-visit compile.
- Before pushing a new or changed spec, build and run it against a server of your own (`E2E_BASE_URL`, `E2E_DATABASE_URL`; see CONTRIBUTING.md, "Test a server of your own").
- Match modules with `appModule()` from `helpers.ts`, which matches both the source path and the built chunk.

### WebKit

- **Backspace goes back.** Playwright's WebKit goes back a page on a Backspace the page doesn't handle. Safari doesn't. Press it only where an editable element has the focus, or leave the step out on WebKit (`images-pdf.spec.ts`).
- **Reloads bypass `page.route` for cached modules.** After a reload, WebKit serves an immutable module it already holds from its memory cache, with no request for `page.route` to see. A route meant to hold or fail a module must be in place before the page first loads it, or the module must reach the browser with `Cache-Control: no-store` until the route is armed (`editing-preview.spec.ts`, the grammar test).
- **Workers can start with no request.** WebKit can start a worker from its cache without a request event, and labels worker scripts `xhr`, not `script`. To record what a page loads, use `scriptsDuring()` from `helpers.ts`, which listens to `page.on('worker')` as well as requests.
- **A slow press reads as a held one.** Playwright releases a click only once the page has handled the press. When the page takes more than 500 ms over a right-click, WebKit runs Base UI's long-press timer first and the context menu closes as it opens. Right-click with `rightClick()` from `helpers.ts`, which presses again when the page saw a hold.

### Timing

- **Never assert pixel-exact boundaries.** Linux CI renders fonts with different metrics from macOS. Assert an order, a range or a tolerance (`editing-preview.spec.ts` counts a block within 2 px of the top as on the boundary).
- **Order steps so timing can't matter.** CI runners are several times slower than a laptop. A window that is seconds long locally can close on CI before the next step runs: an editor's draft is kept two seconds after typing, so a second tab opened after the first one typed was offered that draft on CI. Open both before either types, wait for what the app shows rather than for a duration, and never rely on a step being fast.
- **Let closing UI finish.** A menu or dialog that is animating out can still take the next key. Wait until it is gone (`toHaveCount(0)`) before a step that presses Escape or types.

### Switches

- **Skip on a server switch at run time.** Playwright's runner loads spec files without `.env`, and its workers with it. A describe-level `test.skip(process.env.X ...)` is decided by both, so a switch set only in `.env` (as CI sets `GROUPS_ENABLED`) reads differently in each, and a block can be skipped everywhere. Decide in a `beforeEach` or `beforeAll` (`two-step.spec.ts`, the `families off` block).

### Shared state

- **Every test owns its data.** Specs run in parallel against one database and one bucket. Make your own account (`registerAccount()`), and scope every database query to that account's own rows. Never count or delete across all users.
- **A file is a unit of scheduling.** A spec file runs on one worker, and a serial file's tests one after another. Keep a file under about three minutes on WebKit: split a long one by area, each part with its own setup through shared helpers (`editing.ts` for the editing specs). A file in `mode: 'parallel'` with `test.describe.serial` blocks (`families.spec.ts`) has each block scheduled on its own.

### Shards

- CI splits each suite into shards by measured time: `scripts/e2e-shard.ts` reads `durations.json`.
- A new spec file is counted at 60 seconds until its time is measured.
- Two heavy files on one WebKit shard (several people, sign-ups and key changes at once) starve each other on the three-core macOS runner: `integrity.spec.ts` beside `editing-preview.spec.ts` ran two and a half times as long as either alone. The times measured beside each other keep them apart; if a refresh puts two such files together, look at that shard first.
- After adding or splitting a spec, refresh `durations.json` with `scripts/e2e-durations.ts`, from the logs of a CI run of the new tree. Its header says how.
