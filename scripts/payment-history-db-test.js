'use strict';
// Real PostgreSQL contract checks; called only from the disposable-local runner.
const assert=require('node:assert/strict');
module.exports=async function paymentHistoryTypes({sql,value,command,actor}){
 const transaction=(await command('sale',{items:[{productId:'quantity-policy',qty:'1',price:'20',discount:'0'}],paymentMethod:'DP',payment:'1'},'history-type-sale')).transaction;
 for(const [index,amount] of ['2','1.25',0.5].entries()){
  const id=`history-type-pay-${index}`,body={id:transaction.id,amount,method:'Transfer',date:'2026-11-17'};
  const result=await command('payment',body,id);
  const expected=[2,1.25,0.5].slice(0,index+1);
  const check=tx=>{
   assert.deepEqual(tx.paymentHistory.map(p=>p.amount),expected,'API history money must be JSON numbers, not request strings');
   for(const key of ['subtotal','total','cashIn','remaining','refundDue','revision'])assert.equal(typeof tx[key],'number',key);
   assert.equal(typeof tx.items[0].qty,'number');assert.equal(typeof tx.invoice,'string');
  };
  check(result.transaction);assert.equal(typeof result.version,'number');
  assert.deepEqual(await command('payment',body,id),result,'retry preserves numeric response contract');
  check(await value(`SELECT public.cashier_read('transaction','{"id":"${transaction.id}"}','${actor}','normalized');`));
  const page=await value(`SELECT public.cashier_read('transactions','{"search":"${transaction.invoice}"}','${actor}','normalized');`);
  check(page.rows.find(t=>t.id===transaction.id));
  // Confirm reconstruction uses the typed column while preserving raw request JSON.
  const stored=await value(`SELECT jsonb_build_object('amount',amount,'requestAmount',data->'amount') FROM cashier.transaction_payments WHERE id='${id}';`);
  assert.equal(stored.amount,expected[index]);assert.equal(stored.requestAmount,amount);
 }
 // Historical JSON can contain stale strings; never parse it in preference to typed money.
 await sql("UPDATE cashier.transaction_payments SET data=jsonb_set(data,'{amount}','\"999\"') WHERE id='history-type-pay-0';");
 const reconstructed=await value(`SELECT cashier.transaction_json('${transaction.id}');`);
 assert.deepEqual(reconstructed.paymentHistory.map(p=>p.amount),[2,1.25,0.5]);
 console.log('REAL PostgreSQL payment-history JSON types, fractional amounts, reads and idempotent responses passed.');
};
