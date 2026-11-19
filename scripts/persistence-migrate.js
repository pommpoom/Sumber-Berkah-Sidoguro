'use strict';
// Offline only: reads explicit files, produces reviewed SQL; never connects to a database.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {businessDate}=require('./business-date');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function decimal(x) {
  const s=String(x),m=s.match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if(!m)throw new Error(`Invalid decimal: ${s}`);
  let scale=(m[3]||'').length-Number(m[4]||0),n=BigInt((m[1]||'')+m[2]+(m[3]||''));
  if(Math.abs(scale)>100)throw new Error('Decimal exponent out of range');
  if(scale<0){n*=10n**BigInt(-scale);scale=0;}
  return {n,scale};
}
function format({n,scale}) {
  const sign=n<0n?'-':'';let s=(n<0n?-n:n).toString().padStart(scale+1,'0');
  if(scale)s=s.slice(0,-scale)+'.'+s.slice(-scale);
  return sign+s.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
}
function add(a,b){a=decimal(a);b=decimal(b);const scale=Math.max(a.scale,b.scale);return format({n:a.n*10n**BigInt(scale-a.scale)+b.n*10n**BigInt(scale-b.scale),scale});}
const neg=x=>format({...decimal(x),n:-decimal(x).n});
const sub=(a,b)=>add(a,neg(b));
function mul(a,b){a=decimal(a);b=decimal(b);return format({n:a.n*b.n,scale:a.scale+b.scale});}
const cmp=(a,b)=>{const n=decimal(sub(a,b)).n;return n<0n?-1:n>0n?1:0;};
const max=(a,b)=>cmp(a,b)>=0?a:b;
const sum=xs=>xs.reduce(add,'0');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>hash(canonical(x));
function prepare(envelope,{historicalDatePolicy='preserve-legacy'}={}) {
  if(!['preserve-legacy','jakarta'].includes(historicalDatePolicy))throw new Error('Invalid historical date policy');
  const inspect=x=>{if(typeof x==='number'&&(!Number.isFinite(x)||(Number.isInteger(x)&&!Number.isSafeInteger(x))))throw new Error('Unsafe JSON number; export this value as a decimal string');if(x&&typeof x==='object')Object.values(x).forEach(inspect);};inspect(envelope);
  const state=envelope.payload||envelope.state;
  if(!state||!Number.isSafeInteger(envelope.version)||envelope.version<0)throw new Error('Export must include payload (or state) and exact app_state version');
  const warnings=[],tables={},seen={};
  const dateReview={policy:historicalDatePolicy,timeZone:'Asia/Jakarta',inspected:0,changed:[],ambiguous:[]};
  const list=k=>{if(!Array.isArray(state[k]))throw new Error(`Missing collection ${k}`);return state[k];};
  const num=(x,field,required=true)=>{if(x[field]==null){if(required)throw new Error(`Missing ${field} in ${x.id||x.invoice||'record'}`);warnings.push(`Missing ${field} in ${x.id||x.invoice||'record'}; retained as NULL`);return null;}return format(decimal(x[field]));};
  const date=x=>{if(!x){warnings.push('Missing historical date; retained as NULL');return null;}const d=String(x).slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)throw new Error('Invalid date '+d);return d;};
  const id=(x,k)=>{if(typeof x.id!=='string'||!x.id)throw new Error(`Missing string ID in ${k}`);seen[k]??=new Set();if(seen[k].has(x.id))throw new Error(`Duplicate ${k} ID ${x.id}`);seen[k].add(x.id);return x.id;};
  const timestampDay=(timestamp,record,explicit)=>{
    const legacy=date(timestamp);if(!timestamp)return explicit?date(explicit):legacy;dateReview.inspected++;
    let jakarta;try{jakarta=businessDate(timestamp)}catch(error){dateReview.ambiguous.push({record,timestamp});if(historicalDatePolicy==='jakarta'&&!explicit)throw error;warnings.push(`Ambiguous timestamp ${record}; ${explicit?'explicit':'legacy'} day retained`);return explicit?date(explicit):legacy;}
    const selected=explicit?date(explicit):historicalDatePolicy==='jakarta'?jakarta:legacy;
    if(jakarta!==legacy)dateReview.changed.push({record,timestamp,legacy,jakarta,selected,basis:explicit?'explicit-business-date':historicalDatePolicy});
    return selected;
  };
  tables.products=list('products').map(x=>({id:id(x,'products'),name:x.name,stock:num(x,'stock'),cost_price:num(x,'costPrice',false),track_stock:Boolean(x.trackStock),data:x}));
  for(const k of ['customers','suppliers'])tables[k]=list(k).map(x=>({id:id(x,k),name:x.name,data:x}));
  const productId=x=>{if(x.productId&&seen.products.has(x.productId))return x.productId;warnings.push(`Unresolved historical product ${x.productId||x.name||x.product||'(missing)'}; no guessed match`);return null;};
  tables.transactions=[];tables.transaction_items=[];tables.transaction_payments=[];tables.quantity_edits=[];
  const invoices=new Set();
  for(const x of list('transactions')) {
    const tid=id(x,'transactions');if(x.invoice==null||invoices.has(String(x.invoice)))throw new Error('Missing/duplicate invoice');invoices.add(String(x.invoice));
    if(!Array.isArray(x.items)||!x.items.length)throw new Error('Transaction without items '+tid);
    const items=x.items.map((i,index)=>({transaction_id:tid,line_no:index+1,product_id:productId(i),legacy_product_id:i.productId||null,name:i.name??null,unit:i.unit??null,
      qty:num(i,'qty'),price:num(i,'price'),discount:i.discount==null?'0':num(i,'discount'),cost_price:num(i,'costPrice',false),
      amount:i.amount==null?mul(max('0',sub(num(i,'price'),i.discount??0)),num(i,'qty')):num(i,'amount'),profit:num(i,'profit',false),data:i}));
    for(const i of items)if(cmp(i.qty,0)<=0||cmp(i.price,0)<0||cmp(i.discount,0)<0)throw new Error('Invalid historical line '+tid);
    tables.transaction_items.push(...items);
    // Preserve stored amounts, even if legacy floating-point arithmetic differs from exact recomputation.
    for(const i of items)if(cmp(i.amount,mul(max('0',sub(i.price,i.discount)),i.qty))!==0)warnings.push(`Stored line amount differs from exact arithmetic: ${tid}/${i.line_no}; preserved`);
    const total=num(x,'total'),initial=x.paymentMethod==='DP'?num(x,'downPayment'):x.cashIn!=null?num(x,'cashIn'):max('0',sub(x.payment??total,x.change??0));
    const transactionDay=timestampDay(x.createdAt,`transaction:${tid}`,x.businessDate);
    const row={id:tid,invoice:String(x.invoice),business_date:transactionDay,occurred_at:x.createdAt??null,cashier:x.cashier??null,customer:x.customer??null,payment_method:x.paymentMethod??null,
      subtotal:x.subtotal==null?sum(items.map(i=>i.amount)):num(x,'subtotal'),discount_amount:x.discountAmount!=null?num(x,'discountAmount'):x.discount!=null?num(x,'discount'):'0',
      discount_percent:num(x,'discountPercent',false),discount_method:x.discountMethod??null,tax_percent:x.taxPercent==null?'0':num(x,'taxPercent'),tax_amount:num(x,'taxAmount',false),total,data:{...x}};
    delete row.data.items;delete row.data.paymentHistory;delete row.data.quantityEdits;
    tables.transactions.push(row);
    const dashboardInitial=format(decimal(x.cashIn??(x.paymentMethod==='DP'?x.downPayment:total)));
    if(cmp(dashboardInitial,initial)!==0)warnings.push(`Legacy dashboard cash differs from retained payment for ${tid}; both semantics preserved for review`);
    tables.transaction_payments.push({transaction_id:tid,id:'legacy-initial',initial:true,amount:initial,dashboard_amount:dashboardInitial,business_date:transactionDay,method:x.paymentMethod??null,cashier:x.cashier??null,data:{legacyDerived:true}});
    const payIds=new Set(['legacy-initial']);
    for(const [index,p] of (x.paymentHistory||[]).entries()) {
      const pid=p.id||`legacy-payment-${index+1}`;
      if(payIds.has(pid))throw new Error('Duplicate payment ID '+tid);payIds.add(pid);
      if(!p.id)warnings.push(`Structural payment key allocated for ${tid}/${index+1}; source kept unchanged`);
      tables.transaction_payments.push({transaction_id:tid,id:pid,initial:false,amount:num(p,'amount'),dashboard_amount:null,business_date:p.date?date(p.date):timestampDay(p.createdAt,`payment:${tid}/${pid}`),method:p.method??null,cashier:p.cashier??null,data:p});
    }
    for(const [index,e] of (x.quantityEdits||[]).entries())tables.quantity_edits.push({id:`legacy:${tid}:${index}`,transaction_id:tid,data:e});
  }
  tables.incoming_stock=list('incoming').map(x=>({id:id(x,'incoming'),product_id:productId(x),qty:num(x,'qty'),purchase_price:num(x,'purchasePrice'),total:num(x,'total'),business_date:date(x.date),supplier:x.supplier??null,data:x}));
  tables.stocktakes=list('stocktakes').map(x=>({id:id(x,'stocktakes'),product_id:productId(x),system_stock:num(x,'systemStock'),physical_stock:num(x,'physicalStock'),difference:num(x,'difference'),business_date:date(x.date),data:x}));
  for(const [k,rows] of Object.entries(tables))for(const r of rows){if(r.amount!=null&&cmp(r.amount,0)<0&&k==='transaction_payments')throw new Error('Negative payment');if(['products','customers','suppliers'].includes(k)&&!r.name)throw new Error('Missing name in '+k);}
  for(const p of tables.products)if(p.cost_price!==null&&cmp(p.cost_price,0)<0)throw new Error('Negative product cost');
  for(const t of tables.transactions)if(cmp(t.total,0)<0)throw new Error('Negative transaction total');
  for(const i of tables.incoming_stock)if(cmp(i.qty,0)<=0||cmp(i.purchase_price,0)<0)throw new Error('Invalid incoming quantity/price');
  for(const s of tables.stocktakes)if(cmp(s.physical_stock,0)<0)throw new Error('Negative stocktake physical stock');
  const config={};for(const k of ['settings','categories','units','paymentMethods','lastBackupAt','schemaVersion'])if(state[k]!==undefined)config[k]=state[k];
  const numericInvoices=[...invoices].filter(x=>/^\d{1,9}$/.test(x)).map(Number),customInvoices=[...invoices].filter(x=>!/^\d{1,9}$/.test(x));
  const invoiceCounter=numericInvoices.length?Math.max(...numericInvoices):-1;
  if(customInvoices.length)warnings.push(`Custom/non-convention invoices preserved: ${customInvoices.join(', ')}`);
  if(dateReview.changed.length)warnings.push(`${dateReview.changed.length} timestamp-derived records differ in Jakarta; policy=${historicalDatePolicy}`);
  const migrationReview={dateReview,invoiceCounter,customInvoices};
  return {format:2,sourceHash:digest(envelope),sourceVersion:envelope.version,sourcePayload:state,config,tables,warnings,migrationReview,invoiceCounter};
}
function metrics(bundle) {
  const t=bundle.tables,received=id=>sum(t.transaction_payments.filter(p=>p.transaction_id===id).map(p=>p.amount));
  return {counts:Object.fromEntries(Object.entries(t).map(([k,v])=>[k,v.length])),latestInvoice:[...t.transactions].sort((a,b)=>(b.occurred_at||'').localeCompare(a.occurred_at||'')||b.invoice.localeCompare(a.invoice))[0]?.invoice??null,
    grandTotal:sum(t.transactions.map(x=>x.total)),received:sum(t.transaction_payments.map(x=>x.amount)),paid:sum(t.transactions.map(x=>cmp(received(x.id),x.total)>0?x.total:received(x.id))),
    unpaid:t.transactions.filter(x=>cmp(x.total,received(x.id))>0).length,stock:Object.fromEntries(t.products.map(x=>[x.id,x.stock])),samples:t.transactions.slice(0,3).map(x=>x.id)};
}
function validate(expected,actual) {
  const errors=[];
  if(expected.sourceHash!==actual.sourceHash||expected.sourceVersion!==actual.sourceVersion)errors.push('Source identity/version mismatch');
  for(const [k,rows] of Object.entries(expected.tables)) {
    const keys=Object.keys(rows[0]||{}),project=x=>Object.fromEntries(keys.map(key=>[key,x[key]]));
    const sorted=xs=>xs.map(x=>JSON.stringify(canonical(project(x)))).sort();
    if(JSON.stringify(sorted(rows))!==JSON.stringify(sorted(actual.tables[k]||[])))errors.push(`Row/financial/stock mismatch: ${k}`);
  }
  if(digest(expected.config)!==digest(actual.config))errors.push('Configuration mismatch');
  if(digest(expected.migrationReview)!==digest(actual.migrationReview))errors.push('Migration policy/counter mismatch');
  if(expected.invoiceCounter!==actual.invoiceCounter)errors.push('Invoice counter mismatch');
  if(errors.length)throw new Error(errors.join('\n'));
  return metrics(actual);
}
const literal=x=>x==null?'NULL':typeof x==='boolean'?String(x):"'"+String(typeof x==='object'?JSON.stringify(x):x).replaceAll("'","''")+"'";
function importSql(bundle) {
  const lines=['-- OFFLINE GENERATED IMPORT. NOT EXECUTED. Review and back up first.','BEGIN;','SET LOCAL standard_conforming_strings=on;','LOCK TABLE public.app_state IN SHARE MODE;','LOCK TABLE cashier.control IN EXCLUSIVE MODE;',
    `DO $$ BEGIN IF (SELECT version FROM public.app_state WHERE id=1) IS DISTINCT FROM ${bundle.sourceVersion} THEN RAISE EXCEPTION 'Legacy version changed'; END IF;`,
    `IF (SELECT mode FROM cashier.control WHERE id=true)<>'legacy' THEN RAISE EXCEPTION 'Import only in frozen legacy maintenance'; END IF;`,
    `IF EXISTS(SELECT 1 FROM cashier.control WHERE source_hash IS NOT NULL AND source_hash<>${literal(bundle.sourceHash)}) THEN RAISE EXCEPTION 'Different migration source'; END IF;`,
    `IF EXISTS(SELECT 1 FROM cashier.operations) THEN RAISE EXCEPTION 'Normalized writes exist'; END IF; END $$;`];
  const sourceTag='$source_'+bundle.sourceHash+'$';
  if(JSON.stringify(bundle.sourcePayload).includes(sourceTag))throw new Error('Unsafe source delimiter');
  lines.push(`DO ${sourceTag} BEGIN IF (SELECT payload FROM public.app_state WHERE id=1) IS DISTINCT FROM ${literal(bundle.sourcePayload)}::jsonb THEN RAISE EXCEPTION 'Legacy payload differs from backup'; END IF;
 IF EXISTS(SELECT 1 FROM cashier.control WHERE source_hash IS NOT NULL AND migration_review<>${literal(bundle.migrationReview)}::jsonb) THEN RAISE EXCEPTION 'Migration decision differs from previous import'; END IF; END ${sourceTag};`);
  for(const [name,rows] of Object.entries(bundle.tables))for(const row of rows){const columns=Object.keys(row);lines.push(`INSERT INTO cashier.${name} (${columns.join(',')}) VALUES (${columns.map(k=>literal(row[k])).join(',')}) ON CONFLICT DO NOTHING;`);}
  // Validate every imported row before recording success; identical restart is safe, divergent conflicts abort.
  for(const [name,rows] of Object.entries(bundle.tables)) {
    const tag='$verify_'+hash(rows)+'$';
    if(JSON.stringify(rows).includes(tag))throw new Error('Unsafe SQL delimiter');
    lines.push(`DO ${tag} DECLARE actual jsonb; BEGIN SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text),'[]') INTO actual FROM (SELECT ${rows.length?Object.keys(rows[0]).join(','):'*'} FROM cashier.${name}) q;`);
    if(rows.length)lines.push(`IF actual IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text) FROM jsonb_populate_recordset(NULL::cashier.${name},${literal(rows)}::jsonb) r CROSS JOIN LATERAL (SELECT ${Object.keys(rows[0]).map(k=>'r.'+k).join(',')}) q) THEN RAISE EXCEPTION 'Validation mismatch ${name}'; END IF;`);
    else lines.push(`IF actual<>'[]'::jsonb THEN RAISE EXCEPTION 'Expected empty ${name}'; END IF;`);
    lines.push(`END ${tag};`);
  }
  lines.push(`UPDATE cashier.control SET source_hash=${literal(bundle.sourceHash)},source_version=${bundle.sourceVersion},config=${literal(bundle.config)}::jsonb,invoice_counter=${bundle.invoiceCounter},migration_review=${literal(bundle.migrationReview)}::jsonb WHERE id=true;`,'COMMIT;');
  return lines.join('\n')+'\n';
}
function exportSql() {
  // Return decimals as strings so node JSON parsing never rounds database NUMERIC.
  const numeric={products:['stock','cost_price'],transactions:['subtotal','discount_amount','discount_percent','tax_percent','tax_amount','total'],transaction_items:['qty','price','discount','cost_price','amount','profit'],transaction_payments:['amount','dashboard_amount'],incoming_stock:['qty','purchase_price','total'],stocktakes:['system_stock','physical_stock','difference'],customers:[],suppliers:[],quantity_edits:[]};
  const entries=Object.entries(numeric).map(([name,cols])=>`'${name}',(SELECT coalesce(jsonb_agg(to_jsonb(r)${cols.length?" || jsonb_build_object("+cols.map(k=>`'${k}',r.${k}::text`).join(',')+")":''}),'[]') FROM cashier.${name} r)`);
  return `-- Read-only validation export, NOT EXECUTED. Save one JSON value, no psql headings.\nSELECT jsonb_build_object('sourceHash',source_hash,'sourceVersion',source_version,'migrationReview',migration_review,'invoiceCounter',invoice_counter,'config',config,'tables',jsonb_build_object(${entries.join(',')})) FROM cashier.control WHERE id=true;\n`;
}
function main(args) {
  const [command,input,output]=args;
  if(command==='export-sql'){fs.writeFileSync(input,exportSql(),{flag:'wx'});return;}
  if(!['dry-run','prepare','validate'].includes(command)||!input)throw new Error('Usage: node scripts/persistence-migrate.js dry-run export.json | prepare export.json NEW-directory | validate expected-bundle.json actual-export.json | export-sql NEW-file.sql');
  const inputText=fs.readFileSync(input,'utf8'),data=JSON.parse(inputText);
  if(command==='validate'){console.log(JSON.stringify(validate(data,JSON.parse(fs.readFileSync(output,'utf8'))),null,2));return;}
  const policy=args.find(x=>x.startsWith('--historical-dates='))?.split('=')[1]||'preserve-legacy';
  const bundle=prepare(data,{historicalDatePolicy:policy});bundle.sourceFileHash=hash(inputText);console.log(JSON.stringify({sourceFileHash:bundle.sourceFileHash,sourceHash:bundle.sourceHash,sourceVersion:bundle.sourceVersion,...metrics(bundle),migrationReview:bundle.migrationReview,warnings:bundle.warnings},null,2));
  if(command==='prepare'){if(!output)throw new Error('New output directory required');fs.mkdirSync(output);fs.writeFileSync(output+'/bundle.json',JSON.stringify(bundle,null,2));fs.writeFileSync(output+'/import.sql',importSql(bundle));fs.writeFileSync(output+'/export.sql',exportSql());}
}
if(require.main===module){try{main(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={prepare,metrics,validate,importSql,exportSql,decimal,add,sub,mul,cmp,digest};
