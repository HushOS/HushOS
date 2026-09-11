<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `bunx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `bunx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

# HushOS development

- Tests are required for code that handles money, keys, or quota: billing, crypto, and transactional repository functions get Vitest suites beside them (see CONTRIBUTING.md). Elsewhere, validate with the lint, formatting, typecheck, and build commands plus focused manual smoke checks. Where a test would be appropriate, say where and why and ask whether to add it; do not add it unasked.
- No tautological tests. Every test must fail on a defect a user, operator, or attacker would notice: boundaries, state transitions, wrong keys, tampered inputs, replays, stale preconditions. Never assert that a mock returned what it was told to return.
- Never commit or push unless the user says so in the current request. Finish the work, report it, and leave it in the working tree.
- Be direct and critical. Name a weakness first and specifically (what, where, what it costs), then the fix. Do not soften assessments, lead with praise, or let impatience or a half-finished feature pass without saying so.
- Use four spaces for indentation. Oxfmt owns formatting; Oxlint owns linting.
- Keep the structure simple: web pages and layouts use TanStack directory routes (`app/route.tsx`, `app/index.tsx`), reusable UI in `components/`, and shared helpers in `lib/`. Extract modules when reuse or complexity warrants it.
- Keep Elysia API handlers together in `apps/web/src/lib/api.server.ts`; `apps/web/src/routes/api/$.ts` mounts them at `/api`. Nitro owns the HTTP server and request logging.
- Use `@/*` within the web app and `@hushos/*` package exports between workspaces.
- Use shadcn's Base UI components and Fontsource Variable Geist Sans/Mono. Keep Tailwind configuration in the web app.
- HushOS is an open-source, self-hostable E2EE productivity suite, beginning with Drive. Encryption, key management, and storage protocols are not implemented by this scaffold; preserve that distinction in product claims.
- Keep secrets and database access in server-only code. Use `import type` for API contracts and `createIsomorphicFn` for distinct server/client implementations; server runtime imports must be eliminated from browser builds.
- Read `README.md` and `CONTRIBUTING.md` for local setup; read `docs/self-hosting.md` before changing Docker, environment variables, or database deployment.
