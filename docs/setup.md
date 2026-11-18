# Setup and deployment

This guide keeps provider values as placeholders. The ESE Cloudflare account and Resend sender domain must be established before production deployment or real email delivery. Never commit the values entered in these steps.

## Prerequisites

- Node.js 22, npm, Git, and the repository.
- A Supabase project with an administrator able to apply migrations and provision staff.
- Access to the ESE Cloudflare account and the `admin.ese-llc.com` domain for Worker deployment.
- A Resend account with a verified sender domain before demo or live delivery.
- The approved project-tracker workbook available locally. Keep it outside Git.

## Local application configuration

```powershell
Copy-Item .env.example .env.local
```

Set these values in `.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<Supabase publishable key>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

The Supabase publishable key (or legacy anon key) is intended for the browser; never use a secret/service-role key here. `.env.local` is ignored by Git. Install and run:

```powershell
npm ci
npm run dev
```

## Supabase database and staff access

1. Create/select the ESE Supabase project and copy its project reference, URL, and publishable key. No credentials are stored in this repository.
2. Link the CLI to the intended project, review the migrations, then apply them in order:

   ```sh
   npx supabase login
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase db push
   ```

   The migrations create the domain tables, staff-only RLS and Storage policies, workflow RPCs, reminder ledger, and private `project-documents` bucket. Do not use the local PGlite harness as proof that remote policies or a remote deployment work.
3. In Supabase Auth, disable public signup, configure the canonical Site URL, and allow the production, temporary `workers.dev`, and local callback URLs. Include `/auth/confirm` for account recovery and email changes. Configure the Auth email templates to route token hashes through `/auth/confirm`.
4. Create each staff login in Supabase Auth. Add its matching `public.staff` record with the Auth user UUID, display name, email, and `is_active = true`. There is no public registration or automatic staff-activation trigger. A signed-in Auth user without an active matching row cannot use the application. Staff can change their password and request an email change; the directory email remains administrator-managed.
5. Use only the `public.staff` accounts that should receive reminders. Reminder recipient choices are restricted to active staff with an email address.

An administrator may insert a staff record in the Supabase SQL editor after creating its Auth user. Replace all sample values first; never publish real staff data:

```sql
insert into public.staff (auth_user_id, display_name, email, is_active)
values ('<AUTH_USER_UUID>', '<STAFF_DISPLAY_NAME>', '<STAFF_EMAIL>', true);
```

## Import the actual tracker

The first populated demonstration should use the approved workbook, not synthetic/manual project records. The importer preserves 557 distinct source projects from three sheets, including repeated project numbers, original cell values, source row identity, malformed-date flags, and unverified historical completion claims. It groups clients only by exact trimmed source labels; it does not invent deadlines or send reminders.

From the repository root, run the bundled Python with `openpyxl` available, and replace the placeholder with the locally held workbook path:

```sh
python scripts/prepare_import.py "<PATH_TO_APPROVED_TRACKER.xlsx>" --output .env.import-tracker.local
node scripts/import_tracker.mjs .env.import-tracker.local
```

The second command is a **dry run** and reports row counts and validation flags. The payload is a Git-ignored `.env*` file and contains client information; keep it private. Review the dry-run summary and confirm the target Supabase project before an administrator runs the import. For an authorized import, provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in the local process environment and add `--apply`:

```sh
node scripts/import_tracker.mjs .env.import-tracker.local --apply
```

The service-role key is privileged: never pass it to the browser, Worker, source control, or a shared terminal log. The importer is idempotent for a workbook checksum and source sheet/row. See [the import contract](schema-contract.md#import) before running it. Do not replace the approved workbook with generated example data.

## Cloudflare Workers deployment

Cloudflare is the required web host. The Worker build uses Vinext; a conventional Next.js build alone is not a Cloudflare deployment check.

1. Sign in to the ESE Cloudflare account and verify the account owns or can bind `admin.ese-llc.com`. Keep any account IDs and tokens out of Git.
2. Set the application’s build/runtime values in the Cloudflare Worker configuration or deployment environment:

   ```text
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
   NEXT_PUBLIC_APP_URL=https://admin.ese-llc.com
   ```

   Use Cloudflare’s secret store for any sensitive credential. The browser publishable key is not a service-role key. Build output and environment behavior must be checked against the configured Vinext release before deployment.
3. Run the Worker compatibility checks, then sign in and deploy:

   ```sh
   npm run check:worker
   npm run build:worker
   npm run preview:worker
   npx wrangler login
   npx wrangler whoami
   npm run deploy:vinext
   ```

4. Initially use the assigned `workers.dev` hostname for a controlled smoke test. Bind `admin.ese-llc.com` in the authorized Cloudflare account only after the target account and environment variables have been confirmed. Add the production origin to Supabase Auth redirect allowlists.

This repository does not contain Cloudflare account access or deployment secrets. Do not mark deployment complete until the deployed Worker is reachable, authentication succeeds, and private project/document access is verified with an active staff account.

## Reminder provider configuration

Reminder processing uses a Supabase Edge Function and Supabase Cron, independently of where the web app runs. Its handler defaults to `preview`; preview never enqueues, claims, or sends. Demo mode redirects notices to `revisa@rpi.edu`. Live mode sends only to configured active staff recipients. Either sending mode also requires explicit delivery enablement.

After the Resend account and verified sender domain exist, configure these Edge Function secrets in Supabase (values are intentionally placeholders here):

```text
SUPABASE_URL=<Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<server-only service-role key>
REMINDER_CRON_SECRET=<long random bearer secret>
REMINDER_MODE=preview
REMINDER_DELIVERY_ENABLED=false
RESEND_API_KEY=<Resend API key>
REMINDER_FROM=<verified sender name and email>
APP_URL=https://admin.ese-llc.com
```

Deploy the `dispatch-reminders` Edge Function using the project’s Supabase CLI, then configure a disabled-by-default five-minute Cron invocation that sends the `REMINDER_CRON_SECRET` as a Bearer authorization value. Keep the secret in Supabase Vault/Cron secret storage; do not hard-code it in SQL, a checked-in script, or the Worker. Validate preview first. For the requested demonstration, set `REMINDER_MODE=demo` and `REMINDER_DELIVERY_ENABLED=true` only after confirming the sender, recipient redirect, and Resend account; demo sends to `revisa@rpi.edu`. Change to `live` only after staff recipients are reviewed and an administrator intentionally approves real delivery. Leave Cron disabled until that review is complete.

Notice defaults are 30, 14, and 3 days before each deadline and daily at 9 a.m. America/New_York after it is overdue. Each deadline stops separately when its own required signed document is verified. See [reminder and database contracts](schema-contract.md#service-only-reminder-rpcs).
