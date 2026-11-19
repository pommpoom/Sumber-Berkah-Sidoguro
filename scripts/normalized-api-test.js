'use strict';
const assert=require('node:assert/strict');
const jwt=require('jsonwebtoken');
Object.assign(process.env,{JWT_SECRET:'local-test-only-secret-longer-than-32-characters',SUPABASE_URL:'https://database.example.test',SUPABASE_SECRET_KEY:'test',CORS_ORIGIN:'https://cashier.example.test',INITIAL_ADMIN_USERNAME:'ADMIN',INITIAL_ADMIN_PASSWORD:'local-test-password',NODE_ENV:'production',PERSISTENCE_MODE:'normalized'});
global.fetch=async()=>{throw new Error('External network prohibited')};
const users=['ADMINISTRATOR','KASIR'].map((role,i)=>({id:String(i),username:i?'CASHIER':'ADMIN',role,active:true,password_changed_at:'2026-01-01T00:00:00.000Z'}));
const calls=[];let rpcError=null;
const modulePath=require.resolve('@supabase/supabase-js');require(modulePath);
require.cache[modulePath].exports={createClient:()=>({from(table){assert.equal(table,'app_users','normalized routes must not read app_state');let id;return {select(){return this},eq(k,v){if(k==='id')id=v;return this},async maybeSingle(){return {data:users.find(x=>x.id===id)||users[0]}}}},async rpc(name,args){calls.push({name,args});if(rpcError)return {error:rpcError};return {data:name==='cashier_command'?{transaction:{id:'t',items:[{costPrice:2,profit:3}]},products:[{id:'p',stock:9,costPrice:2}]}:args.p_kind==='dashboard'?{count:959,sales:123456,profit:3456,days:[{sales:99,profit:7}],recent:[{cost_price:4,items:[{costPrice:2,grossProfit:5}]}]}:args.p_kind==='transactions'?{rows:[{id:'t',items:[{costPrice:2,profit:3}]}],page:2,limit:10,total:959,pages:96}:{version:1}}}})};
const {handler}=require('../netlify/functions/api');
async function invoke(path,method='GET',body,role='ADMINISTRATOR',key='operation-123',query={}){
 const u=users.find(x=>x.role===role),token=jwt.sign({sub:u.id,pwd:u.password_changed_at},process.env.JWT_SECRET);
 const r=await handler({path,httpMethod:method,headers:{host:'cashier.example.test','content-type':'application/json',cookie:`kasir_session=${token}`,'idempotency-key':key,'x-nf-client-connection-ip':'192.0.2.70'},body:body===undefined?'':JSON.stringify(body),queryStringParameters:query,requestContext:{}},{});
 return {status:r.statusCode,body:JSON.parse(r.body)};
}
async function main(){
 const sale={items:[{productId:'p',qty:'1.5',price:'10',discount:'0'}],payment:'15',paymentMethod:'Tunai'};
 let r=await invoke('/api/transactions','POST',sale,'KASIR');assert.equal(r.status,200);assert.equal(calls.at(-1).args.p_actor,'1');assert.equal(calls.at(-1).args.p_operation,'operation-123');assert.equal(r.body.products[0].costPrice,undefined);assert.equal(r.body.transaction.items[0].profit,undefined);
 assert.equal((await invoke('/api/transactions','POST',{...sale,transactions:[]},'KASIR')).status,400);
 assert.equal((await invoke('/api/transactions','POST',sale,'KASIR','')).status,400);
 for(const [path,method] of [['/api/incoming','POST'],['/api/stocktakes','POST'],['/api/transactions/t/items','PATCH'],['/api/products','POST'],['/api/configuration','PUT']]){
  const count=calls.length;assert.equal((await invoke(path,method,{},'KASIR')).status,403);assert.equal(calls.length,count);
  assert.equal((await invoke(path,method,{},'ADMINISTRATOR')).status,200);
 }
 assert.equal((await invoke('/api/transactions/t/payments','POST',{amount:'5',method:'Tunai',date:'2026-10-22'},'KASIR')).status,200);
 assert.equal(calls.at(-1).args.p_body.id,'t');
 r=await invoke('/api/transactions','GET',undefined,'KASIR','operation-123',{page:'2',limit:'10',search:'959',date:'2026-10-22',paymentMethod:'DP'});assert.equal(r.status,200);assert.equal(r.body.total,959);assert.equal(r.body.rows.length,1);assert.equal(calls.at(-1).args.p_query.page,'2');assert.equal(calls.at(-1).args.p_query.paymentMethod,'DP');
 assert.equal((await invoke('/api/transactions','GET',undefined,'KASIR','operation-123',{limit:'10000'})).status,400);
 for(const role of ['KASIR','ADMINISTRATOR']){const dashboard=await invoke('/api/dashboard','GET',undefined,role,'operation-123',{expectedRevision:'2'});assert.equal(dashboard.status,200);assert.equal(dashboard.body.sales,123456);assert.equal(dashboard.body.count,959);assert.equal(calls.at(-1).args.p_query.expectedRevision,'2');if(role==='KASIR')assert.doesNotMatch(JSON.stringify(dashboard.body),/cost.?price|profit/i);else assert.equal(dashboard.body.profit,3456);}
 for(const [code,status] of [['23502',400],['23503',409],['23514',400],['22003',400],['40001',409],['22008',400]]){rpcError={code,message:'test input rejection'};assert.equal((await invoke('/api/transactions','POST',sale)).status,status);}
 rpcError={code:'23505',message:'Idempotency key reused'};assert.equal((await invoke('/api/transactions','POST',sale)).status,409);rpcError={code:'22023',message:'Insufficient stock'};assert.equal((await invoke('/api/transactions','POST',sale)).status,400);rpcError=null;
 assert.equal((await invoke('/api/state','PUT',{state:{},expectedVersion:1})).status,409);assert.equal((await invoke('/api/state')).status,409);
 process.env.PERSISTENCE_MODE='normalized-read';assert.equal((await invoke('/api/transactions','POST',sale)).status,503);assert.equal((await invoke('/api/transactions')).status,200);
 process.env.PERSISTENCE_MODE='legacy';assert.equal((await invoke('/api/transactions','POST',sale)).status,404);
 console.log('Normalized HTTP contracts, role enforcement, redaction, mode fencing, pagination and bounded requests passed (RPC stub; not database integration).');
}
main().catch(e=>{console.error(e);process.exitCode=1});
