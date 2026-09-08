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

- Add tests only when the user explicitly requests them. Otherwise validate with the existing lint, formatting, typecheck, and build commands plus focused manual smoke checks.
- Use four spaces for indentation. Oxfmt owns formatting; Oxlint owns linting.
- Keep the structure simple: web pages and layouts use TanStack directory routes (`app/route.tsx`, `app/index.tsx`), reusable UI in `components/`, and shared helpers in `lib/`. Extract modules when reuse or complexity warrants it.
- Keep Elysia API handlers together in `apps/web/src/lib/api.server.ts`; `apps/web/src/routes/api/$.ts` mounts them at `/api`. Nitro owns the HTTP server and request logging.
- Use `@/*` within the web app and `@hushos/*` package exports between workspaces.
- Use shadcn's Base UI components and Fontsource Variable Geist Sans/Mono. Keep Tailwind configuration in the web app.
- HushOS is an open-source, self-hostable E2EE productivity suite, beginning with Drive. Encryption, key management, and storage protocols are not implemented by this scaffold; preserve that distinction in product claims.
- Keep secrets and database access in server-only code. Use `import type` for API contracts and `createIsomorphicFn` for distinct server/client implementations; server runtime imports must be eliminated from browser builds.
- Read `README.md` and `CONTRIBUTING.md` for local setup; read `docs/self-hosting.md` before changing Docker, environment variables, or database deployment.
