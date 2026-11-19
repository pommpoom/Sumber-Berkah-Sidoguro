'use strict';
// Real PostgreSQL assertions, called only by the guarded disposable-local runner.
const assert=require('node:assert/strict');
module.exports=async function quantityRecalculation({sql,value,command}){
 await sql(`INSERT INTO cashier.products(id,name,stock,cost_price,track_stock,data) VALUES('quantity-policy','Quantity fixture',100,2,true,'{"id":"quantity-policy","active":true}');`);
 const configuration=method=>sql(`UPDATE cashier.control SET config=jsonb_set(jsonb_set(config,'{settings,discountMethod}','"${method}"'),'{settings,taxPercent}','10');`);
 const payments=id=>sql(`SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)::text FROM cashier.transaction_payments p WHERE p.transaction_id='${id}';`);
 const check=async(tx,expected)=>{
  for(const [key,number] of Object.entries(expected))assert.equal(tx[key],number,key);
  const stored=await value(`SELECT jsonb_build_object('subtotal',subtotal,'discountAmount',discount_amount,'discountPercent',discount_percent,'taxAmount',tax_amount,'total',total,'revision',revision) FROM cashier.transactions WHERE id='${tx.id}';`);
  for(const [key,number] of Object.entries(stored))assert.equal(tx[key],number,`stored ${key}`);
 };
 const saleBody={items:[{productId:'quantity-policy',qty:'2',price:'20',discount:'5'}],discount:'10',payment:'100',paymentMethod:'Tunai'};
 await configuration('Nominal');
 const nominal=(await command('sale',saleBody,'quantity-nominal-sale')).transaction;
 await check(nominal,{subtotal:30,discountAmount:10,taxAmount:2,total:22,payment:100,change:78,cashIn:22,remaining:0,refundDue:0});
 const originalPayments=await payments(nominal.id);
 // Editing uses historical transaction tax/discount, even after current settings change.
 await configuration('Persen');
 const downBody={id:nominal.id,revision:1,quantities:['1']};
 const down=await command('quantity',downBody,'quantity-nominal-down');
 await check(down.transaction,{subtotal:15,discountAmount:10,taxAmount:0.5,total:5.5,payment:100,change:78,cashIn:22,remaining:0,refundDue:16.5,revision:2});
 assert.equal(down.transaction.items[0].amount,15);assert.equal(down.transaction.items[0].profit,13);
 const stockAfter=await sql("SELECT stock FROM cashier.products WHERE id='quantity-policy'");
 assert.deepEqual(await command('quantity',downBody,'quantity-nominal-down'),down);assert.equal(await sql("SELECT stock FROM cashier.products WHERE id='quantity-policy'"),stockAfter);
 const up=(await command('quantity',{id:nominal.id,revision:2,quantities:['3']},'quantity-nominal-up')).transaction;
 await check(up,{subtotal:45,discountAmount:10,taxAmount:3.5,total:38.5,cashIn:22,remaining:16.5,refundDue:0,revision:3});
 const capped=(await command('quantity',{id:nominal.id,revision:3,quantities:['0.5']},'quantity-nominal-cap')).transaction;
 await check(capped,{subtotal:7.5,discountAmount:7.5,discountPercent:100,taxAmount:0,total:0,cashIn:22,remaining:0,refundDue:22,revision:4});
 const afterCap=(await command('quantity',{id:nominal.id,revision:4,quantities:['2']},'quantity-after-cap')).transaction;
 await check(afterCap,{subtotal:30,discountAmount:7.5,taxAmount:2.25,total:24.75,remaining:2.75,refundDue:0,revision:5});
 assert.equal(await payments(nominal.id),originalPayments,'quantity edits must not rewrite retained payments');
 const percent=(await command('sale',{...saleBody,discount:'25',payment:'5',paymentMethod:'DP'},'quantity-percent-sale')).transaction;
 const paid=await command('payment',{id:percent.id,amount:'2',method:'Transfer',date:'2026-11-17'},'quantity-percent-pay');
 assert.equal(paid.transaction.paymentHistory[0].amount,2,'payment command returns numeric history amount for string decimal input');
 const retained=await payments(percent.id);
 await configuration('Nominal');
 const percentDown=(await command('quantity',{id:percent.id,revision:2,quantities:['1']},'quantity-percent-down')).transaction;
 await check(percentDown,{subtotal:15,discountAmount:3.75,discountPercent:25,taxAmount:1.125,total:12.375,payment:5,downPayment:5,cashIn:5,remaining:5.375,refundDue:0,revision:3});
 const percentRefund=(await command('quantity',{id:percent.id,revision:3,quantities:['0.5']},'quantity-percent-refund')).transaction;
 await check(percentRefund,{subtotal:7.5,discountAmount:1.875,discountPercent:25,taxAmount:0.5625,total:6.1875,remaining:0,refundDue:0.8125,revision:4});
 assert.equal(await payments(percent.id),retained);assert.equal(percentRefund.paymentHistory.length,1);assert.equal(percentRefund.paymentHistory[0].amount,2,'quantity response retains numeric settlement history amount');
 console.log('REAL PostgreSQL quantity recalculation: nominal/percentage discounts, tax, fractional edits, retained payments, refunds and idempotency passed.');
};
