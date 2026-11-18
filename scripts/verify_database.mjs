#!/usr/bin/env node
/** In-memory Postgres validation with Supabase Auth/Storage stubs, never remote. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(resolve(process.env.PGLITE_MODULE)).href : '@electric-sql/pglite');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
let checks = 0;
async function q(sql, args = []) { return (await db.query(sql, args)).rows; }
async function one(sql, args = []) { return (await q(sql, args))[0]; }
async function check(label, fn) { await fn(); checks++; console.log(`PASS ${label}`); }
async function denied(sql, args = [], pattern) { await assert.rejects(q(sql, args), pattern); }
const user = '10000000-0000-4000-8000-000000000001';
const inactive = '10000000-0000-4000-8000-000000000002';
async function role(name, uid, fn) {
  await db.exec(`reset role; set role ${name}`);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [uid ?? '']);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
await db.exec(`
 create role anon noinherit; create role authenticated noinherit; create role service_role bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth,storage to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant select,insert,update,delete on storage.objects to authenticated,service_role;
 create table public.clients(id bigint generated always as identity primary key,name text not null,phone text,email text,created_at timestamptz not null default now());
 insert into public.clients(name,phone) values('Test Client A','508-555-0101'),('Test Client B','508-555-0102');
 grant select on public.clients to anon;
 create policy "anyone can read clients for now" on public.clients for select to anon using(true);
`);
for (const filename of ['001_schema.sql','002_security.sql','003_workflows.sql','004_reminders.sql']) {
  const sql = (await readFile(resolve(root, 'supabase/migrations', filename), 'utf8')).replace(/create extension if not exists pgcrypto;/i, '-- PGlite uses the built-in gen_random_uuid().');
  try { await db.exec(sql); console.log(`APPLIED ${filename}`); }
  catch (error) { console.error(`FAILED ${filename}: ${error.message}`); throw error; }
}
await q('insert into auth.users(id) values($1),($2)',[user,inactive]);
const staff = await one('insert into staff(auth_user_id,display_name,email,is_active) values($1,$2,$3,true) returning id',[user,'Validation staff','staff@example.invalid']);
await q('insert into staff(auth_user_id,display_name,email) values($1,$2,$3)',[inactive,'Inactive validation staff','inactive@example.invalid']);
await check('preserved bigint client keys and archived starter rows', async () => {
 assert.equal((await one('select count(*)::int n from clients where id in(1,2) and archived_at is not null')).n,2);
});
await check('anonymous cannot read any domain records or invoke privileged RPCs', async () => role('anon', null, async () => {
 await denied('select * from clients', [], /permission denied/);
 await denied('select complete_project(gen_random_uuid())',[],/permission denied/);
 await denied('select * from claim_reminder_deliveries()',[],/permission denied/);
}));
await check('inactive staff RLS blocks every domain table', async () => role('authenticated', inactive, async () => {
 for (const table of ['staff','clients','projects','project_staff','call_logs','call_updates','preset_tasks','preset_groups','preset_group_items','project_preset_applications','tasks','task_staff','documents','document_versions','document_requirements','deadlines','deadline_recipients','reminder_deliveries','reminder_attempts','import_runs','import_rows','audit_events']) assert.equal((await one(`select count(*)::int n from ${table}`)).n,0,table);
 await denied("insert into clients(name) values('forbidden')",[],/row-level security/);
 await denied('select complete_project(gen_random_uuid())',[],/Active staff/);
 assert.equal((await one('select count(*)::int n from storage.objects')).n,0);
}));
await check('active staff cannot forge roles, audits, importer, reminder ledger, or version metadata', async () => role('authenticated', user, async () => {
 await denied('update staff set is_admin=true where id=$1',[staff.id],/permission denied/);
 await denied("insert into audit_events(action,entity_type,entity_id) values('forge','staff','1')",[],/permission denied/);
 await denied('select * from claim_reminder_deliveries()',[],/permission denied/);
 await denied('select import_tracker_row(gen_random_uuid(),$1)',[{}],/permission denied/);
 await denied("insert into document_versions(document_id,object_path,original_filename,media_type,byte_size) values(gen_random_uuid(),'forged','a.pdf','application/pdf',1)",[],/permission denied/);
 await denied('insert into project_preset_applications(project_id,preset_type,source_preset_id,source_revision,definition_snapshot) values(gen_random_uuid(),$1,gen_random_uuid(),1,$2)',['task',{}],/permission denied/);
}));
let project, other, app, requirement, version, deadline;
await role('authenticated', user, async () => {
 project = await one("insert into projects(title) values('Workflow validation') returning id");
 other = await one("insert into projects(title) values('Cross-project validation') returning id");
 const group = await one("select id from preset_groups where name='Property Staking'");
 await check('Property Staking has exactly nine correctly ordered parent stages', async () => {
  assert.deepEqual((await q('select t.name from preset_group_items i join preset_tasks t on t.id=i.preset_task_id where i.group_id=$1 and i.parent_item_id is null order by position',[group.id])).map(x=>x.name),['Research','Proposal','Initial Comps','Initial Fieldwork','Comps','Fieldwork','Final comps','Sketch','Invoice']);
 });
 await q('update preset_groups set intake_fields=$1 where id=$2',[[{id:'lot',label:'Lot number',type:'number',required:true},{id:'occupied',label:'Occupied',type:'boolean',required:true}],group.id]);
 app = (await one('select apply_preset($1,$2,$3,$4) id',[project.id,'group',group.id,{occupied:false}])).id;
 await check('preset snapshot remains stable after source edits', async () => {
  await q("update preset_tasks set name='Changed future title' where id=(select preset_task_id from preset_group_items where group_id=$1 order by position limit 1)",[group.id]);
  assert.equal((await one('select title from tasks where project_id=$1 order by position limit 1',[project.id])).title,'Research');
  await denied('update project_preset_applications set definition_snapshot=$1 where id=$2',[{},app],/permission denied/);
 });
 await check('proposal gate and completion validation apply to direct API writes', async () => {
  await denied("update tasks set status='In progress' where project_id=$1 and requires_proposal",[project.id],/Accepted proposal/);
  await denied("update projects set status='Completed' where id=$1",[project.id],/Required intake|Required tasks/);
 });
 await check('cross-project subtask parents are rejected', async () => {
  const parent = await one('select id from tasks where project_id=$1 and parent_task_id is null limit 1',[project.id]);
  await denied('insert into tasks(project_id,parent_task_id,title) values($1,$2,$3)',[other.id,parent.id,'Invalid child'],/same project/);
 });
 await q('update projects set proposal_accepted_date=$1 where id=$2',['2026-11-18',project.id]);
 await q("update tasks set status='Completed' where project_id=$1",[project.id]);
 await denied('select complete_project($1)',[project.id],/Required intake|document/);
 await q('select update_preset_intake($1,$2)',[app,{lot:0,occupied:false}]);
 await denied('select complete_project($1)',[project.id],/document evidence/);
 requirement = await one('select id from document_requirements where project_id=$1',[project.id]);
 deadline = await one('insert into deadlines(project_id,kind,label,due_date) values($1,$2,$3,$4) returning id,revision',[project.id,'permit','Permit validation','2026-12-18']);
 await q('insert into document_requirements(project_id,deadline_id,label) values($1,$2,$3)',[project.id,deadline.id,'Signed permit']);
 await denied('select satisfy_deadline($1)',[deadline.id],/paperwork/);
 await q('insert into deadline_recipients(deadline_id,staff_id) values($1,$2)',[deadline.id,staff.id]);
 async function prepareUpload(pid) {
  const doc = await one('insert into documents(project_id,title,category) values($1,$2,$3) returning id',[pid,'Signed validation PDF','Proposal']);
  const upload = await one('select * from begin_document_upload($1,$2,$3,$4,$5)',[doc.id,'signed.pdf','application/pdf',100,[{type:'hearing',date:'2026-11-18'},{type:'hearing',date:'2026-11-19'}]]);
  return upload;
 }
 version = await prepareUpload(project.id);
 const cross = await prepareUpload(other.id);
 await check('private storage rejects arbitrary paths and oversized initiation', async () => {
  await denied("insert into storage.objects(bucket_id,name,metadata) values('project-documents','forged-path',$1)",[{size:100}],/row-level security/);
  await denied('select begin_document_upload($1,$2,$3,$4)',[version.document_id,'large.pdf','application/pdf',25000001],/check constraint/);
  await denied('select begin_document_upload($1,$2,$3,$4)',[version.document_id,'bad.exe','application/octet-stream',100],/Unsupported/);
  await denied('select finalize_document_upload($1)',[version.id],/size does not match/);
 });
 await q("insert into storage.objects(bucket_id,name,metadata) values('project-documents',$1,$2),('project-documents',$3,$4)",[version.object_path,{size:100},cross.object_path,{size:100}]);
 await q('select finalize_document_upload($1)',[version.id]); await q('select finalize_document_upload($1)',[cross.id]);
 await check('cross-project document evidence is rejected', async () => denied('select verify_document_requirement($1,$2)',[requirement.id,cross.id],/this project/));
 for (const req of await q('select id from document_requirements where project_id=$1',[project.id])) await q('select verify_document_requirement($1,$2)',[req.id,version.id]);
 await q('select satisfy_deadline($1)',[deadline.id]); await q('select complete_project($1)',[project.id]);
 await check('signed evidence, typed zero/false intake, completed tasks and deadline allow completion', async () => assert.equal((await one('select status from projects where id=$1',[project.id])).status,'Completed'));
 await check('invalidating evidence reopens completed project and satisfied deadline', async () => {
  await q('select invalidate_document_version($1)',[version.id]);
  assert.equal((await one('select status from projects where id=$1',[project.id])).status,'Active');
  assert.equal((await one('select satisfied_at from deadlines where id=$1',[deadline.id])).satisfied_at,null);
  assert.equal((await one('select verified_version_id from document_requirements where id=$1',[requirement.id])).verified_version_id,null);
 });
 await check('call update deletion retains immutable tombstone and true actor', async () => {
  const call = await one('insert into call_logs(caller_name,summary) values($1,$2) returning id',['Validation caller','Validation only']);
  const update = await one('insert into call_updates(call_log_id,body) values($1,$2) returning id',[call.id,'Follow-up']);
  await q('update call_updates set deleted_at=now() where id=$1',[update.id]);
  const deleted=await one('select * from call_updates where id=$1',[update.id]); assert.equal(deleted.body,'Follow-up'); assert.equal(deleted.deleted_by,staff.id);
  await denied('update call_updates set deleted_at=null where id=$1',[update.id],/tombstones/);
 });
});
await check('reminder service atomic idempotence, leasing, transient retry, stale token and revision cancellation', async () => role('service_role',null,async () => {
 const d=await one('select * from deadlines where id=$1',[deadline.id]);
 const input=[d.id,d.revision,'notice_30','2026-11-18','staff@example.invalid',[staff.id],{to:'staff@example.invalid',subject:'Validation',html:'Validation'}];
 const sql='select enqueue_reminder_delivery($1,$2,$3,$4,$5,$6,$7) id';
 const delivery=await one(sql,input); assert.equal((await one(sql,input)).id,delivery.id);
 const now='2026-11-18T15:00:00Z';
 // available_at defaults to actual wall clock, so choose a later deterministic time for queue claims.
 const claimTime='2027-01-01T15:00:00Z';
 const [lease]=await q('select * from claim_reminder_deliveries(25,$1)',[claimTime]); assert.ok(lease);
 assert.equal((await q('select * from claim_reminder_deliveries(25,$1)',[claimTime])).length,0);
 await q('select record_reminder_result($1,$2,$3,null,$4,$5,$6)',[lease.id,lease.lease_token,'transient','network',{},claimTime]);
 const retry=await one('select * from reminder_deliveries where id=$1',[lease.id]); assert.equal(retry.state,'retry'); assert.equal(new Date(retry.available_at)-new Date(claimTime),300000);
 await denied('select record_reminder_result($1,$2,$3)',[lease.id,lease.lease_token,'sent'],/Lease token/);
 await q('update deadlines set due_date=due_date+1 where id=$1',[d.id]);
 assert.equal((await one('select state from reminder_deliveries where id=$1',[lease.id])).state,'cancelled');
}));
await check('atomic group save validates stable parent hierarchy and rolls back invalid replacement',async()=>role('authenticated',user,async()=>{
 const source=await one('select id from preset_tasks where archived_at is null limit 1');
 const rootid='20000000-0000-4000-8000-000000000001', childid='20000000-0000-4000-8000-000000000002';
 const items=[{id:rootid,preset_task_id:source.id,position:0},{id:childid,preset_task_id:source.id,parent_item_id:rootid,position:1}];
 const group=await one('select save_preset_group(null,$1,null,$2,$3) id',['Atomic group validation',[],items]);
 const before=await q('select id,parent_item_id,position from preset_group_items where group_id=$1 order by position',[group.id]);
 await denied('select save_preset_group($1,$2,null,$3,$4)',[group.id,'Invalid edit',[],[{...items[1],parent_item_id:'20000000-0000-4000-8000-000000000003'}]],/Subtask parent/);
 assert.deepEqual(await q('select id,parent_item_id,position from preset_group_items where group_id=$1 order by position',[group.id]),before);
 await q('select save_preset_group($1,$2,null,$3,$4)',[group.id,'Edited group',[],items]);
 assert.equal((await one('select name from preset_groups where id=$1',[group.id])).name,'Edited group');
}));
// Optional actual workbook payload test: rows remain in this disposable, in-memory DB only.
const payloadFile=process.argv[2];
if(payloadFile) await check('real workbook creates exactly 557 projects, reruns idempotently and preserves malformed raw dates',async()=>role('service_role',null,async()=>{
 const payload=JSON.parse((await readFile(resolve(payloadFile),'utf8')).replace(/^\uFEFF/,'')); assert.equal(payload.rows.length,557);
 for(const row of payload.rows) for(const flag of row.validation_flags) if(['unparsed_date','date_out_of_range'].includes(flag.code)){assert.equal(row.mapped_values[flag.field],null);assert.ok(row.source_cells[flag.cell]);}
 const run=await one('insert into import_runs(workbook_sha256,filename) values($1,$2) returning id',[payload.workbook_sha256,payload.filename]);
 const ids=[]; for(const row of payload.rows) ids.push((await one('select import_tracker_row($1,$2) id',[run.id,row])).id);
 for(const row of payload.rows) await one('select import_tracker_row($1,$2) id',[run.id,row]);
 assert.equal(new Set(ids).size,557); assert.equal((await one('select count(*)::int n from projects where import_run_id=$1',[run.id])).n,557);
 assert.equal((await one('select imported_rows from import_runs where id=$1',[run.id])).imported_rows,557);
 assert.equal((await one('select count(*)::int n from deadlines where project_id=any($1::uuid[])',[ids])).n,0);
 assert.equal((await one("select count(*)::int n from import_rows where import_run_id=$1 and jsonb_array_length(validation_flags)>0",[run.id])).n>0,true);
 assert.equal((await one('select count(*)::int n from staff where auth_user_id is null and is_active')).n,0);
}));
console.log(`Database validation passed: ${checks} checks. Auth/Storage are local stubs; live Supabase remains unverified.`);
await db.close();
