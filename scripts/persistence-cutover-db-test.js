'use strict';
// Called only by the guarded disposable-local runner; no schema provisioning.
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
module.exports=async function cutover({sql,url,env}){
 const processes=[];
 function session(name,query){
  const child=spawn('psql',['-X','-q','--no-password','-v','ON_ERROR_STOP=1','-At','-d',url.toString()],{env});processes.push(child);
  let output='',errors='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);
  const done=new Promise(resolve=>{child.on('error',e=>resolve({code:-1,errors:e.message}));child.on('close',code=>resolve({code,errors,output}));});
  child.stdin.write(`SET application_name='${name}'; SET statement_timeout='15s'; SET idle_in_transaction_session_timeout='30s';\n${query}\n`);
  return {done,send:q=>child.stdin.write(q+'\n'),output:()=>output};
 }
 async function until(check){for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for controlled PostgreSQL session');}
 const source=()=>sql('SELECT version FROM public.app_state WHERE id=1');
 const setup=()=>sql("UPDATE cashier.control SET mode='legacy',source_version=(SELECT version FROM public.app_state WHERE id=1),source_hash='cutover-fixture' WHERE id=true;");
 const transition=v=>`SELECT cashier.enter_normalized_read(${v},'cutover-fixture');`;
 const save=v=>`SELECT * FROM public.save_app_state(${v},(SELECT payload FROM public.app_state WHERE id=1),'TEST');`;
 const blocked=name=>until(async()=>await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock'`)==='1');
 try{
  await setup();let version=await source();
  await assert.rejects(sql(transition(Number(version)+1)),/identity mismatch/);
  await assert.rejects(sql(`SELECT cashier.enter_normalized_read(${version},'wrong-hash');`),/identity mismatch/);
  await assert.rejects(sql(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${transition(version)}`),/READ COMMITTED/);
  assert.equal(await sql('SELECT mode FROM cashier.control'),'legacy');
  // An already-running legacy save commits before transition obtains its table lock.
  const writer=session('cutover_old_writer',`BEGIN; ${save(version)}\n\\echo READY`);await until(()=>writer.output().includes('READY'));
  const cut=session('cutover_waiting',transition(version)+'\n\\q');await blocked('cutover_waiting');writer.send('COMMIT;\n\\q');assert.equal((await writer.done).code,0);
  const rejected=await cut.done;assert.notEqual(rejected.code,0);assert.match(rejected.errors,/source changed/);assert.equal(await sql('SELECT mode FROM cashier.control'),'legacy');
  await setup();version=await source();const original=await sql('SELECT row_to_json(a)::text FROM public.app_state a WHERE id=1');
  const stale=session('cutover_stale_snapshot',"BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT mode FROM cashier.control;\n\\echo READY");await until(()=>stale.output().includes('READY'));
  // Successful transition holds its lock until commit; a new legacy save queues behind it.
  const guarded=session('cutover_guarded',`BEGIN ISOLATION LEVEL READ COMMITTED; ${transition(version)}\n\\echo READY`);await until(()=>guarded.output().includes('READY'));
  const waiting=session('cutover_new_writer',save(version)+'\n\\q');await blocked('cutover_new_writer');guarded.send('COMMIT;\n\\q');assert.equal((await guarded.done).code,0);
  const frozen=await waiting.done;assert.notEqual(frozen.code,0);assert.match(frozen.errors,/frozen/i);
  assert.equal(await sql('SELECT mode FROM cashier.control'),'normalized-read');assert.equal(await sql('SELECT row_to_json(a)::text FROM public.app_state a WHERE id=1'),original);
  await assert.rejects(sql(save(version)),/frozen/i);
  stale.send(save(version)+'\n\\q');const staleResult=await stale.done;assert.notEqual(staleResult.code,0);assert.match(staleResult.errors,/serialize|frozen/i);
  await sql(transition(version)); // Exact unchanged identity permits idempotent acceptance only.
  await assert.rejects(sql(`SET ROLE service_role; ${transition(version)}`),/permission denied/);
  await assert.rejects(sql("SET ROLE service_role; UPDATE cashier.control SET mode='normalized';"),/permission denied/);
  console.log('REAL PostgreSQL cutover: in-flight/queued/after-transition legacy saves, mismatch, unchanged data, and permissions passed.');
 }finally{for(const p of processes)if(p.exitCode===null)p.kill();}
};
