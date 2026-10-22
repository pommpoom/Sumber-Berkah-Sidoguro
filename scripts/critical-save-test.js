const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require.resolve('../assets/js/app.js'), 'utf8');
const seed = fs.readFileSync(require.resolve('../assets/js/seed-data.js'), 'utf8');
const reply = (body, status=200) => new Response(JSON.stringify(body), {status});
const deferred = () => { let resolve; const promise=new Promise(done=>{resolve=done});return {promise,resolve}; };
const settle = () => new Promise(resolve=>setImmediate(resolve));

function browser() {
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
    AbortController,AbortSignal:{timeout:AbortSignal.timeout.bind(AbortSignal),any:AbortSignal.any.bind(AbortSignal)},Blob,Option:class {},
    setTimeout(callback,delay){timers.set(++timerId,{callback,delay});return timerId},clearTimeout(id){timers.delete(id)},
    confirm:()=>true,
    async fetch(url,options){requests.push({url,...options});if(url.endsWith('/auth/logout'))return reply({ok:true});assert.ok(replies.length,`Unexpected request ${url}`);return replies.shift()},
    recordMessage:message=>messages.push(message)
  });
  const run=code=>vm.runInContext(code,context);
  run(seed+'\n'+source.slice(0,source.indexOf('document.addEventListener("submit"')));
  run(`
    const realRenderAll=renderAll,realRenderCashier=renderCashier;
    renderAll=()=>{};goPage=()=>{};printDocument=()=>{};toast=recordMessage;
    sessionUser={id:'admin',username:'ADMIN',level:'ADMINISTRATOR'};apiToken='cookie';sessionGeneration=1;
    state.products=[{id:'p',name:'PRODUCT',active:true,trackStock:true,stock:20,costPrice:4,retailPrice:10,wholesalePrice:10,unit:'Pcs'}];
    state.currentUser='ADMIN';serverStateVersion=1;lastSyncedState=statePayload();
    cart=[{productId:'p',lineId:'line',name:'PRODUCT',qty:2,price:10,discount:0,costPrice:4,amount:20,profit:12}];
  `);
  node('#cashInvoice').value='1';node('#cashPaymentMethod').value='Tunai';node('#cashPayment').value='20';
  node('#incomingProduct').value='PRODUCT';node('#incomingSupplier').value='Supplier';node('#incomingQty').value='3';node('#incomingPrice').value='8';node('#incomingDate').value='2026-10-22';
  return {run,node,requests,replies,timers,messages,context};
}

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
  const b=browser();transaction(b);b.run('renderPrint()');const markup=b.node('#printPreviews').innerHTML;
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
