# Prototype walkthrough

Use a local or controlled Cloudflare Worker deployment connected to the intended Supabase project. Populate the workspace by importing the approved tracker workbook. Do not substitute synthetic projects or publish tracker data, generated payloads, or screenshots containing client information.

## Sign in and overview

1. Have an administrator create the staff Auth user and matching active `public.staff` row.
2. Sign in with the staff email and password. A valid Auth login without an active staff row is denied.
3. The overview highlights work needing staff attention. Navigation is staff-only; there is no client portal or public intake.

## Clients, calls, and projects

- Search the imported client directory; add or edit client contact details as appropriate for the real workflow.
- Archive and restore a client to demonstrate that linked projects and calls remain available.
- Record a call and add separate timestamped follow-ups. Deleting a call or follow-up requires confirmation and leaves its history visible as a tombstone.
- Open a client’s existing property project or create a separate project for another address. Assign multiple active staff members where needed.

## Presets, tasks, and project completion

- In Presets, create or edit a reusable task/group and optional required intake fields and document requirements.
- Apply a preset to a project. The project receives its own tasks, requirements and immutable source definition snapshot. Editing the preset later affects only later applications.
- Keep fieldwork and required paperwork tasks distinct. Add child tasks when useful.
- Complete a project only after the required intake fields, tasks, signed-document verifications, and project deadlines are satisfied. Staff verification records an attestation about an uploaded document; V1 does not collect an electronic signature.

## Project documents

Upload an allowed file under Proposal, Transmittal, Filings, Permits, Compliance docs, or Other. Each replacement is a new version. Verify that downloads are available only to active staff and that archive/restore preserves version history. The accepted types and 25 MB limit are documented in [the schema contract](schema-contract.md#shared-shapes).

## Reminder preview and email demonstration

1. Add a permit or final sign-off deadline to a project, attach the required document requirement, select active ESE staff recipients, and set notice offsets.
2. Preview reminder emails in the application. Preview mode does not enqueue or send, even if a project matches an advance notice or overdue date.
3. For an actual inbox demonstration after a verified sender domain and Resend account exist, configure the Edge Function in `demo` mode and explicitly enable delivery. Demo mode redirects sends to `revisa@rpi.edu`, even if multiple selected staff would otherwise receive the same notice.
4. Keep Supabase Cron disabled during preview. Only enable its five-minute schedule after verifying the bearer secret, sender, redirect destination and send log. Do not set `live` for the demo.

The current deadline defaults are 30, 14, and 3 days before due date, then daily at 9 a.m. America/New_York. A deadline’s own verified paperwork stops that deadline’s reminders. See [reminder setup](setup.md#reminder-provider-configuration).

## Reset and data handling

Use a dedicated Supabase project for rehearsals. Imported source rows are persistent business history; do not delete or replace them merely to reset a demo. Archive/restore through staff screens. Keep local generated import payloads, provider credentials, and client-identifying screenshots outside Git and shared logs.
