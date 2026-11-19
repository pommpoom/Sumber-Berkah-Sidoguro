'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {prepare,metrics,validate,importSql,add,mul}=require('./persistence-migrate');
const fixture=require('./persistence-fixture');
const {businessDate}=require('./business-date');
test('Jakarta boundaries and explicit historical migration date policy',()=>{
 for(const [iso,day] of [['2026-11-16T16:59:00Z','2026-11-16'],['2026-11-16T17:00:00Z','2026-11-17'],['2026-11-16T17:30:00Z','2026-11-17'],['2026-11-16T23:59:00Z','2026-11-17'],['2026-11-17T00:00:00Z','2026-11-17']])assert.equal(businessDate(iso),day);
 const input=fixture();input.payload.transactions[0].createdAt='2026-11-16T17:30:00Z';const preserved=prepare(input),jakarta=prepare(input,{historicalDatePolicy:'jakarta'});
 assert.equal(preserved.tables.transactions[0].business_date,'2026-11-16');assert.equal(jakarta.tables.transactions[0].business_date,'2026-11-17');assert.equal(jakarta.tables.transaction_payments[0].business_date,'2026-11-17');assert.equal(jakarta.tables.transaction_payments[1].business_date,'2026-10-23','explicit settlement date remains unchanged');
 assert.equal(preserved.migrationReview.dateReview.changed.length,1);assert.equal(preserved.migrationReview.dateReview.changed[0].selected,'2026-11-16');assert.equal(jakarta.tables.transactions[0].occurred_at,input.payload.transactions[0].createdAt);
 input.payload.transactions[0].createdAt='2026-11-17 00:30:00';assert.equal(prepare(input).migrationReview.dateReview.ambiguous.length,1);assert.throws(()=>prepare(input,{historicalDatePolicy:'jakarta'}),/explicit UTC offset/);
});
test('invoice migration seeds max 1–9 digit sequence and retains custom invoices exactly',()=>{
 const input=fixture();for(const [id,invoice] of [['t2','000975'],['t3','CUSTOM/A'],['t4','1000000000']])input.payload.transactions.push({...structuredClone(input.payload.transactions[0]),id,invoice});
 const b=prepare(input);assert.equal(b.invoiceCounter,975);assert.deepEqual(b.tables.transactions.map(t=>t.invoice),['959','000975','CUSTOM/A','1000000000']);assert.deepEqual(b.migrationReview.customInvoices,['CUSTOM/A','1000000000']);assert.match(importSql(b),/invoice_counter=975/);assert.deepEqual(prepare(input),b);
 const wrong=structuredClone(b);wrong.invoiceCounter=0;assert.throws(()=>validate(b,wrong),/Invoice counter/);
 const empty=fixture();empty.payload.transactions=[];assert.equal(prepare(empty).invoiceCounter,-1);
});
test('migration preserves counts, money, stock, snapshots and DP history',()=>{
 const input=fixture(),b=prepare(input),m=metrics(b);
 assert.equal(m.counts.transactions,1);assert.equal(m.counts.transaction_items,1);assert.equal(m.counts.incoming_stock,1);assert.equal(m.counts.stocktakes,1);assert.equal(m.counts.products,1);
 assert.equal(m.grandTotal,'24');assert.equal(m.received,'12.25');assert.equal(m.unpaid,1);assert.equal(m.stock.p,'7.5');assert.equal(m.latestInvoice,'959');
 assert.equal(b.tables.transaction_items[0].cost_price,'2');assert.equal(b.tables.transaction_items[0].name,'Old product name');
 assert.deepEqual(b.tables.transaction_payments[1].data,input.payload.transactions[0].paymentHistory[0]);
 assert.deepEqual(validate(b,structuredClone(b)),m);assert.deepEqual(prepare(input),b);
 const sql=importSql(b);assert.match(sql,/ON CONFLICT DO NOTHING/);assert.match(sql,/Validation mismatch/);assert.match(sql,/Legacy version changed/);assert.doesNotMatch(sql,/DELETE|TRUNCATE|UPDATE public.app_state/);
});
test('validation refuses count, stock, money, payment and source divergence',()=>{
 const b=prepare(fixture());
 for(const mutate of [x=>x.tables.products[0].stock='8',x=>x.tables.transactions[0].total='25',x=>x.tables.transaction_payments.pop(),x=>x.tables.transaction_items.pop(),x=>x.sourceVersion++]){const other=structuredClone(b);mutate(other);assert.throws(()=>validate(b,other));}
});
test('migration reports missing fields/orphans without inventing dates or product identity',()=>{
 const x=fixture();delete x.payload.transactions[0].createdAt;delete x.payload.transactions[0].items[0].costPrice;x.payload.transactions[0].items[0].productId='deleted';
 const b=prepare(x);assert.equal(b.tables.transaction_items[0].product_id,null);assert.equal(b.tables.transaction_items[0].cost_price,null);assert.equal(b.tables.transactions[0].business_date,null);assert.ok(b.warnings.length>=3);
});
test('decimal arithmetic and historical stored values are exact',()=>{
 assert.equal(add('0.1','0.2'),'0.3');assert.equal(mul('2.5','9.6'),'24');assert.equal(add('9007199254740993','0.01'),'9007199254740993.01');
 const x=fixture();x.payload.transactions[0].items[0].amount=24.000000000000004;
 const b=prepare(x);assert.equal(b.tables.transaction_items[0].amount,'24.000000000000004');assert.ok(b.warnings.some(x=>x.includes('preserved')));
});
test('invalid and duplicate data fail before SQL generation; SQL strings are quoted',()=>{
 const x=fixture();x.payload.transactions.push(structuredClone(x.payload.transactions[0]));assert.throws(()=>prepare(x),/Duplicate/);
 const y=fixture();y.payload.products[0].stock=Number.MAX_SAFE_INTEGER+1;assert.throws(()=>prepare(y),/Unsafe/);
 const z=fixture();z.payload.products[0].name="O'Brien $verify$; DROP TABLE x;";const sql=importSql(prepare(z));assert.match(sql,/O''Brien/);assert.match(sql,/DO \$verify_[a-f0-9]+\$/);
});
