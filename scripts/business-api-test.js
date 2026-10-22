const assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
Object.assign(process.env,{
  JWT_SECRET:'test-only-secret-that-is-at-least-32-characters',SUPABASE_URL:'https://database.example.test',
  SUPABASE_SECRET_KEY:'test-only-key',CORS_ORIGIN:'https://cashier.example.test',INITIAL_ADMIN_USERNAME:'ADMIN',
  INITIAL_ADMIN_PASSWORD:'test-password',NODE_ENV:'production',STATE_JSON_LIMIT_KB:'1536'
});
global.fetch=async()=>{throw new Error('Real database/network prohibited')};
const users=['ADMINISTRATOR','KASIR'].map((role,index)=>({id:String(index),username:index?'CASHIER':'ADMIN',role,active:true,password_changed_at:'2026-01-01T00:00:00.000Z',password_hash:bcrypt.hashSync('test-password',4)}));
let state={products:[{id:'p',stock:20,costPrice:4,trackStock:true},{id:'service',stock:0,trackStock:false}],suppliers:[],customers:[],transactions:[],incoming:[],stocktakes:[]},version=1;
const updates=[];
const modulePath=require.resolve('@supabase/supabase-js');require(modulePath);
require.cache[modulePath].exports={createClient:()=>({
  from(table){
    const filters={};let change;
    return {select(){return this},eq(key,value){filters[key]=value;return this},update(value){change=value;return this},
      async maybeSingle(){
        const result=table==='app_users'?users.find(user=>Object.entries(filters).every(([key,value])=>user[key]===value)):{payload:structuredClone(state),version};
        if(change){updates.push({id:filters.id,change});}
        return {data:result,error:null};
      },async single(){return this.maybeSingle()}
    };
  },
  async rpc(name,args){assert.equal(name,'save_app_state');if(args.p_expected_version!==version)return {data:[],error:null};state=structuredClone(args.p_payload);version++;return {data:[{version,updated_at:new Date().toISOString()}],error:null}}
})};
const {handler}=require('../netlify/functions/api');
const invoke=async(path,role='ADMINISTRATOR',body,method='PUT')=>{
  const user=users.find(user=>user.role===role),token=jwt.sign({sub:user.id,pwd:user.password_changed_at},process.env.JWT_SECRET);
  const result=await handler({path,httpMethod:method,headers:{host:'cashier.example.test','content-type':'application/json',cookie:`kasir_session=${token}`,'x-nf-client-connection-ip':'192.0.2.60'},body:body===undefined?'':JSON.stringify(body),queryStringParameters:{},requestContext:{}},{});
  return {status:result.statusCode,body:JSON.parse(result.body)};
};
async function run(){
  assert.equal((await invoke('/api/users/me/password','KASIR',{oldPassword:'test-password',newPassword:'new-password'})).status,403);
  assert.equal((await invoke('/api/users/me/password','ADMINISTRATOR',{oldPassword:'wrong',newPassword:'new-password'})).status,400);
  assert.equal((await invoke('/api/users/me/password','ADMINISTRATOR',{oldPassword:'test-password',newPassword:'new-password'})).status,200);
  assert.equal(updates.at(-1).id,'0','self route must target real user, not literal me');
  assert.ok(await bcrypt.compare('new-password',updates.at(-1).change.password_hash));
  assert.equal((await invoke('/api/users/1/password','ADMINISTRATOR',{password:'reset-password'})).status,200);
  assert.equal(updates.at(-1).id,'1');
  const transaction={id:'tx',invoice:'1',saveOperationId:'op',paymentMethod:'DP',downPayment:20,payment:20,cashIn:20,total:100,remaining:80,items:[{productId:'p',qty:10,price:10,discount:0}]};
  let submitted=structuredClone(state);submitted.transactions.push(transaction);
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:version})).status,200);
  assert.equal(state.products[0].stock,10);
  let loaded=await invoke('/api/state','KASIR',undefined,'GET');assert.equal(loaded.body.state.transactions.length,1);assert.equal(loaded.body.state.products[0].stock,10);
  assert.equal(loaded.body.state.products[0].costPrice,undefined);
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:1})).status,409);assert.equal(state.transactions.length,1);assert.equal(state.products[0].stock,10);
  submitted=structuredClone(loaded.body.state);submitted.transactions[0].items[0].qty=5;
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:version})).status,403);
  state.transactions[0].remaining=0; // Legacy stale derived field must not silently discard a real payment.
  submitted=structuredClone(loaded.body.state);submitted.transactions[0].paymentHistory=[{id:'pay',amount:80,date:'2026-10-22',method:'Tunai'}];
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:version})).status,200);
  assert.equal(state.transactions[0].remaining,0);assert.equal(state.transactions[0].paymentHistory.length,1);
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:version})).status,200);assert.equal(state.transactions[0].paymentHistory.length,1);
  submitted.transactions[0].paymentHistory.push({id:'extra',amount:1,date:'2026-10-22',method:'Tunai'});
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:version})).status,400);
  submitted=structuredClone(state);submitted.transactions.push({...transaction,id:'oversold',invoice:'2',items:[{productId:'p',qty:11,price:10}]});
  assert.equal((await invoke('/api/state','KASIR',{state:submitted,expectedVersion:version})).status,400);assert.equal(state.products[0].stock,10);
  submitted=structuredClone(state);submitted.incoming.push({id:'incoming',saveOperationId:'incoming-op',productId:'p',qty:3});submitted.products[0].stock+=3;
  const oldVersion=version;
  assert.equal((await invoke('/api/state','ADMINISTRATOR',{state:submitted,expectedVersion:version})).status,200);
  loaded=await invoke('/api/state','ADMINISTRATOR',undefined,'GET');assert.equal(loaded.body.state.incoming.length,1);assert.equal(loaded.body.state.products[0].stock,13);
  assert.equal((await invoke('/api/state','ADMINISTRATOR',{state:submitted,expectedVersion:oldVersion})).status,409);
  assert.equal(state.incoming.length,1);assert.equal(state.products[0].stock,13);
  console.log('Business API: password roles/routes, persistence, stock, CAS conflicts and duplicate payments passed (stub database).');
}
run().catch(error=>{console.error(error);process.exitCode=1});
