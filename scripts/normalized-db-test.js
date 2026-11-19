'use strict';
// Optional REAL PostgreSQL suite. Never provisions/applies migrations and never uses app credentials.
// Requires an empty disposable localhost database with schema files already reviewed/applied by operator.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const assert=require('node:assert/strict');
const exec=promisify(execFile);
const ADMIN='00000000-0000-4000-8000-000000000001',CASHIER='00000000-0000-4000-8000-000000000002';
const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
async function main(){
 if(!process.argv.includes('--confirm-disposable'))throw new Error('Requires --confirm-disposable and LOCAL_PERSISTENCE_TEST_URL; never use production');
 const url=new URL(process.env.LOCAL_PERSISTENCE_TEST_URL||'invalid:');
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/cashier_test_[a-z0-9_]+$/.test(url.pathname)||url.search||url.hash)throw new Error('Only an explicit localhost cashier_test_* database is allowed');
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')&&!/SUPABASE|JWT|INITIAL_ADMIN/.test(key)));
 async function sql(query){try{return (await exec('psql',['-X','-q','--no-password','-v','ON_ERROR_STOP=1','-At','-d',url.toString(),'-c',query],{env,maxBuffer:1024*1024,timeout:20000})).stdout.trim();}catch(e){throw new Error(e.stderr||'Local PostgreSQL execution failed');}}
 async function value(query){return JSON.parse(await sql(query));}
 const empty=await sql('SELECT (SELECT count(*) FROM cashier.transactions)+(SELECT count(*) FROM cashier.products)+(SELECT count(*) FROM cashier.operations)+(SELECT count(*) FROM public.app_users);');
 assert.equal(empty,'0','Must be a fresh disposable database, not existing data');
 if(process.argv.includes('--cutover-only')){await require('./persistence-cutover-db-test')({sql,url,env});return;}
 if(process.argv.includes('--migration-only')){
  const migration=require('./persistence-migrate'),fixture=require('./persistence-fixture')(),bundle=migration.prepare(fixture);
  await sql(`UPDATE public.app_state SET version=17,payload=${quote(JSON.stringify(fixture.payload))}::jsonb WHERE id=1;`);
  await sql(migration.importSql(bundle));await sql(migration.importSql(bundle));
  const actual=await value(migration.exportSql());migration.validate(bundle,actual);assert.equal(actual.invoiceCounter,959);
  await assert.rejects(sql(migration.importSql({...bundle,sourceVersion:18})),/version changed/);
  await sql("UPDATE cashier.products SET stock=stock+1 WHERE id='p';");
  assert.throws(()=>migration.validate(bundle,{...actual,tables:{...actual.tables,products:actual.tables.products.map(x=>({...x,stock:'99'}))}}),/mismatch/);
  await assert.rejects(sql(migration.importSql(bundle)),/Validation mismatch/);
  await sql(`INSERT INTO public.app_users(id,username,password_hash,role) VALUES('${ADMIN}','TEST_ADMIN','$2not-a-real-credential','ADMINISTRATOR'); UPDATE cashier.control SET mode='normalized' WHERE id=true;`);
  const nextInvoice=await value(`SELECT public.cashier_command('sale','{"items":[{"productId":"p","qty":"1","price":"10"}],"paymentMethod":"Tunai","payment":"10"}','migrated-next-sale','${ADMIN}','normalized');`);
  assert.equal(nextInvoice.transaction.invoice,'960');
  console.log('REAL local migration/import/restart/export/financial comparison and divergent-data rejection passed.');return;
 }
 await sql(`INSERT INTO public.app_users(id,username,password_hash,role) VALUES('${ADMIN}','TEST_ADMIN','$2not-a-real-credential','ADMINISTRATOR'),('${CASHIER}','TEST_CASHIER','$2not-a-real-credential','KASIR');
 UPDATE cashier.control SET mode='normalized',source_hash='synthetic-test',invoice_counter=959,config='{"settings":{"discountMethod":"Nominal","taxPercent":0},"paymentMethods":["Tunai","DP","Transfer"],"categories":[],"units":[]}' WHERE id=true;
 INSERT INTO cashier.products(id,name,stock,cost_price,track_stock,data) VALUES('p','Product',20,2,true,'{"id":"p","name":"Product","active":true,"unit":"Kg"}'),('q','Second',10,3,true,'{"id":"q","name":"Second","active":true}');`);
 const command=(kind,body,id,actor=ADMIN)=>value(`SET ROLE service_role; SELECT public.cashier_command(${quote(kind)},${quote(JSON.stringify(body))}::jsonb,${quote(id)},${quote(actor)},'normalized');`);
 // Connection owner is used for fixture setup; each RPC independently rechecks app role.
 const stock=id=>sql(`SELECT stock FROM cashier.products WHERE id=${quote(id)}`);
 const sale=(qty='2',extra=[])=>({items:[{productId:'p',qty,price:'10',discount:'0'},...extra],payment:'1000',paymentMethod:'Tunai'});
 for(const [instant,day] of [['2026-11-16T16:59:00Z','2026-11-16'],['2026-11-16T17:00:00Z','2026-11-17'],['2026-11-16T17:30:00Z','2026-11-17'],['2026-11-16T23:59:00Z','2026-11-17'],['2026-11-17T00:00:00Z','2026-11-17']])assert.equal(await sql(`SET TIME ZONE 'America/Los_Angeles'; SELECT cashier.business_day(${quote(instant)}::timestamptz);`),day);
 const first=await command('sale',sale(),'sale-first',CASHIER);assert.equal(await stock('p'),'18');assert.equal(first.transaction.total,20);assert.equal(first.transaction.invoice,'960');
 assert.deepEqual(await command('sale',sale(),'sale-first',CASHIER),first,'lost acknowledgement returns same receipt');assert.equal(await stock('p'),'18');assert.equal(await sql('SELECT invoice_counter FROM cashier.control'),'960');
 const invalid=[['sale',{}],['sale',{...sale(),items:[]}],['sale',{...sale(),items:{}}],['sale',{...sale(),items:null}],['sale',{...sale(),items:[{qty:'1',price:'1'}]}],['sale',sale('NaN')],['sale',sale('-1')],['sale',sale('1e3')],['quantity',{id:first.transaction.id,revision:1}],['quantity',{id:first.transaction.id,revision:1,quantities:['bad']}],['payment',{amount:'1',method:'Tunai',date:'2026-11-17'}],['incoming',{productId:'p',supplier:'S',qty:'1',purchasePrice:'1',date:'2026-2-1'}],['stocktake',{productId:'p',physicalStock:'1',expectedStock:'18',date:'2026-02-30'}],['payment',{id:first.transaction.id,amount:'1',method:'Tunai',date:'2026-11-17T00:00:00Z'}],['config',{revision:1}],['config',{revision:1,data:{settings:{}}}],['config',{revision:1,data:{settings:[],categories:[],units:[],paymentMethods:[]}}],['config',{revision:1,data:{settings:{discountMethod:'Nominal',taxPercent:0},categories:[null],units:[],paymentMethods:[]}}],['product',{revision:1,data:{id:'new',name:'N',stock:'0',costPrice:'0',retailPrice:'1',wholesalePrice:'1',trackStock:'false',active:true}}]];
 for(const [i,[kind,body]] of invalid.entries())await assert.rejects(command(kind,body,`invalid-command-${i}`),'RPC must reject invalid JSON without Express');
 for(const bad of ['2026-1-01','2026-02-30','2026-11-17T00:00:00Z',' 2026-11-17','tomorrow'])await assert.rejects(sql(`SELECT cashier.business_date(${quote(bad)});`));
 await assert.rejects(command('sale',sale(),'        '),/Invalid operation/);
 await assert.rejects(sql(`SELECT public.cashier_read('dashboard','{"date":"11/17/2026"}','${ADMIN}','normalized');`),/YYYY-MM-DD/);
 assert.equal(await stock('p'),'18');assert.equal(await sql('SELECT count(*) FROM cashier.operations'),'1','invalid RPCs must roll back receipts and business records');
 await assert.rejects(command('sale',sale('3'),'sale-first',CASHIER),/Idempotency/);
 const before=await stock('p');await assert.rejects(command('sale',sale('1',[{productId:'missing',qty:'1',price:'2'}]),'sale-rollback'),/Unknown/);assert.equal(await stock('p'),before);assert.equal(await sql("SELECT count(*) FROM cashier.operations WHERE id='sale-rollback'"),'0');
 const multi=await command('sale',sale('1',[{productId:'q',qty:'2',price:'5',discount:'0'}]),'sale-multi');assert.equal(await stock('q'),'8');assert.equal(multi.transaction.total,20);
 await assert.rejects(command('sale',sale('100'),'sale-oversold'),/Insufficient stock/);
 // Two separate psql processes/connections contend for the same last inventory.
 const races=await Promise.allSettled([command('sale',sale('10'),'race-sale-1'),command('sale',sale('10'),'race-sale-2')]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(await stock('p'),'7');
 assert.equal(await sql('SELECT count(*)=count(DISTINCT invoice) FROM cashier.transactions'),'t');
 const dp=await command('sale',{...sale('1'),paymentMethod:'DP',payment:'2'},'sale-dp-01');assert.equal(dp.transaction.remaining,8);
 const payment={id:dp.transaction.id,amount:'3',method:'Transfer',date:'2026-10-23'};
 const partial=await command('payment',payment,'payment-part');assert.equal(partial.transaction.remaining,5);assert.deepEqual(await command('payment',payment,'payment-part'),partial);
 const settlements=await Promise.allSettled([command('payment',{...payment,amount:'5'},'payment-race-1'),command('payment',{...payment,amount:'5'},'payment-race-2')]);assert.equal(settlements.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(command('payment',{...payment,amount:'1'},'payment-excess'),/exceeds/);
 const incoming={productId:'p',qty:'4',purchasePrice:'6',supplier:'Test',date:'2026-10-23'};
 const inc=await command('incoming',incoming,'incoming-01');assert.equal(await stock('p'),'10');assert.deepEqual(await command('incoming',incoming,'incoming-01'),inc);assert.equal(await stock('p'),'10');
 await assert.rejects(command('incoming',{...incoming,date:'not-a-date'},'incoming-invalid'));assert.equal(await stock('p'),'10');assert.equal(await sql("SELECT count(*) FROM cashier.incoming_stock WHERE id='incoming-invalid'"),'0');
 const edit={id:first.transaction.id,revision:1,quantities:['1']};const corrected=await command('quantity',edit,'quantity-down');assert.equal(await stock('p'),'11');assert.equal(corrected.transaction.total,10);assert.equal(corrected.transaction.refundDue,10);assert.deepEqual(await command('quantity',edit,'quantity-down'),corrected);assert.equal(await stock('p'),'11');
 const up=await command('quantity',{...edit,revision:2,quantities:['3']},'quantity-up');assert.equal(await stock('p'),'9');assert.equal(up.transaction.total,30);
 await assert.rejects(command('quantity',{...edit,revision:3,quantities:['100']},'quantity-fail'),/Insufficient/);assert.equal(await stock('p'),'9');
 await assert.rejects(command('quantity',{...edit,revision:1},'quantity-stale'),/changed/);
 const take=await command('stocktake',{productId:'p',physicalStock:'8.5',expectedStock:'9',date:'2026-10-23'},'stocktake-01');assert.equal(await stock('p'),'8.5');assert.equal(take.record.difference,-0.5);assert.equal(await sql('SELECT count(*) FROM cashier.stocktakes'),'1');
 await assert.rejects(command('stocktake',{productId:'p',physicalStock:'8',expectedStock:'9',date:'2026-10-23'},'stocktake-stale'),/changed/);
 await Promise.all([command('incoming',incoming,'incoming-race'),command('sale',sale('1'),'sale-incoming-race')]);assert.equal(await stock('p'),'11.5');
 await Promise.all([command('quantity',{id:first.transaction.id,revision:3,quantities:['2']},'quantity-race'),command('sale',sale('1'),'sale-quantity-race')]);assert.equal(await stock('p'),'11.5');
 const invoices=await Promise.all([command('sale',sale('1'),'invoice-race-1'),command('sale',sale('1'),'invoice-race-2')]);assert.notEqual(invoices[0].transaction.invoice,invoices[1].transaction.invoice);assert.ok(invoices.every(x=>/^\d+$/.test(x.transaction.invoice)));
 await assert.rejects(command('incoming',incoming,'cashier-forbidden',CASHIER),/Administrator/);
 const page=await value(`SELECT public.cashier_read('transactions','{"page":1,"limit":2}', '${CASHIER}','normalized')`);assert.equal(page.rows.length,2);assert.ok(page.total>2);
 const version=Number(await sql('SELECT revision FROM cashier.control'));
 const dashboard=await value(`SELECT public.cashier_read('dashboard','{"expectedRevision":${version}}','${CASHIER}','normalized')`);assert.doesNotMatch(JSON.stringify(dashboard),/cost.?price|profit/i);
 const adminDashboard=await value(`SELECT public.cashier_read('dashboard','{}','${ADMIN}','normalized')`);assert.ok(Object.hasOwn(adminDashboard,'profit'));assert.ok(adminDashboard.days.every(d=>Object.hasOwn(d,'profit')));
 await command('sale',sale('1'),'read-revision-change');await assert.rejects(sql(`SELECT public.cashier_read('transactions','{"expectedRevision":${version}}','${CASHIER}','normalized');`),/Read revision changed/);
 await assert.rejects(sql(`SET ROLE anon; SELECT public.cashier_command('sale','{}','forbidden-op','${ADMIN}','normalized');`),/permission denied/);
 for(const [i,[price,discount]] of [['1','0'],['0','0'],['10','10'],['99','0']].entries()){
  const result=await command('sale',{items:[{productId:'p',qty:'0.1',price,discount}],payment:'100',paymentMethod:'Tunai'},'price-policy-'+i,CASHIER);
  assert.equal(result.transaction.total,(Number(price)-Number(discount))*0.1);
 }
 for(const [i,[price,discount]] of [['-1','0'],['10','-1'],['10','11'],['NaN','0']].entries())await assert.rejects(command('sale',{items:[{productId:'p',qty:'0.1',price,discount}],payment:'100',paymentMethod:'Tunai'},'bad-price-'+i,CASHIER));
 await require('./quantity-recalculation-db-test')({sql,value,command});
 await require('./payment-history-db-test')({sql,value,command,actor:ADMIN});
 console.log('REAL local PostgreSQL atomicity, stock, DP, idempotency, invoice, two-connection contention, quantity, stocktake and role tests passed. Disposable fixture retained for inspection.');
}
main().catch(error=>{console.error(error.stack || error.message);process.exitCode=1});
