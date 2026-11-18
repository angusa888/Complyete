# Complyete

Complyete is an internal ESE staff workspace for clients, property projects, call history, project tasks, private documents, and permit/final sign-off reminders. It has no client or permitting-board login.

## V1 scope

- Email/password Supabase Auth for active staff; staff access is provisioned administratively.
- Client records with archive/restore and linked project/call history.
- Multiple property projects per client, multiple staff assignments, append-only call follow-ups, and reusable task/group presets with copied intake snapshots.
- Project tasks, private versioned documents, signed-document verification, and completion checks.
- Multiple permit and final sign-off deadlines with preview-first email reminders. Demo delivery redirects to `revisa@rpi.edu`; live delivery requires explicit configuration.
- Import of the supplied project-tracker workbook while retaining each source row and review flags. Do not create synthetic records to demonstrate the tracker workflow.

The application is Next.js with Supabase Auth, PostgreSQL and private Storage. **Cloudflare Workers is the required application host.** The repository uses Vinext/Vite for the Worker build. Reminder scheduling is separate: Supabase Cron invokes a Supabase Edge Function, which uses Resend.

## Start locally

1. Install Node.js 22 and npm. Copy `.env.example` to `.env.local` and fill in the Supabase URL, publishable key, and local application URL. Never put a service-role key in `.env.local` or browser-facing configuration.
2. Install dependencies with `npm ci`.
3. Apply the Supabase migrations and provision an Auth user plus its active `public.staff` row. See [setup](docs/setup.md).
4. Run `npm run dev` and open `http://localhost:3000`.

## Documentation

- [Setup, Supabase, Cloudflare, Resend and tracker import](docs/setup.md)
- [Architecture and security boundaries](docs/architecture.md)
- [Prototype walkthrough and reminder preview](docs/demo.md)
- [Project-scoped Codex MCP and plugin guidance](docs/mcp.md)
- [Database, RPC and import contract](docs/schema-contract.md)

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run test:database
npm run build
npm run check:worker
npm run build:worker
```

These local checks do not verify live Supabase policies, Cloudflare account access, the Resend sender domain, or production delivery. Use [setup](docs/setup.md) for the deployment gates. Do not commit tracker files, generated import payloads, `.env.local`, or credentials.
