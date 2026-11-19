const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require.resolve('../assets/js/app.js'), 'utf8');
const seed = fs.readFileSync(require.resolve('../assets/js/seed-data.js'), 'utf8');
const reply = (body, status=200) => new Response(JSON.stringify(body), {status});
const deferred = () => { let resolve,reject; const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}; };
const settle = () => new Promise(resolve=>setImmediate(resolve));

function browser(storage=new Map()) {
  const nodes=new Map(),timers=new Map(),requests=[],replies=[],messages=[];
  let timerId=0;
  const node = id => {
    if(!nodes.has(id)) nodes.set(id,{
      value:'',dataset:{},hidden:false,innerHTML:'',textContent:'',tagName:'INPUT',options:[],
      classList:{contains:()=>false,add(){},remove(){},toggle(){}},
      toggleAttribute(){},querySelector:child=>node(id+' '+child),closest:()=>node('parent'),
      reset(){this.resets=(this.resets||0)+1;},focus(){}
    });
    return nodes.get(id);
  };
  const context=vm.createContext({
    location:{hostname:'cashier.test',port:'',protocol:'https:'},
    document:{visibilityState:'visible',querySelector:node,querySelectorAll:()=>[]},
    window:{},navigator:{onLine:true},crypto:require('node:crypto').webcrypto,
    localStorage:{get length(){return storage.size},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    AbortController,AbortSignal:{timeout:AbortSignal.timeout.bind(AbortSignal),any:AbortSignal.any.bind(AbortSignal)},Blob,URLSearchParams,Option:class {},
    setTimeout(callback,delay){timers.set(++timerId,{callback,delay});return timerId},clearTimeout(id){timers.delete(id)},
    confirm:()=>true,
    async fetch(url,options){if(options?.headers?.['Idempotency-Key']){const persisted=[...storage.values()].flatMap(value=>{try{return [JSON.parse(value)]}catch{return []}}).find(x=>x.id===options.headers['Idempotency-Key']);assert.ok(persisted,'durable record must exist before fetch');assert.equal(persisted.body,options.body);}requests.push({url,...options});if(url.endsWith('/auth/logout'))return reply({ok:true});assert.ok(replies.length,`Unexpected request ${url}`);return replies.shift()},
    recordMessage:message=>messages.push(message)
  });
  const run=code=>vm.runInContext(code,context);
  run(seed+'\n'+source.slice(0,source.indexOf('document.addEventListener("submit"')));
  run(`
    const realRenderAll=renderAll,realRenderCashier=renderCashier,realPrintDocument=printDocument;
    renderAll=()=>{};goPage=()=>{};printDocument=()=>{};toast=recordMessage;
    sessionUser={id:'admin',username:'ADMIN',level:'ADMINISTRATOR'};apiToken='cookie';sessionGeneration=1;
    state.products=[{id:'p',name:'PRODUCT',active:true,trackStock:true,stock:20,costPrice:4,retailPrice:10,wholesalePrice:10,unit:'Pcs'}];
    state.currentUser='ADMIN';serverStateVersion=1;lastSyncedState=statePayload();
    cart=[{productId:'p',lineId:'line',name:'PRODUCT',qty:2,price:10,discount:0,costPrice:4,amount:20,profit:12}];
  `);
  node('#cashInvoice').value='1';node('#cashPaymentMethod').value='Tunai';node('#cashPayment').value='20';
  node('#incomingProduct').value='PRODUCT';node('#incomingSupplier').value='Supplier';node('#incomingQty').value='3';node('#incomingPrice').value='8';node('#incomingDate').value='2026-10-22';
  return {run,node,requests,replies,timers,messages,context,storage};
}

const dashboardFixture=()=>({count:959,sales:123456,profit:3456,moneyIn:100000,payments:{Tunai:100000},receivable:23456,unpaidCount:20,recent:[],days:[{label:'17/11',sales:123456,profit:3456}],topProducts:[]});
function queueRead(b,{version=2,admin=false,transaction,settings,historyTotal=960,incomingTotal=515,stockTotal=8}={}){
 b.replies.push(reply({state:{products:[],customers:[],suppliers:[],transactions:[],incoming:[],stocktakes:[],...(settings?{settings}:{})},version}),reply({rows:transaction?[transaction]:[],page:1,total:historyTotal,pages:Math.ceil(historyTotal/10)}),reply(dashboardFixture()));
 if(admin)b.replies.push(reply({rows:[{id:'new-incoming'}],total:incomingTotal,pages:26,summary:{qty:100,total:999}}),reply({rows:[{id:'new-stocktake'}],total:stockTotal,pages:1,summary:{positive:3,negative:-1,difference:2}}));
}

test('normalized sale sends only this operation, waits for ack and ignores double submit',async()=>{
  const b=browser(),slow=deferred();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');b.replies.push(slow.promise);
  b.run('saveTransaction()');b.run('saveTransaction()');assert.equal(b.requests.length,1);
  const req=b.requests[0],body=JSON.parse(req.body);assert.ok(req.url.endsWith('/transactions'));assert.equal(req.method,'POST');assert.equal(body.items.length,1);assert.equal(body.transactions,undefined);assert.equal(body.state,undefined);assert.ok(Buffer.byteLength(req.body)<1024);assert.equal(b.run('cart.length'),1);
  queueRead(b);
  slow.resolve(reply({version:2,transaction:{id:'new',invoice:'N-1',total:20,cashIn:20,paymentMethod:'Tunai',items:body.items},products:[{id:'p',stock:18}]}));await settle();await settle();
  assert.equal(b.run('cart.length'),0);assert.equal(b.run('criticalSave'),null);assert.equal(b.run('selectedPrintInvoice'),'N-1');assert.ok(b.requests.every(r=>!r.url.endsWith('/state')));
});
test('normalized lost acknowledgement retries the exact body and operation ID',async()=>{
  const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');b.replies.push(Promise.reject(new TypeError('lost response')));
  b.run('saveTransaction()');await settle();assert.equal(b.run('cart.length'),1);assert.ok(b.run('criticalSave'));
  b.replies.push(reply({version:2,transaction:{id:'same',invoice:'961',total:20,cashIn:20,items:[]},products:[]}));queueRead(b);b.run('retryCriticalSave()');await settle();
  assert.equal(b.requests[0].body,b.requests[1].body);assert.equal(b.requests[0].headers['Idempotency-Key'],b.requests[1].headers['Idempotency-Key']);assert.equal(b.run('criticalSave'),null);
});
test('normalized validation error preserves draft; read-only blocks all commands',async()=>{
  const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');b.replies.push(reply({message:'Insufficient stock'},400));b.run('saveTransaction()');await settle();
  assert.equal(b.run('cart.length'),1);assert.equal(b.run('criticalSave'),null);assert.match(b.node('#saveStatus span').textContent,/Insufficient stock/);
  b.run('persistenceMode="normalized-read";saveTransaction()');assert.equal(b.requests.length,1);
});
test('normalized history boot uses bounded page APIs without app_state',async()=>{
  const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR";transactionPage=2');
  b.replies.push(reply({state:{products:[],customers:[],suppliers:[],transactions:[],incoming:[],stocktakes:[]},version:2}),reply({rows:[{id:'page2'}],page:2,total:959,pages:96}),reply(dashboardFixture()));
  const data=await b.run('getNormalizedState()');assert.equal(data.state.transactions.length,1);assert.equal(b.requests.length,3);assert.match(b.requests[1].url,/page=2&limit=10&expectedRevision=2/);assert.ok(b.requests.every(r=>!r.url.includes('/state')));
});

test('KASIR dashboard uses aggregate totals beyond the history page and hides all profit UI',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');queueRead(b,{transaction:{id:'one',invoice:'960',total:20,items:[]}});
 const boot=await b.run('getNormalizedState()');b.context.boot=boot;b.run('state=migrateState(boot.state);applyNormalizedRead(boot);renderDashboard()');
 assert.equal(b.run('state.transactions.length'),1);assert.match(b.node('#dashboardKpis').innerHTML,/959 transaksi/);assert.match(b.node('#dashboardKpis').innerHTML,/123\.456/);
 assert.doesNotMatch(b.node('#dashboardKpis').innerHTML,/Laba Kotor/);assert.doesNotMatch(b.node('#dashboardChart').innerHTML,/profit|Laba Kotor/);
 b.run('sessionUser.level="ADMINISTRATOR";renderDashboard()');assert.match(b.node('#dashboardChart').innerHTML,/profit-bar/);assert.match(b.node('#dashboardKpis').innerHTML,/Laba Kotor/);
});
test('Jakarta business-day boundaries do not depend on the device timezone',()=>{
 const b=browser();for(const [iso,day] of [['2026-11-16T16:59:00Z','2026-11-16'],['2026-11-16T17:00:00Z','2026-11-17'],['2026-11-16T17:30:00Z','2026-11-17'],['2026-11-16T23:59:00Z','2026-11-17'],['2026-11-17T00:00:00Z','2026-11-17']])assert.equal(b.run(`businessDate(${JSON.stringify(iso)})`),day);
 assert.equal(b.run('transactionBusinessDate({businessDate:"2026-11-17",createdAt:"2026-11-16T17:30:00Z"})'),'2026-11-17');
});
test('durable command survives lost acknowledgement and fresh-page login, retaining exact ID/body',async()=>{
 const storage=new Map(),first=browser(storage),lost=deferred();first.run('persistenceMode="normalized";sessionUser.level="KASIR"');first.replies.push(lost.promise);first.run('saveTransaction()');
 assert.equal(storage.size,1,'must persist before HTTP completes');const pending=JSON.parse([...storage.values()][0]);assert.deepEqual(Object.keys(pending).sort(),['actor','body','id','method','path','timestamp']);assert.equal(pending.body,first.requests[0].body);assert.equal(pending.id,first.requests[0].headers['Idempotency-Key']);assert.doesNotMatch(JSON.stringify(pending),/cookie|password|jwt|secret/i);
 lost.reject(new TypeError('ack lost'));await settle();assert.equal(storage.size,1);
 const fresh=browser(storage);fresh.run('showApp=()=>{}');queueRead(fresh);
 fresh.replies.push(reply({version:2,transaction:{id:'saved',invoice:'960',total:20,items:[]},products:[]}));queueRead(fresh);
 await fresh.run('activateSession({id:"admin",username:"ADMIN",level:"KASIR",persistenceMode:"normalized"})');await settle();await settle();
 const retry=fresh.requests.find(r=>r.method==='POST');assert.equal(retry.body,pending.body);assert.equal(retry.headers['Idempotency-Key'],pending.id);assert.equal(storage.size,0);assert.equal(fresh.run('selectedPrintInvoice'),'960');
});
test('different actor cannot replay pending command; explicit logout retains ambiguous operation',async()=>{
 const storage=new Map(),b=browser(storage);b.run('persistenceMode="normalized";sessionUser.level="KASIR"');b.replies.push(Promise.reject(new TypeError('offline')));b.run('saveTransaction()');await settle();await b.run('logout()');assert.equal(storage.size,1);
 const other=browser(storage);other.run('persistenceMode="normalized";sessionUser.id="other"');assert.equal(other.run('recoverPendingOperation()'),false);assert.equal(other.requests.length,0);assert.equal(storage.size,1);
 other.run('sessionUser.id="admin";persistenceMode="normalized-read"');assert.equal(other.run('recoverPendingOperation()'),false);assert.equal(other.requests.length,0);
});
test('durable storage failures and credentials block sending; definitive rejection clears pending',async()=>{
 const b=browser();b.run('persistenceMode="normalized";localStorage.setItem=()=>{throw new Error("quota")};saveTransaction()');assert.equal(b.requests.length,0);assert.equal(b.run('cart.length'),1);
 const c=browser();c.run('persistenceMode="normalized";normalizedOperation("/transactions","POST",{password:"forbidden"},()=>{})');assert.equal(c.storage.size,0);assert.equal(c.requests.length,0);
 const d=browser();d.run('persistenceMode="normalized"');d.replies.push(reply({message:'Rejected'},400));d.run('saveTransaction()');await settle();assert.equal(d.storage.size,0);assert.equal(d.run('cart.length'),1);
});
test('failed durable cleanup does not cause an automatic retry loop',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR";localStorage.removeItem=()=>{throw new Error("storage unavailable")}');
 b.replies.push(reply({version:2,transaction:{id:'saved',invoice:'960',total:20,items:[]},products:[]}));queueRead(b);b.run('saveTransaction()');await settle();await settle();
 assert.equal(b.storage.size,1);assert.equal(b.requests.filter(r=>r.method==='POST').length,1);assert.equal(b.run('criticalSave'),null);
});
test('incomplete acknowledgement retains the durable command and draft',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');b.replies.push(reply({version:2}));b.run('saveTransaction()');await settle();assert.equal(b.storage.size,1);assert.equal(b.run('cart.length'),1);assert.ok(b.run('criticalSave'));assert.match(b.node('#saveStatus span').textContent,/Konfirmasi server tidak lengkap/);
});
test('revision conflict retries the whole bounded read set without publishing mixed metadata',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');
 b.replies.push(reply({state:{},version:2}),reply({message:'Read revision changed'},409),reply({...dashboardFixture(),sales:1}));queueRead(b,{version:3,historyTotal:961});
 const boot=await b.run('getNormalizedState()');assert.equal(boot.version,3);assert.equal(b.run('normalizedDashboard'),null,'reads do not publish metadata before state acceptance');b.context.boot=boot;b.run('applyNormalizedRead(boot)');assert.equal(b.run('normalizedHistory.total'),961);assert.equal(b.run('normalizedDashboard.sales'),123456);assert.equal(b.requests.length,6);assert.match(b.requests[1].url,/expectedRevision=2/);assert.match(b.requests[4].url,/expectedRevision=3/);
});
test('continuous revision conflicts stop after three read attempts',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');for(let i=0;i<3;i++)b.replies.push(reply({state:{},version:i+2}),reply({message:'changed'},409),reply(dashboardFixture()));
 await assert.rejects(b.run('getNormalizedState()'),/changed/);assert.equal(b.requests.length,9);assert.equal(b.run('normalizedDashboard'),null);
});
test('normalized transaction refresh button performs server reads',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR"');queueRead(b);b.context.handlers={};b.run('document.addEventListener=(type,fn)=>handlers[type]=fn');
 const start=source.indexOf('document.addEventListener("click",async e=>{'),end=source.indexOf('document.addEventListener("keydown"',start);b.run(source.slice(start,end));
 await b.run('handlers.click({target:{id:"refreshTransactionsBtn",closest:()=>null}})');await settle();assert.equal(b.requests.length,3);assert.equal(b.run('normalizedHistory.total'),960);
});
for(const [path,method,body] of [['/incoming','POST',{productId:'p'}],['/stocktakes','POST',{productId:'p'}],['/transactions','POST',{}],['/transactions/t/payments','POST',{}],['/transactions/t/items','PATCH',{}]])test(`confirmed ${path} refreshes bounded rows, summaries and pagination`,async()=>{
 const b=browser();b.run('persistenceMode="normalized"');const transaction={id:'t',invoice:'960',total:100,cashIn:100,items:[]};b.replies.push(reply({version:2,transaction,record:{id:'record'},products:[]}));queueRead(b,{admin:true,transaction});b.node('#incomingNote').value='draft retained';
 b.run(`normalizedOperation(${JSON.stringify(path)},${JSON.stringify(method)},${JSON.stringify(body)},()=>{})`);await settle();await settle();
 assert.equal(b.run('normalizedHistory.total'),960);assert.equal(b.run('normalizedIncomingMeta.summary.total'),999);assert.equal(b.run('normalizedStockMeta.total'),8);assert.equal(b.run('state.transactions[0].total'),100);assert.equal(b.node('#incomingNote').value,'draft retained');assert.ok(b.requests.every(r=>!r.url.includes('/state')));assert.ok(b.requests.filter(r=>!r.method).every(r=>r.url.includes('/bootstrap')||r.url.includes('expectedRevision=2')));
});

for(const kind of ['cashier','incoming']) {
  const start=kind==='cashier'?'saveTransaction()':'saveIncoming($("#incomingForm"))';
  test(`${kind}: debounce, slow response, double submit, confirmation and reload`,async()=>{
    const b=browser(),slow=deferred();b.replies.push(slow.promise);
    b.run(start);b.run(start);
    assert.equal(b.requests.length,0);
    assert.equal([...b.timers.values()][0].delay,1000);
    const work=b.run('syncServerState()');
    assert.equal(b.requests.length,1);
    assert.equal(b.node('#incomingForm').resets,undefined);
    assert.equal(b.run('cart.length'),1);
    assert.equal(b.messages.length,0,'no premature success');
    const persisted=JSON.parse(b.requests[0].body).state;
    assert.equal(persisted[kind==='cashier'?'transactions':'incoming'].length,1);
    assert.equal(persisted.products[0].stock,kind==='cashier'?18:23);
    slow.resolve(reply({version:2}));await work;
    assert.equal(b.run('criticalSave'),null);
    if(kind==='cashier')assert.equal(b.run('cart.length'),0);
    else assert.equal(b.node('#incomingForm').resets,1);
    b.context.persisted=persisted;b.run('state=migrateState(persisted)');
    assert.equal(b.run(`state.${kind==='cashier'?'transactions':'incoming'}.length`),1);
    assert.equal(b.run('state.products[0].stock'),kind==='cashier'?18:23);
  });
  test(`${kind}: definitive rejection preserves input and rolls back stock/record`,async()=>{
    const b=browser();b.replies.push(reply({message:'Rejected'},400));b.run(start);await b.run('syncServerState()');
    assert.equal(b.run('cart.length'),1);assert.equal(b.node('#incomingForm').resets,undefined);
    assert.equal(b.run('state.products[0].stock'),20);assert.equal(b.run('state.transactions.length+state.incoming.length'),0);
    assert.equal(b.run('criticalSave'),null);assert.equal(b.run('stateDirty'),false);
    assert.match(b.node('#saveStatus span').textContent,/Rejected/);
  });
  test(`${kind}: lost acknowledgement retries same identity, no double stock`,async()=>{
    const b=browser();b.run(start);
    const saved=b.run('JSON.parse(JSON.stringify(statePayload()))');
    b.replies.push(reply({message:'Gateway timeout'},504));await b.run('syncServerState()');
    assert.ok(b.run('criticalSave'));assert.equal(b.run('cart.length'),1);
    b.replies.push(reply({},409),reply({state:saved,version:2}));await b.run('syncServerState()');
    assert.equal(b.run('criticalSave'),null);assert.equal(b.run('state.products[0].stock'),kind==='cashier'?18:23);
    assert.equal(JSON.parse(b.requests[0].body).state[kind==='cashier'?'transactions':'incoming'][0].saveOperationId,
      JSON.parse(b.requests[1].body).state[kind==='cashier'?'transactions':'incoming'][0].saveOperationId);
  });
}

test('conflicting device rejects critical mutation without merging financial fields or losing input',async()=>{
  const b=browser(),remote=b.run('statePayload()');remote.products[0].stock=1;
  b.run('saveTransaction()');b.replies.push(reply({},409),reply({state:remote,version:2}));await b.run('syncServerState()');
  assert.equal(b.run('cart.length'),1);assert.equal(b.run('state.transactions.length'),0);assert.equal(b.run('state.products[0].stock'),1);
  assert.equal(b.requests.length,2);assert.equal(b.run('stateDirty'),false);
});
test('transient failures stop after five retries, retain form, explicit retry reuses operation',async()=>{
  const b=browser();b.run('saveTransaction()');
  for(let i=0;i<6;i++){b.timers.clear();b.replies.push(reply({},503));await b.run('syncServerState()');}
  assert.equal(b.timers.size,0);assert.equal(b.run('cart.length'),1);assert.equal(b.node('#saveStatus button').hidden,false);
  const id=b.run('criticalSave.id');b.run('retryCriticalSave()');b.replies.push(reply({version:2}));await b.run('syncServerState()');
  assert.equal(JSON.parse(b.requests.at(-1).body).state.transactions[0].saveOperationId,id);
  assert.equal(b.run('cart.length'),0);
});

function transaction(b,method='DP'){
  b.context.method=method;
  b.run(`state.transactions=[normalizeTransaction({id:'tx',invoice:'1',createdAt:'2026-10-22',paymentMethod:method,items:[{productId:'p',qty:10,price:10,discount:0,costPrice:4}],subtotal:100,total:100,discountAmount:0,taxPercent:0,downPayment:20,payment:100,cashIn:method==='DP'?20:100})];lastSyncedState=statePayload()`);
}
test('DP availability uses actual balance and authorized session, including fully paid and normalized labels',()=>{
  const b=browser();transaction(b);assert.equal(b.run('canSettleTransaction(state.transactions[0])'),true);
  assert.equal(b.run('normalizeTransaction({...state.transactions[0],paymentMethod:" dp "}).paymentMethod'),'DP');
  b.run('state.transactions[0].paymentHistory=[{amount:80}]');assert.equal(b.run('canSettleTransaction(state.transactions[0])'),false);
  b.run('state.transactions[0].paymentHistory=[];sessionUser=null');assert.equal(b.run('canSettleTransaction(state.transactions[0])'),false);
});
test('DP payment waits for persistence and prevents double submission',async()=>{
  const b=browser();transaction(b);b.node('#settlementInvoice').value='1';b.node('#settlementAmount').value='80';b.node('#settlementMethod').value='Tunai';b.node('#settlementDate').value='2026-10-22';
  b.run('saveSettlement({preventDefault(){}});saveSettlement({preventDefault(){}})');assert.equal(b.run('state.transactions[0].paymentHistory.length'),1);
  const slow=deferred();b.replies.push(slow.promise);const work=b.run('syncServerState()');assert.equal(b.messages.length,0);
  slow.resolve(reply({version:2}));await work;assert.equal(b.run('state.transactions[0].remaining'),0);assert.match(b.messages.at(-1),/dikonfirmasi/);
});
for(const [qty,stock,total,remaining] of [[7,23,70,50],[12,18,120,100]])test(`quantity ${qty}: stock delta, totals, DP balance and audit history`,()=>{
  const b=browser();transaction(b);b.run(`applyQuantityEdit(state.transactions[0],[${qty}],'edit')`);
  assert.equal(b.run('state.products[0].stock'),stock);assert.equal(b.run('state.transactions[0].total'),total);assert.equal(b.run('state.transactions[0].remaining'),remaining);
  assert.equal(b.run('state.transactions[0].quantityEdits.length'),1);assert.equal(b.run('state.transactions[0].items[0].profit'),qty*6);
});
test('quantity editing preserves collected money, exposes refund due, honors historical tax/discount',()=>{
  const b=browser();transaction(b,'Tunai');b.run('applyQuantityEdit(state.transactions[0],[7],"edit")');
  assert.equal(b.run('state.transactions[0].cashIn'),100);assert.equal(b.run('state.transactions[0].refundDue'),30);
  b.run('state.transactions[0].discountMethod="Persen";state.transactions[0].discountPercent=10;state.transactions[0].taxPercent=10;applyQuantityEdit(state.transactions[0],[12],"edit2")');
  assert.equal(b.run('state.transactions[0].total'),118.8);assert.equal(b.run('state.transactions[0].remaining'),18.799999999999997);
});
test('quantity editing rejects invalid values, insufficient stock, missing product and cashier',()=>{
  for(const value of ['0','-1','NaN','Infinity','100']){const b=browser();transaction(b);assert.throws(()=>b.run(`applyQuantityEdit(state.transactions[0],[${value}],"e")`));assert.equal(b.run('state.products[0].stock'),20)}
  const b=browser();transaction(b);b.run('sessionUser.level="KASIR"');assert.throws(()=>b.run('applyQuantityEdit(state.transactions[0],[7],"e")'),/ADMINISTRATOR/);
  b.run('sessionUser.level="ADMINISTRATOR";state.products=[]');assert.throws(()=>b.run('applyQuantityEdit(state.transactions[0],[7],"e")'),/dihapus/);
});
test('logout during critical PUT cancels callbacks and cannot restore state after response',async()=>{
  const b=browser(),slow=deferred();b.run('saveTransaction()');b.replies.push(slow.promise);const work=b.run('syncServerState()');
  b.run('logout();logout()');assert.equal(b.requests.filter(r=>r.url.endsWith('/auth/logout')).length,1);assert.equal(b.requests[0].signal.aborted,true);
  slow.resolve(reply({version:2}));await work;await settle();assert.equal(b.run('apiToken'),'');assert.equal(b.run('state.transactions.length'),0);assert.equal(b.run('serverStateVersion'),null);assert.equal(b.messages.length,0);
});
test('cashier rerender leaves manually entered line price, discount, quantity and date alone',()=>{
  const b=browser();b.node('#cashPrice').value='123';b.node('#cashItemDiscount').value='7';b.node('#cashQty').value='5';b.node('#cashDateTime').value='draft date';
  b.run('fillSelect=()=>{};realRenderCashier()');
  for(const [id,value] of [['#cashPrice','123'],['#cashItemDiscount','7'],['#cashQty','5'],['#cashDateTime','draft date']])assert.equal(b.node(id).value,value);
});
test('search filters normalized input with stable product ID; input listener is delegated once',()=>{
  const b=browser();b.node('#incomingProduct').value='  pro ';b.run('renderIncomingSuggestions()');assert.match(b.node('#incomingSuggestions').innerHTML,/data-incoming-product="p"/);
  b.node('#incomingProduct').value=' product ';assert.equal(b.run('selectedIncomingProduct().id'),'p');b.node('#incomingProduct').value='unknown';assert.equal(b.run('selectedIncomingProduct()'),undefined);assert.equal(b.node('#incomingProduct').dataset.productId,undefined);
  assert.equal((source.match(/document.addEventListener\("input"/g)||[]).length,1);
  const listener=source.slice(source.indexOf('document.addEventListener("input"'),source.indexOf('document.addEventListener("keydown"',source.indexOf('document.addEventListener("input"')));
  let onInput;b.context.document.addEventListener=(_name,fn)=>{onInput=fn};b.run(listener);b.node('#incomingProduct').value='pro';onInput({target:{id:'incomingProduct'}});assert.match(b.node('#incomingSuggestions').innerHTML,/PRODUCT/);
});
test('preview and print share isolated layout, physical dimensions and print rules',()=>{
  const b=browser();transaction(b);b.run('selectedPrintInvoice="1";renderPrint()');const markup=b.node('#printPreviews').innerHTML;
  assert.equal((markup.match(/srcdoc=/g)||[]).length,3);assert.match(markup,/58mm/);assert.match(markup,/@media print/);assert.match(markup,/A4 portrait/);
  assert.doesNotMatch(b.run('receiptCss(".receipt")'),/font-size:[\d.]+px|white-space:nowrap/);
});
test('quantity save waits for server; conflict keeps entered quantities without partial stock changes',async()=>{
  const b=browser();transaction(b);const remote=b.run('statePayload()');b.node('#quantityInvoice').value='1';
  b.context.document.querySelectorAll=selector=>selector==='[data-edit-qty]'?[{value:'7'}]:[];
  b.run('saveQuantityEdit();saveQuantityEdit()');assert.equal(b.run('state.products[0].stock'),23);assert.equal(b.messages.length,0);
  b.replies.push(reply({},409),reply({state:remote,version:2}));await b.run('syncServerState()');
  assert.equal(b.run('state.products[0].stock'),20);assert.equal(b.run('state.transactions[0].items[0].qty'),10);assert.equal(b.run('$("#quantityInvoice").value'),'1');
  b.run('saveQuantityEdit()');b.replies.push(reply({version:3}));await b.run('syncServerState()');
  assert.equal(b.run('state.products[0].stock'),23);assert.equal(b.run('state.transactions[0].quantityEdits.length'),1);
});
test('remote render preserves unsaved form values even if a renderer rebuilds controls',()=>{
  const b=browser(),drafts=[b.node('#cashPrice'),b.node('#incomingPrice'),b.node('#cashCustomer')];drafts.forEach((input,index)=>input.value=String(index+111));
  b.context.document.querySelectorAll=selector=>selector.startsWith('#cashierPage input')?drafts:[];
  b.run('renderDashboard=renderSettings=renderReferences=renderProducts=renderSuppliers=renderCustomers=renderTransactions=renderPrint=renderStocktake=()=>{};renderCashier=()=>{$("#cashPrice").value="0";$("#cashCustomer").value="UMUM"};renderIncoming=()=>{$("#incomingPrice").value="0"};realRenderAll()');
  assert.deepEqual(drafts.map(input=>input.value),['111','112','113']);
});
test('DP action renders beside invoice, disappears after payment; cashier navigation excludes password',()=>{
  const b=browser();transaction(b);b.run('renderTransactions()');assert.match(b.node('#transactionTableBody').innerHTML,/<td class="transaction-number">1<br><button[^>]+data-tx-settle/);
  b.run('state.transactions[0].paymentHistory=[{amount:80}];renderTransactions()');assert.doesNotMatch(b.node('#transactionTableBody').innerHTML,/data-tx-settle/);
  const buttons=['password','cashier','incoming'].map(page=>({dataset:{page},classList:{toggle(_name,hidden){this.hidden=hidden}}}));
  b.context.document.querySelectorAll=()=>buttons;b.run('sessionUser.level="KASIR";updateNavigationPermissions()');assert.equal(buttons[0].classList.hidden,true);assert.equal(buttons[1].classList.hidden,false);assert.equal(buttons[2].classList.hidden,true);
  b.run('sessionUser.level="ADMINISTRATOR";updateNavigationPermissions()');assert.equal(buttons[0].classList.hidden,false);
});
test('stale activation and API 401 after logout cannot resurrect or terminate a newer session',async()=>{
  const b=browser(),slow=deferred();b.replies.push(slow.promise);const work=b.run('activateSession({id:"old",level:"ADMINISTRATOR"})');b.run('logout()');slow.resolve(reply({state:{transactions:[]},version:99}));await work;assert.equal(b.run('apiToken'),'');assert.equal(b.run('serverStateVersion'),null);
  const late=deferred();b.replies.push(late.promise);const request=b.run('apiRequest("/users").catch(()=>null)');b.run('sessionGeneration++;apiToken="new"');late.resolve(reply({},401));await request;assert.equal(b.run('apiToken'),'new');
});

for(const scenario of [
  {name:'edited DP',method:'DP',qty:12,payment:20,received:30,remaining:90,refund:0,status:'BELUM LUNAS'},
  {name:'edited paid cash with refund due',method:'Tunai',qty:7,payment:100,received:100,remaining:0,refund:30,status:'LUNAS'},
  {name:'edited cash without refund due',method:'Tunai',qty:10,payment:100,received:100,remaining:0,refund:0,status:'LUNAS'}
])test(`${scenario.name}: detail and print retain method/payment information and omit zero balances`,()=>{
  const b=browser();transaction(b,scenario.method);
  if(scenario.method==='DP')b.run('state.transactions[0].paymentHistory=[{id:"partial",amount:10,date:"2026-10-22",method:"Tunai"}]');
  b.run(`applyQuantityEdit(state.transactions[0],[${scenario.qty}],"edit-display")`);
  const before=b.run('JSON.stringify(state)');
  b.run('transactionDetail(state.transactions[0])');
  const a4=b.run('a4PaymentHtml(state.transactions[0])');
  assert.ok(b.node('#modalBody').innerHTML.includes(a4),'detail uses the same payment summary as A4');
  for(const markup of [b.run('receiptPaymentHtml(state.transactions[0])'),a4,b.node('#modalBody').innerHTML]){
    const text=markup.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    assert.match(text,new RegExp(`${scenario.method}:? Rp${scenario.payment}`));
    assert.match(text,new RegExp(`Total diterima:? Rp${scenario.received}`));
    assert.match(text,new RegExp(`Status:? ${scenario.status}`));
    if(scenario.method==='DP')assert.match(text,/Total Dibayar:? Rp30/);
    if(scenario.remaining)assert.match(text,new RegExp(`Sisa Pembayaran:? Rp${scenario.remaining}`));
    else assert.doesNotMatch(text,/Sisa Pembayaran/);
    if(scenario.refund)assert.match(text,new RegExp(`Pengembalian belum dicatat:? Rp${scenario.refund}`));
    else assert.doesNotMatch(text,/Pengembalian belum dicatat/);
  }
  assert.equal(b.run('JSON.stringify(state)'),before,'display must not alter accounting');
});

test('remaining-payment label follows original method in table, detail and settlement modal',()=>{
  for(const method of ['DP','Tunai']){
    const b=browser();transaction(b,method);b.run('applyQuantityEdit(state.transactions[0],[12],"edit-label")');
    assert.equal(b.run('canSettleTransaction(state.transactions[0])'),true);
    b.run('renderTransactions();transactionDetail(state.transactions[0])');
    const expected=method==='DP'?'Bayar Sisa DP':'Bayar Sisa';
    for(const markup of [b.node('#transactionTableBody').innerHTML,b.node('#modalBody').innerHTML]){
      const labels=[...markup.matchAll(/data-tx-settle="[^"]+"[^>]*>([^<]+)<\/button>/g)].map(match=>match[1]);
      assert.ok(labels.length);assert.ok(labels.every(label=>label===expected));
    }
    b.run('settlementModal("1")');assert.equal(b.node('#modalTitle').textContent,expected);
  }
});

test('logout clears all draft control types, product IDs, suggestions and modal state without a state write',async()=>{
  const b=browser();
  const controls=[['#app input','INPUT'],['#app textarea','TEXTAREA'],['#app select','SELECT'],['#modalBody input','INPUT'],['#modalBody textarea','TEXTAREA'],['#modalBody select','SELECT']].map(([selector,tagName])=>{
    const input=b.node(selector);Object.assign(input,{tagName,value:'previous-user-draft',selectedIndex:2,checked:true,type:tagName==='INPUT'?'checkbox':'',dataset:{productId:'old-product'}});return {selector,input};
  });
  b.context.document.querySelectorAll=selector=>controls.filter(control=>selector.split(',').includes(control.selector)).map(control=>control.input);
  b.node('#incomingSuggestions').innerHTML='<button>Previous product</button>';b.node('#incomingSuggestions').hidden=false;
  b.node('#modalBody').innerHTML='<form>Previous draft</form>';b.node('#modalTitle').textContent='Previous modal';
  b.run('quickAddTarget="customer";logout()');await settle();
  for(const {input} of controls){assert.equal(input.value,'');assert.equal(input.dataset.productId,undefined);if(input.tagName==='SELECT')assert.equal(input.selectedIndex,-1);if(input.type==='checkbox')assert.equal(input.checked,false)}
  assert.equal(b.node('#incomingSuggestions').innerHTML,'');assert.equal(b.node('#incomingSuggestions').hidden,true);
  assert.equal(b.node('#modalBody').innerHTML,'');assert.equal(b.node('#modalTitle').textContent,'');assert.equal(b.run('quickAddTarget'),'');
  assert.deepEqual(b.requests.map(request=>request.url),['/api/auth/logout'],'logout must not PUT persisted application data');
});

test('malformed records from another actor do not block own pending recovery',async()=>{
 const b=browser();b.run('persistenceMode="normalized"');b.replies.push(Promise.reject(new TypeError('offline')));b.run('saveTransaction()');await settle();
 const own=JSON.parse([...b.storage.values()][0]);b.storage.set('kasir.pending.v1:other:broken','{bad');
 assert.equal(b.run('pendingOperations("admin").length'),1);
 const fresh=browser(b.storage);fresh.run('persistenceMode="normalized"');fresh.replies.push(reply({message:'Rejected'},400));assert.equal(fresh.run('recoverPendingOperation()'),true);await settle();
 assert.equal(fresh.requests[0].headers['Idempotency-Key'],own.id);assert.equal(b.storage.get('kasir.pending.v1:other:broken'),'{bad');assert.equal(b.storage.size,1);
});
test('missing legacy selection never falls back to another invoice',async()=>{
 const b=browser();transaction(b);b.run('selectedPrintInvoice="missing"');assert.equal(b.run('selectedPrintTransaction()'),null);await b.run('realPrintDocument("receipt")');assert.ok(b.messages.some(x=>/diblokir/.test(x)));
});
test('normalized exact lookup survives history pagination and failed search blocks prior invoice',async()=>{
 const b=browser();b.run('persistenceMode="normalized"');b.replies.push(reply({invoice:'001',items:[],total:0}));await b.run('selectPrintInvoice("001")');assert.match(b.requests[0].url,/transaction-by-invoice\?invoice=001$/);
 b.run('state.transactions=[{invoice:"someone-else"}];renderPrint()');assert.equal(b.run('selectedPrintTransaction().invoice'),'001');
 b.replies.push(reply({message:'Not found'},404));await b.run('selectPrintInvoice("missing")');assert.equal(b.run('selectedPrintTransaction()'),null);
 b.replies.push(reply({message:'Unavailable'},503));await b.run('realPrintDocument("invoice")');assert.equal(b.run('isPrinting'),false);assert.ok(b.messages.length);
});
test('out-of-order searches and changing selection during print cannot print another invoice',async()=>{
 const b=browser(),slow=deferred();b.run('persistenceMode="normalized"');b.replies.push(slow.promise,reply({invoice:'B',items:[]}));const first=b.run('selectPrintInvoice("A")');await b.run('selectPrintInvoice("B")');slow.resolve(reply({invoice:'A',items:[]}));await first;assert.equal(b.run('selectedPrintTransaction().invoice'),'B');
 const printing=deferred();b.replies.push(printing.promise);const work=b.run('realPrintDocument("faktur")');b.run('selectedPrintInvoice="C"');printing.resolve(reply({invoice:'B',items:[]}));await work;assert.equal(b.run('isPrinting'),false);assert.ok(b.messages.some(x=>/berubah/.test(x)));
});
for(const type of ['receipt','invoice','faktur'])test(`${type} rejects mismatched endpoint invoice`,async()=>{
 const b=browser();b.run('persistenceMode="normalized";selectedPrintInvoice="A"');b.replies.push(reply({invoice:'B',items:[]}));await b.run(`realPrintDocument("${type}")`);assert.equal(b.run('isPrinting'),false);assert.ok(b.messages.some(x=>/diblokir/i.test(x)));
});
test('selection change while print frame loads cancels physical printing',async()=>{
 const b=browser(),ready=deferred();let printed=0;b.context.frameReady=ready.promise;b.context.document.body={appendChild(){}};b.context.document.createElement=()=>({style:{},setAttribute(){},remove(){},contentDocument:{open(){},write(){},close(){}},contentWindow:{addEventListener(){},focus(){},print(){printed++}}});
 transaction(b);b.run('selectedPrintInvoice="1";waitForPrintFrame=()=>frameReady');const work=b.run('realPrintDocument("receipt")');b.run('selectedPrintInvoice="2"');ready.resolve();await work;assert.equal(printed,0);assert.equal(b.run('isPrinting'),false);
});
for(const type of ['receipt','invoice','faktur'])test(`${type} prints exact API invoice after history page replacement`,async()=>{
 const b=browser();let printed=0,html='';b.context.document.body={appendChild(){}};b.context.document.createElement=()=>({style:{},setAttribute(){},remove(){},contentDocument:{open(){},write(value){html=value},close(){}},contentWindow:{addEventListener(){},focus(){},print(){printed++}}});
 b.run('persistenceMode="normalized";selectedPrintInvoice="EXACT-001";state.transactions=[{invoice:"WRONG-999"}];waitForPrintFrame=async()=>{}');b.replies.push(reply({invoice:'EXACT-001',customer:'Exact customer',items:[],total:0}));await b.run(`realPrintDocument("${type}")`);assert.equal(printed,1);assert.match(html,/EXACT-001/);assert.doesNotMatch(html,/WRONG-999/);assert.match(b.requests[0].url,/invoice=EXACT-001$/);
});

function installActionListeners(b){
 const handlers={};b.context.document.addEventListener=(type,fn)=>{handlers[type]=fn};
 b.run(source.slice(source.indexOf('document.addEventListener("submit"'),source.indexOf('$("#modal").addEventListener')));
 return handlers;
}
function actionTarget(selector){return {id:selector.startsWith('#')?selector.slice(1):'',dataset:{productDelete:'p'},closest:query=>query.split(',').includes(selector)?{}:null};}
function printConfiguration(b,key,value){const settings={...JSON.parse(b.run('JSON.stringify(state.settings)')),[key]:value};return {settings,categories:[],units:[],paymentMethods:['Tunai','DP','Transfer']};}
for(const [id,key,value] of [['printReceiptType','receiptType','Invoice A4'],['printMethod','printMethod','Tidak Mencetak']])test(`normalized ${key} waits for confirmed configuration and survives reload`,async()=>{
 const b=browser(),slow=deferred(),handlers=installActionListeners(b);b.run('persistenceMode="normalized"');const before=b.run(`state.settings.${key}`),record=printConfiguration(b,key,value);
 b.replies.push(slow.promise);handlers.change({target:{id,value}});assert.equal(b.run(`state.settings.${key}`),before);assert.equal(b.node('#'+id).value,before);assert.equal(b.messages.length,0);
 const request=b.requests[0];assert.match(request.url,/\/configuration$/);assert.equal(request.method,'PUT');assert.equal(JSON.parse(request.body).data.settings[key],value);assert.equal(JSON.parse(request.body).revision,1);assert.equal(JSON.parse(request.body).state,undefined);
 queueRead(b,{admin:true,settings:record.settings});slow.resolve(reply({version:2,record}));await settle();await settle();assert.equal(b.run(`state.settings.${key}`),value);assert.ok(b.messages.some(x=>/dikonfirmasi/.test(x)));assert.equal(b.storage.size,0);
 const fresh=browser();fresh.run('persistenceMode="normalized"');queueRead(fresh,{admin:true,settings:record.settings});await fresh.run('reloadNormalizedPage()');assert.equal(fresh.run(`state.settings.${key}`),value);assert.ok(b.requests.every(x=>!x.url.endsWith('/state')));
});
for(const status of [400,403,409,503])test(`print preference failure ${status} keeps confirmed settings and reports error`,async()=>{
 const b=browser();b.run('persistenceMode="normalized"');const before=b.run('JSON.stringify(state.settings)');b.replies.push(reply({message:'Preference save failed'},status));b.run('savePrintPreference("printReceiptType","Invoice A4")');await settle();
 assert.equal(b.run('JSON.stringify(state.settings)'),before);assert.ok(b.node('#saveStatus span').textContent.includes('Preference save failed'));assert.ok(!b.messages.some(x=>/dikonfirmasi/.test(x)));
});
test('lost print preference acknowledgement recovers exact command on fresh session',async()=>{
 const b=browser();b.run('persistenceMode="normalized"');const record=printConfiguration(b,'receiptType','Invoice A4');b.replies.push(Promise.reject(new TypeError('offline')));b.run('savePrintPreference("printReceiptType","Invoice A4")');await settle();assert.equal(b.storage.size,1);
 const fresh=browser(b.storage);fresh.run('persistenceMode="normalized"');fresh.replies.push(reply({version:2,record}));queueRead(fresh,{admin:true,settings:record.settings});assert.equal(fresh.run('recoverPendingOperation()'),true);await settle();await settle();
 assert.equal(fresh.requests[0].body,b.requests[0].body);assert.equal(fresh.requests[0].headers['Idempotency-Key'],b.requests[0].headers['Idempotency-Key']);assert.equal(fresh.run('state.settings.receiptType'),'Invoice A4');assert.equal(b.storage.size,0);
});
test('normalized cashier and read-only preference changes are explicit no-ops',()=>{
 for(const [mode,role] of [['normalized','KASIR'],['normalized-read','ADMINISTRATOR']]){const b=browser();b.run(`persistenceMode="${mode}";sessionUser.level="${role}"`);const before=b.run('JSON.stringify(state.settings)');b.run('savePrintPreference("printReceiptType","Invoice A4")');assert.equal(b.requests.length,0);assert.equal(b.run('JSON.stringify(state.settings)'),before);assert.ok(b.messages.length);}
});
test('legacy print preferences retain existing whole-state save behavior',()=>{
 const b=browser();b.run('let preferenceSaves=0;saveState=()=>preferenceSaves++;savePrintPreference("printReceiptType","Invoice A4");savePrintPreference("printMethod","Tidak Mencetak")');assert.equal(b.run('preferenceSaves'),2);assert.equal(b.run('state.settings.receiptType'),'Invoice A4');assert.equal(b.run('state.settings.printMethod'),'Tidak Mencetak');
});
for(const mode of ['normalized','normalized-read'])for(const selector of ['[data-tx-delete]','[data-incoming-delete]','[data-stocktake-delete]','[data-product-delete]','[data-supplier-delete]','[data-customer-delete]','[data-ref-delete]','#resetAppBtn','#restoreDataBtn','#backupDataBtn'])test(`${mode} blocks ${selector} before any side effect`,async()=>{
 const b=browser(),handlers=installActionListeners(b);b.run(`persistenceMode="${mode}";saveState=()=>{throw new Error("Unexpected save")};csvDownload=()=>{throw new Error("Unexpected export")}`);b.context.confirm=()=>{throw new Error('Unexpected confirmation')};const before=b.run('JSON.stringify(state)'),draft=b.run('JSON.stringify(cart)');let prevented=false;
 await handlers.click({target:actionTarget(selector),preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(b.run('JSON.stringify(state)'),before);assert.equal(b.run('JSON.stringify(cart)'),draft);assert.equal(b.requests.length,0);assert.match(b.messages[0],/sementara tidak tersedia/);assert.equal(b.storage.size,0);
});
test('direct backup restore and history deletion paths are also guarded',()=>{
 const b=browser();b.run('persistenceMode="normalized"');const before=b.run('JSON.stringify(state)');for(const code of ['backupData()','restoreData({})','deleteTransaction("1")','deleteIncomingRecord("1")'])b.run(code);assert.equal(b.run('JSON.stringify(state)'),before);assert.equal(b.requests.length,0);assert.equal(b.messages.length,4);
});
test('legacy deletion and complete catalogue exports remain available',async()=>{
 const b=browser(),handlers=installActionListeners(b);b.run('let localSaves=0,downloads=0;saveState=()=>localSaves++;csvDownload=()=>downloads++');
 const target=actionTarget('[data-product-delete]');target.closest=query=>query.split(',').includes('[data-product-delete]')?target:null;
 await handlers.click({target,preventDefault(){}});assert.equal(b.run('state.products.length'),0);assert.equal(b.run('localSaves'),1);
 for(const mode of ['legacy','normalized']){b.run(`persistenceMode="${mode}"`);for(const selector of ['#exportProductsBtn','#exportSuppliersBtn','#exportCustomersBtn'])await handlers.click({target:actionTarget(selector),preventDefault(){}});}
 assert.equal(b.run('downloads'),6);
});
test('print preference adopts server-confirmed configuration rather than submitted draft',async()=>{
 const b=browser();b.run('persistenceMode="normalized"');const record=printConfiguration(b,'receiptType','Faktur Penjualan A4');b.replies.push(reply({version:2,record}));queueRead(b,{admin:true,settings:record.settings});await b.run('savePrintPreference("printReceiptType","Invoice A4")');assert.equal(b.run('state.settings.receiptType'),'Faktur Penjualan A4');await settle();
});
test('incomplete configuration acknowledgement retains pending command without success',async()=>{
 const b=browser();b.run('persistenceMode="normalized"');const before=b.run('JSON.stringify(state.settings)');b.replies.push(reply({version:2,record:{}}));b.run('savePrintPreference("printReceiptType","Invoice A4")');await settle();assert.equal(b.run('JSON.stringify(state.settings)'),before);assert.equal(b.storage.size,1);assert.match(b.node('#saveStatus span').textContent,/Konfirmasi pengaturan tidak lengkap/);assert.equal(b.messages.length,0);
});

// Complete-history CSV regression: all pages must belong to one revision.
test('normalized admin exports complete transactions across bounded pages',async()=>{
 const b=browser();b.run('persistenceMode="normalized";let exported=null;csvDownload=(filename,headers,rows)=>{exported={filename,rows}}');
 const first=Array.from({length:100},(_,i)=>({invoice:String(i+1),createdAt:'2026-11-19',customer:'-',cashier:'ADMIN',paymentMethod:'Tunai',total:100,cashIn:100}));
 const last=[{invoice:'101',createdAt:'2026-11-19',customer:'-',cashier:'ADMIN',paymentMethod:'Tunai',total:100,cashIn:100}];
 b.replies.push(reply({rows:first,total:101}),reply({rows:last,total:101}),reply({version:1}));
 await b.run('exportCompleteNormalizedHistory("transactions")');
 const e=JSON.parse(b.run('JSON.stringify(exported)'));
 assert.equal(e.rows.length,101);assert.equal(e.rows[100][0],'101');
 assert.match(e.filename,/transaksi-keluar-lengkap/);
 assert.equal(b.requests.length,3);
 assert.match(b.requests[0].url,/page=1&limit=100&expectedRevision=1/);
 assert.match(b.requests[1].url,/page=2&limit=100&expectedRevision=1/);
 assert.ok(b.requests[2].url.endsWith('/api/sync'));
});
test('normalized export cancels on pagination revision conflict',async()=>{
 const b=browser();b.run('persistenceMode="normalized";let exported=0;csvDownload=()=>exported++');
 b.replies.push(reply({rows:Array.from({length:100},(_,i)=>({invoice:String(i+1)})),total:101}),reply({message:'Read revision changed'},409));
 await b.run('exportCompleteNormalizedHistory("transactions")');
 assert.equal(b.run('exported'),0);assert.match(b.messages.at(-1),/Ekspor dibatalkan/);
});
test('normalized export cancels when final sync revision changed',async()=>{
 const b=browser();b.run('persistenceMode="normalized";let exported=0;csvDownload=()=>exported++');
 b.replies.push(reply({rows:[{invoice:'1'}],total:1}),reply({version:2}));
 await b.run('exportCompleteNormalizedHistory("transactions")');
 assert.equal(b.run('exported'),0);assert.match(b.messages.at(-1),/Ekspor dibatalkan/);
});
test('normalized cashier cannot export history',async()=>{
 const b=browser();b.run('persistenceMode="normalized";sessionUser.level="KASIR";let exported=0;csvDownload=()=>exported++');
 await b.run('exportCompleteNormalizedHistory("transactions")');
 assert.equal(b.run('exported'),0);assert.equal(b.requests.length,0);
 assert.match(b.messages.at(-1),/ADMINISTRATOR/);
});
test('normalized admin exports complete incoming history',async()=>{
 const b=browser();b.run('persistenceMode="normalized";let exported=null;csvDownload=(filename,headers,rows)=>{exported={filename,rows}}');
 b.replies.push(reply({rows:[{id:'i1',date:'2026-11-19',supplier:'S',product:'P',qty:1,total:10}],total:1}),reply({version:1}));
 await b.run('exportCompleteNormalizedHistory("incoming")');
 const e=JSON.parse(b.run('JSON.stringify(exported)'));
 assert.equal(e.rows.length,1);assert.match(e.filename,/barang-masuk-lengkap/);
 assert.match(b.requests[0].url,/api\/incoming\?/);
});
