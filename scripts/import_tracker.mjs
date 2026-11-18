#!/usr/bin/env node
/** Offline, resumable importer. Dry run is default; no network without --apply. */
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const filename = args.find((arg) => !arg.startsWith('--'));
if (!filename || args.some((arg) => arg.startsWith('--') && arg !== '--apply')) {
  throw new Error('Usage: node scripts/import_tracker.mjs .env.import-tracker.local [--apply]');
}
const path = resolve(filename);
if (!basename(path).startsWith('.env')) throw new Error('Use a Git-ignored .env* import payload');
try { execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { stdio: 'ignore' }); }
catch { throw new Error('Import payload must be Git-ignored'); }
const payload = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const expected = { 'Project Tracker': 164, 'Project Tracker (COMPLETED)': 379, 'Project Tracker (PROPOSALS)': 14 };
if (payload.format_version !== 1 || !/^[0-9a-f]{64}$/.test(payload.workbook_sha256) || payload.expected_rows !== 557 || payload.rows?.length !== 557) throw new Error('Invalid tracker payload');
const seen = new Set();
const counts = {};
for (const row of payload.rows) {
  const identity = `${row.source_sheet}:${row.source_row}`;
  if (seen.has(identity) || !expected[row.source_sheet] || !Number.isInteger(row.source_row) || !row.source_cells || !row.mapped_values || !Array.isArray(row.validation_flags)) throw new Error('Invalid or repeated source identity');
  seen.add(identity); counts[row.source_sheet] = (counts[row.source_sheet] ?? 0) + 1;
  for (const key of ['first_contact_date','proposal_sent_date','proposal_accepted_date','filed_date','meeting_date']) {
    const date = row.mapped_values[key];
    if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid mapped date');
  }
}
if (Object.entries(expected).some(([sheet, count]) => counts[sheet] !== count)) throw new Error('Tracker sheet totals changed');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'dry-run', rows: payload.rows.length, sheet_counts: counts, workbook_sha256: payload.workbook_sha256, flag_counts: payload.summary.flag_counts }, null, 2));
} else {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for offline import');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname)) throw new Error('HTTPS required for remote Supabase');
  if (!key.startsWith('sb_secret_')) {
    let role;
    try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch { /* report below */ }
    if (role !== 'service_role') throw new Error('A service-role credential is required; user/anon keys are forbidden');
  }
  async function request(route, method = 'GET', body, prefer) {
    const response = await fetch(new URL(`/rest/v1/${route}`, endpoint), { method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Import request failed (${response.status}, ${error.code ?? 'unknown'}): ${error.message ?? 'See Supabase logs'}`);
    }
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  await request('import_runs?on_conflict=workbook_sha256', 'POST', { workbook_sha256: payload.workbook_sha256, filename: payload.filename, expected_rows: 557, summary: payload.summary }, 'resolution=ignore-duplicates,return=minimal');
  const [run] = await request(`import_runs?workbook_sha256=eq.${payload.workbook_sha256}&select=id,imported_rows,state`);
  if (!run) throw new Error('Import run could not be established');
  let processed = 0;
  try {
    for (const row of payload.rows) {
      await request('rpc/import_tracker_row', 'POST', { p_run_id: run.id, p_row: row });
      processed += 1;
      if (processed % 100 === 0) console.log(`Checked ${processed}/557 source rows`);
    }
    const rows = await request(`import_rows?import_run_id=eq.${run.id}&select=project_id&limit=1000`);
    if (rows.length !== 557 || new Set(rows.map(row => row.project_id)).size !== 557) throw new Error('Server import reconciliation failed');
    await request(`import_runs?id=eq.${run.id}`, 'PATCH', { state: 'completed', imported_rows: 557, completed_at: new Date().toISOString() });
    console.log(JSON.stringify({ mode: 'applied', run_id: run.id, projects: 557, idempotent_source_identities: 557 }));
  } catch (error) {
    await request(`import_runs?id=eq.${run.id}`, 'PATCH', { state: 'failed' }).catch(() => {});
    throw error;
  }
}
