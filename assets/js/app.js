const LOCAL_BACKEND_PORT = "3000";
const isLocalStaticServer = ["localhost","127.0.0.1"].includes(location.hostname) && location.port !== LOCAL_BACKEND_PORT;
const API_BASE_URL = isLocalStaticServer ? `${location.protocol}//${location.hostname}:${LOCAL_BACKEND_PORT}/api` : "/api";
const clone = x => x===undefined?undefined:JSON.parse(JSON.stringify(x));
let state;
let users = [];
let sessionUser = null;
let cart = [];
let selectedPrintInvoice = "";
let activeReference = "users";
let selectedSupplierId = "";
let transactionPage = 1;
let productPage = 1;
let customerPage = 1;
let quickAddTarget = "";
let isPrinting = false;
let activePrintFrame = null;
let apiToken = "";
let serverSyncTimer;
let serverStateVersion = null;
let lastSyncedState = null;
let stateDirty = false;
let syncInFlight = false;
let syncErrorShown = false;
let serverRefreshTimer;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => new Intl.NumberFormat("id-ID",{maximumFractionDigits:0}).format(Number(n||0));
const rupiah = n => "Rp" + money(n);
const today = () => new Date().toISOString().slice(0,10);
const nowLocal = () => {
  const d=new Date(); const p=n=>String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const esc = v => String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const timeoutSignal = () => typeof AbortSignal!=="undefined"&&typeof AbortSignal.timeout==="function"?AbortSignal.timeout(15000):undefined;

function toSafeNumber(value,fallback=0){const result=Number(value);return Number.isFinite(result)?result:fallback}
function normalizedText(value){return String(value??"").trim().replace(/\s+/g," ").toUpperCase()}
function normalizeProductName(name,{removeSuffix=false}={}){
  let value=normalizedText(name).replace(/[._,/\\]+/g," ").replace(/\s*-\s*/g," - ").replace(/\s+/g," ").trim();
  if(removeSuffix)value=value.replace(/\s+-\s+[A-Z]{1,3}$/," ").trim();
  return value;
}
function findMatchingProduct(productName,products=state?.products||[]){
  const exact=normalizeProductName(productName), base=normalizeProductName(productName,{removeSuffix:true});
  const exactMatches=products.filter(product=>normalizeProductName(product.name)===exact);
  if(exactMatches.length===1)return exactMatches[0];
  if(exactMatches.length>1)return null;
  const baseMatches=products.filter(product=>normalizeProductName(product.name,{removeSuffix:true})===base);
  return baseMatches.length===1?baseMatches[0]:null;
}

async function apiRequest(path,options={}){
  try{
    const response=await fetch(`${API_BASE_URL}${path}`,{credentials:"include",signal:timeoutSignal(),...options,headers:{...(options.body?{"Content-Type":"application/json"}:{}),...(options.headers||{})}});
    if(response.status===401){if(apiToken)logout();throw new Error("Sesi Anda telah berakhir. Silakan login kembali.")}
    const body=response.status===204?null:await response.json().catch(()=>null);
    if(!response.ok)throw new Error(body?.message||(response.status===403?"Anda tidak memiliki izin untuk melakukan tindakan ini.":"Permintaan tidak dapat diproses."));
    return body;
  }catch(error){
    if(error.name==="TimeoutError"||error.name==="AbortError")throw new Error("Waktu tunggu server habis. Coba kembali.");
    if(error instanceof TypeError)throw new Error(navigator.onLine?"Server belum dapat dihubungi.":"Koneksi internet terputus.");
    throw error;
  }
}
async function loadUsers(){if(currentUser()?.level!=="ADMINISTRATOR")return;users=await apiRequest("/users");renderUsers()}

function calculateItemAmount(price,discount,qty){return Math.max(0,(Number(price)||0)-Math.max(0,Number(discount)||0))*Math.max(0,Number(qty)||0)}
function getTransactionCashIn(transaction){return Number((transaction.cashIn??(transaction.paymentMethod==="DP"?transaction.downPayment:transaction.total))||0)}
function getPaymentStatus(transaction){return Number(transaction.remaining||0)>0?"BELUM LUNAS":"LUNAS"}
function normalizeTransaction(transaction){
  const t={...transaction};
  t.items=Array.isArray(t.items)?t.items.map((item,index)=>{
    const i={...item}; i.lineId=i.lineId||`${t.invoice||t.id||"TX"}-${index+1}`;
    i.price=toSafeNumber(i.price); i.discount=Math.max(0,toSafeNumber(i.discount)); i.qty=Math.max(0,toSafeNumber(i.qty)); i.costPrice=toSafeNumber(i.costPrice);
    i.amount=calculateItemAmount(i.price,i.discount,i.qty); i.profit=(i.price-i.discount-i.costPrice)*i.qty;
    return i;
  }):[];
  t.subtotal=toSafeNumber(t.subtotal??t.items.reduce((sum,item)=>sum+item.amount,0));
  t.discountAmount=Math.max(0,Math.min(t.subtotal,toSafeNumber(t.discountAmount??t.discount??0)));
  t.discountPercent=toSafeNumber(t.discountPercent??(t.subtotal? t.discountAmount/t.subtotal*100:0));
  t.taxPercent=toSafeNumber(t.taxPercent); t.taxAmount=toSafeNumber(t.taxAmount??Math.max(0,t.subtotal-t.discountAmount)*t.taxPercent/100);
  t.total=toSafeNumber(t.total??(t.subtotal-t.discountAmount+t.taxAmount));
  t.downPayment=Math.max(0,toSafeNumber(t.downPayment)); t.payment=toSafeNumber(t.payment); t.change=Math.max(0,toSafeNumber(t.change));
  t.remaining=Math.max(0,toSafeNumber(t.remaining??(t.paymentMethod==="DP"?t.total-t.downPayment:0)));
  t.cashIn=getTransactionCashIn(t); t.paymentStatus=getPaymentStatus(t);
  return t;
}
function normalizeState(raw){
  const base=clone(window.SEED_DATA), x=raw&&typeof raw==="object"?raw:{};
  const normalized={...base,...x,settings:{...base.settings,...(x.settings||{})}};
  normalized.settings.discountMethod=normalized.settings.discountMethod==="Persen"?"Persen":"Nominal";
  normalized.settings.taxPercent=Number(normalized.settings.taxPercent||0);
  normalized.settings.printMethod=normalized.settings.printMethod||"Dialog Printer";
  ["products","suppliers","customers","incoming","stocktakes","categories","units","paymentMethods"].forEach(key=>{if(!Array.isArray(normalized[key]))normalized[key]=clone(base[key]||[])});
  normalized.products=normalized.products.map(product=>({...product,stock:toSafeNumber(product.stock),costPrice:toSafeNumber(product.costPrice),retailPrice:toSafeNumber(product.retailPrice),wholesalePrice:toSafeNumber(product.wholesalePrice),minStock:toSafeNumber(product.minStock)}));
  normalized.incoming=normalized.incoming.map(record=>({...record,qty:toSafeNumber(record.qty),purchasePrice:toSafeNumber(record.purchasePrice),total:toSafeNumber(record.total),previousStock:toSafeNumber(record.previousStock),previousCostPrice:toSafeNumber(record.previousCostPrice),resultingCostPrice:toSafeNumber(record.resultingCostPrice)}));
  normalized.stocktakes=normalized.stocktakes.map(record=>({...record,systemStock:toSafeNumber(record.systemStock),physicalStock:toSafeNumber(record.physicalStock),difference:toSafeNumber(record.difference)}));
  normalized.transactions=(Array.isArray(x.transactions)?x.transactions:base.transactions||[]).map(normalizeTransaction);
  normalized.lastBackupAt=x.lastBackupAt||null;
  return normalized;
}
function migrateState(raw,{log=false}={}){
  const normalized=normalizeState(raw);normalized.schemaVersion=1;return normalized;
}
function loadState(){
  return migrateState(clone(window.SEED_DATA),{log:true});
}
function statePayload(source=state){const payload=clone(source);delete payload.currentUser;delete payload.users;return payload}
function sameValue(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function recordKey(value,index){return value&&typeof value==="object"?String(value.id??value.invoice??value.lineId??index):`value:${String(value)}`}
function mergeArray(base=[],local=[],remote=[]){
  const allObjects=[...base,...local,...remote].every(value=>value&&typeof value==="object"&&!Array.isArray(value));
  if(!allObjects){
    const baseValues=new Set(base.map(value=>JSON.stringify(value))),localValues=new Set(local.map(value=>JSON.stringify(value))),remoteValues=new Set(remote.map(value=>JSON.stringify(value)));
    const kept=base.filter(value=>localValues.has(JSON.stringify(value))&&remoteValues.has(JSON.stringify(value)));
    const additions=[...remote,...local].filter(value=>!baseValues.has(JSON.stringify(value)));
    return [...kept,...additions.filter((value,index,list)=>list.findIndex(item=>sameValue(item,value))===index)];
  }
  const toMap=list=>new Map(list.map((value,index)=>[recordKey(value,index),value]));
  const baseMap=toMap(base),localMap=toMap(local),remoteMap=toMap(remote),keys=[...new Set([...baseMap.keys(),...remoteMap.keys(),...localMap.keys()])];
  return keys.map(key=>mergeValue(baseMap.get(key),localMap.get(key),remoteMap.get(key))).filter(value=>value!==undefined);
}
function mergeValue(base,local,remote){
  if(sameValue(local,base))return clone(remote);
  if(sameValue(remote,base))return clone(local);
  if(Array.isArray(base)||Array.isArray(local)||Array.isArray(remote))return mergeArray(Array.isArray(base)?base:[],Array.isArray(local)?local:[],Array.isArray(remote)?remote:[]);
  if(base&&local&&remote&&typeof base==="object"&&typeof local==="object"&&typeof remote==="object"){
    const merged={};for(const key of new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)])){const value=mergeValue(base[key],local[key],remote[key]);if(value!==undefined)merged[key]=value}
    if([base.stock,local.stock,remote.stock].every(value=>Number.isFinite(Number(value))))merged.stock=Math.max(0,Number(base.stock)+(Number(local.stock)-Number(base.stock))+(Number(remote.stock)-Number(base.stock)));
    return merged;
  }
  return clone(local);
}
function normalizeInMemoryState(){state=migrateState(state);}
async function getServerState(){
  const response=await fetch(`${API_BASE_URL}/state`,{credentials:"include",signal:timeoutSignal(),cache:"no-store"});
  if(response.status===401)throw new Error("Sesi login berakhir.");
  if(!response.ok)throw new Error("Data server tidak dapat dimuat.");
  return response.json();
}
function showSyncError(message){if(!syncErrorShown){syncErrorShown=true;toast(message)}}
async function syncServerState(){
  if(!apiToken||location.protocol==="file:"||syncInFlight||!stateDirty)return;
  syncInFlight=true;
  try{
    for(let attempts=0;attempts<3&&stateDirty;attempts++){
      const payload=statePayload();
      const response=await fetch(`${API_BASE_URL}/state`,{method:"PUT",credentials:"include",signal:timeoutSignal(),headers:{"Content-Type":"application/json"},body:JSON.stringify({state:payload,expectedVersion:Number(serverStateVersion||0)})});
      if(response.status===401){apiToken="";showSyncError("Sesi berakhir. Silakan login kembali.");return}
      if(response.status===409){
        const remote=await getServerState();
        const currentUser=state.currentUser;
        state=migrateState(mergeValue(lastSyncedState||remote.state||{},payload,remote.state||{}),{log:true});
        state.currentUser=currentUser;normalizeInMemoryState();serverStateVersion=Number(remote.version||0);lastSyncedState=clone(remote.state||{});stateDirty=true;continue;
      }
      if(!response.ok)throw new Error("Data tidak dapat disimpan ke server.");
      const saved=await response.json();serverStateVersion=Number(saved.version);lastSyncedState=clone(payload);stateDirty=!sameValue(payload,statePayload());syncErrorShown=false;
    }
    if(stateDirty)showSyncError("Sinkronisasi tertunda. Periksa koneksi lalu coba lagi.");
  }catch(error){showSyncError(error.message||"Sinkronisasi gagal. Periksa koneksi ke server.");}
  finally{syncInFlight=false;if(stateDirty&&apiToken)queueServerSync();}
}
function queueServerSync(){
  if(!apiToken||location.protocol==="file:")return;
  clearTimeout(serverSyncTimer);serverSyncTimer=setTimeout(syncServerState,250);
}
function saveState(){normalizeInMemoryState();stateDirty=true;queueServerSync();}
async function refreshServerState({notify=false}={}){
  if(!apiToken||stateDirty||syncInFlight||$("#modal")?.classList.contains("open"))return;
  try{
    const remote=await getServerState(),remoteVersion=Number(remote.version||0);
    if(serverStateVersion===null||remoteVersion!==serverStateVersion){
      const currentUser=state.currentUser;state=migrateState(remote.state||{}, {log:true});state.currentUser=currentUser;normalizeInMemoryState();serverStateVersion=remoteVersion;lastSyncedState=statePayload();renderAll();if(notify)toast("Data terbaru dari server telah dimuat.");
    }
    syncErrorShown=false;
  }catch(error){
    if(error.message==="Sesi login berakhir."){logout();toast("Sesi berakhir. Silakan login kembali.");return}
    showSyncError(error.message||"Data server tidak dapat dimuat.");
  }
}
function startServerRefresh(){
  clearInterval(serverRefreshTimer);if(!apiToken)return;
  window.KASIR_REALTIME?.subscribe(()=>refreshServerState({notify:true}));
  const refreshInterval=window.KASIR_REALTIME?.enabled?8000:2000;
  serverRefreshTimer=setInterval(()=>refreshServerState({notify:true}),refreshInterval);
}
state=loadState();
selectedPrintInvoice=state.transactions[0]?.invoice||"";
selectedSupplierId=state.suppliers[0]?.id||"";
function toast(t){
  const el=$("#toast"); el.textContent=t; el.classList.add("show");
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.classList.remove("show"),2200);
}
function openModal(title,body){
  $("#modalTitle").textContent=title; $("#modalBody").innerHTML=body; $("#modal").classList.add("open");
}
function closeModal(){ $("#modal").classList.remove("open"); quickAddTarget=""; }
function uniqueSuffix(){return crypto.randomUUID?.().replaceAll("-","")||`${Date.now().toString(36)}${Math.random().toString(36).slice(2,10)}`}
function nextId(prefix){return `${prefix}-${uniqueSuffix()}`}
function nextInvoice(){
  const sequenceNumbers=state.transactions
    .map(transaction=>String(transaction.invoice??""))
    .filter(invoice=>/^\d{1,9}$/.test(invoice))
    .map(Number);
  return String(sequenceNumbers.length?Math.max(...sequenceNumbers)+1:0);
}
function formatDateTime(v){
  try{return new Intl.DateTimeFormat("id-ID",{dateStyle:"short",timeStyle:"medium"}).format(new Date(v))}
  catch{return v}
}
function productById(id){return state.products.find(p=>p.id===id)}
function productByName(name){return state.products.find(p=>p.name===name)}
function currentUser(){return sessionUser}
function hasPermission(permission){
  const level=currentUser()?.level||"KASIR";
  if(level==="ADMINISTRATOR")return true;
  return ["cashier","products-view","transactions-view","print","password"].includes(permission);
}
function requirePermission(permission){if(hasPermission(permission))return true;toast("Akses ini hanya untuk ADMINISTRATOR.");return false}
function calculateTransactionTotals(items,discountInput=0){
  const subtotal=items.reduce((sum,item)=>sum+Number(item.amount||0),0), method=state.settings.discountMethod;
  const raw=Math.max(0,Number(discountInput)||0);
  const discountAmount=Math.min(subtotal,method==="Persen"?subtotal*raw/100:raw);
  const discountPercent=method==="Persen"?Math.min(100,raw):(subtotal?discountAmount/subtotal*100:0);
  const taxPercent=Math.max(0,Number(state.settings.taxPercent)||0), taxBase=subtotal-discountAmount, taxAmount=taxBase*taxPercent/100;
  return {subtotal,discountPercent,discountAmount,taxPercent,taxAmount,total:taxBase+taxAmount};
}
function calculateWeightedAverageCost(currentStock,currentCost,incomingQty,incomingCost){
  const oldStock=Math.max(0,toSafeNumber(currentStock)),oldCost=Math.max(0,toSafeNumber(currentCost));
  const addedStock=Math.max(0,toSafeNumber(incomingQty)),addedCost=Math.max(0,toSafeNumber(incomingCost));
  const newStock=oldStock+addedStock;
  return newStock?(oldStock*oldCost+addedStock*addedCost)/newStock:0;
}
function csvDownload(filename,headers,rows){
  const data=[headers,...rows].map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob(["\ufeff"+data],{type:"text/csv"}));
  a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),500);
}
function backupData(){
  if(!requirePermission("backup"))return;
  state.lastBackupAt=new Date().toISOString(); saveState();
  const blob=new Blob([JSON.stringify(statePayload(),null,2)],{type:"application/json"}), a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download=`backup-kasir-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);
  toast("Backup data berhasil dibuat.");
}
function restoreData(file){
  if(!requirePermission("backup")||!file)return;
  const reader=new FileReader();reader.onload=()=>{
    try{
      const parsed=JSON.parse(reader.result);
      if(!parsed||typeof parsed!=="object"||!Array.isArray(parsed.products)||!Array.isArray(parsed.transactions)||JSON.stringify(parsed).match(/password|password_hash|token|jwt|secret|supabase/i))throw new Error("Struktur backup tidak valid");
      if(!confirm("Restore akan mengganti seluruh data aplikasi saat ini. Lanjutkan?"))return;
      state=migrateState(parsed,{log:true});saveState();cart=[];selectedPrintInvoice=state.transactions[0]?.invoice||"";renderAll();toast("Data berhasil dipulihkan.");
    }catch(error){toast("File backup tidak valid atau rusak.");}
  };reader.readAsText(file);
}

async function login(username,password){
  if(location.protocol!=="file:"){
    try{
      const response=await fetch(`${API_BASE_URL}/auth/login`,{method:"POST",credentials:"include",signal:timeoutSignal(),headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
      if(response.ok){
        const session=await response.json();await activateSession(session.user);return;
      }
      if(response.status===401)return toast("Username atau password salah.");
      return toast(response.status===403?"Anda tidak memiliki izin untuk melakukan tindakan ini.":"Server belum dapat dihubungi.");
    }catch{apiToken="";return toast(navigator.onLine?"Server belum dapat dihubungi.":"Koneksi internet terputus.");}
  }
  toast("Aplikasi harus dijalankan melalui server.");
}
async function activateSession(user){
  apiToken="cookie";sessionUser=user;
  const remote=await getServerState();
  const hasRemoteState=Boolean(remote?.state&&Object.keys(remote.state).length);
  if(hasRemoteState)state=migrateState(remote.state,{log:true});
  serverStateVersion=Number(remote?.version||0);lastSyncedState=clone(remote?.state||{});stateDirty=!hasRemoteState;syncErrorShown=false;
  state.currentUser=user.username;normalizeInMemoryState();showApp();if(stateDirty)queueServerSync();
}
async function restoreSession(){
  if(location.protocol==="file:"){document.body.classList.remove("session-checking");return}
  try{
    const response=await fetch(`${API_BASE_URL}/auth/me`,{credentials:"include",signal:timeoutSignal(),cache:"no-store"});
    if(response.status===401)return;
    if(!response.ok)throw new Error("Server belum dapat memulihkan sesi.");
    await activateSession(await response.json());
  }catch(error){
    apiToken="";sessionUser=null;
    if(error.name==="TimeoutError"||error.name==="AbortError")toast("Waktu tunggu server habis. Silakan login kembali.");
    else if(!navigator.onLine)toast("Koneksi internet terputus.");
  }finally{document.body.classList.remove("session-checking")}
}
function showApp(){
  $("#loginScreen").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#activeUser").textContent=state.currentUser || "-";
  const admin=sessionUser?.level==="ADMINISTRATOR";
  const cashierPages=new Set(["dashboard","cashier","transactions","print","products","password","help"]);
  $$("#topNav [data-page]").forEach(button=>button.classList.toggle("hidden",admin?button.dataset.page==="password":!cashierPages.has(button.dataset.page)));
  goPage("dashboard");startServerRefresh();if(sessionUser?.level==="ADMINISTRATOR")loadUsers().catch(error=>toast(error.message));
}
function logout(){
  fetch(`${API_BASE_URL}/auth/logout`,{method:"POST",credentials:"include"}).catch(()=>{});window.KASIR_REALTIME?.unsubscribe();state.currentUser=null;sessionUser=null;users=[];normalizeInMemoryState();apiToken="";serverStateVersion=null;lastSyncedState=null;stateDirty=false;clearInterval(serverRefreshTimer);$("#app").classList.add("hidden"); $("#loginScreen").classList.remove("hidden");
}

function goPage(name){
  const permissions={settings:"settings",references:"references",suppliers:"suppliers",customers:"customers",incoming:"incoming",stocktake:"stocktake"};
  if(permissions[name]&&!requirePermission(permissions[name]))return;
  $$(".page").forEach(x=>x.classList.remove("active"));
  $(`#${name}Page`).classList.add("active");
  $("main").classList.toggle("supplier-layout",name==="suppliers");
  $("main").classList.toggle("settings-layout",name==="settings");
  $("main").classList.toggle("references-layout",name==="references");
  $("main").classList.toggle("cashier-layout",name==="cashier");
  $("main").classList.toggle("transactions-layout",name==="transactions");
  $("main").classList.toggle("print-layout",name==="print");
  $("main").classList.toggle("products-layout",name==="products");
  $("main").classList.toggle("customers-layout",name==="customers");
  $("main").classList.toggle("incoming-layout-page",name==="incoming");
  $("main").classList.toggle("stocktake-layout-page",name==="stocktake");
  $("main").classList.toggle("dashboard-layout",name==="dashboard");
  $("main").classList.toggle("help-layout",name==="help");
  $$("#topNav button[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===name));
  const pageMeta={
    dashboard:["","DASHBOARD","Ringkasan aktivitas dan kondisi toko"],
    settings:["","PENGATURAN","Kelola informasi toko, bank, dan pengaturan sistem"],
    references:["","TABEL REFERENSI","Kelola pengguna dan data referensi aplikasi"],
    products:["","PRODUK","Kelola produk, harga, dan persediaan barang"],
    suppliers:["🚚","SUPPLIER","Kelola informasi pemasok barang"],
    customers:["","PELANGGAN","Kelola informasi pelanggan toko"],
    incoming:["↙","BARANG MASUK","Catat pembelian dan penambahan stok barang"],
    cashier:["🛒","TRANSAKSI KASIR","Kelola transaksi penjualan toko"],
    transactions:["▤","RIWAYAT TRANSAKSI","Lihat dan kelola riwayat transaksi penjualan"],
    print:["🖨","CETAK NOTA","Cari dan cetak dokumen transaksi"],
    stocktake:["✓","STOK OPNAME","Cocokkan stok sistem dengan stok fisik"],
    password:["🔐","GANTI PASSWORD","Perbarui keamanan akun pengguna"],
    help:["","BANTUAN","Panduan singkat penggunaan aplikasi"]
  };
  const [icon,title,description]=pageMeta[name]||["•",name.toUpperCase(),""];
  $("#pageHeadingIcon").textContent=icon;
  $("#pageHeadingTitle").textContent=title;
  $("#pageHeadingDescription").textContent=description;
  $("#breadcrumbLabel").textContent=title.toLowerCase().replace(/(^|\s)\S/g,x=>x.toUpperCase());
  renderAll();
}
function fillSelect(el,items,valueFn,labelFn,includeBlank=false,blankLabel="-- Pilih --"){
  const current=el.value;
  el.innerHTML=(includeBlank?`<option value="">${blankLabel}</option>`:"")+items.map(x=>`<option value="${esc(valueFn(x))}">${esc(labelFn(x))}</option>`).join("");
  if([...el.options].some(o=>o.value===current)) el.value=current;
}

function renderSettings(){
  const s=state.settings;
  $("#workbookName").textContent=s.storeName;
  const map={
    setStoreName:"storeName",setAddress:"address",setPhone:"phone",setEmail:"email",
    setCashier:"defaultCashier",setDiscountMethod:"discountMethod",setTax:"taxPercent",setBank1Name:"bank1Name",setBank1Number:"bank1Number",
    setBank1Holder:"bank1Holder",setBank2Name:"bank2Name",setBank2Number:"bank2Number",
    setBank2Holder:"bank2Holder",setReceiptFooter1:"receiptFooter1",setReceiptFooter2:"receiptFooter2",
    setReceiptFooter3:"receiptFooter3",setInvoiceFooter1:"invoiceFooter1",setInvoiceFooter2:"invoiceFooter2",
    setInvoiceFooter3:"invoiceFooter3",setInvoiceRegards:"invoiceRegards"
  };
  Object.entries(map).forEach(([id,key])=>{const el=$("#"+id); if(el)el.value=s[key]??""});
}

function renderDashboard(){
  if(!$("#dashboardDate").value)$("#dashboardDate").value=today();const selectedDate=$("#dashboardDate").value;
  const daily=state.transactions.filter(t=>String(t.createdAt||"").slice(0,10)===selectedDate),sales=daily.reduce((s,t)=>s+Number(t.total||0),0),profit=daily.reduce((s,t)=>s+t.items.reduce((a,i)=>a+Number(i.profit||0),0),0),moneyIn=daily.reduce((s,t)=>s+getTransactionCashIn(t),0),receivable=daily.reduce((s,t)=>s+Number(t.remaining||0),0);
  const incomingToday=state.incoming.filter(x=>x.date===selectedDate),incomingValue=incomingToday.reduce((s,x)=>s+Number(x.total||0),0),lowStocks=state.products.filter(p=>p.trackStock&&Number(p.stock||0)<=Number(p.minStock||0)),emptyStocks=lowStocks.filter(p=>Number(p.stock||0)<=0);
  const payments=daily.reduce((m,t)=>{m[t.paymentMethod]=(m[t.paymentMethod]||0)+getTransactionCashIn(t);return m},{});
  $("#dashboardKpis").innerHTML=`<article><div><small>Penjualan Hari Ini</small><strong>${rupiah(sales)}</strong><p>${daily.length} transaksi</p></div></article>${hasPermission("dashboard-profit")?`<article class="green"><div><small>Laba Kotor Hari Ini</small><strong>${rupiah(profit)}</strong><p>${sales?((profit/sales)*100).toFixed(1):0}% dari penjualan</p></div></article>`:""}<article class="purple"><div><small>Uang Masuk Hari Ini</small><strong>${rupiah(moneyIn)}</strong><p>${Object.entries(payments).map(([k,v])=>`${esc(k)}: ${rupiah(v)}`).join(", ")||"Belum ada pembayaran"}</p></div></article><article class="orange"><div><small>Stok Bermasalah</small><strong>${lowStocks.length}</strong><p>${emptyStocks.length} habis, ${lowStocks.length-emptyStocks.length} menipis</p></div></article><article class="cyan"><div><small>Piutang / Sisa</small><strong>${rupiah(receivable)}</strong><p>${daily.filter(t=>t.paymentStatus==="BELUM LUNAS").length} transaksi belum lunas</p></div></article>`;
  const days=[];for(let i=6;i>=0;i--){const d=new Date(selectedDate+"T00:00:00");d.setDate(d.getDate()-i);const key=d.toISOString().slice(0,10),tx=state.transactions.filter(t=>String(t.createdAt||"").slice(0,10)===key);days.push({label:key.slice(8,10)+"/"+key.slice(5,7),sales:tx.reduce((s,t)=>s+Number(t.total||0),0),profit:tx.reduce((s,t)=>s+t.items.reduce((a,x)=>a+Number(x.profit||0),0),0)})}const max=Math.max(...days.map(x=>x.sales),1);
  $("#dashboardChart").innerHTML=`<div class="chart-legend"><span class="sales-legend">Penjualan</span><span class="profit-legend">Laba Kotor</span></div><div class="chart-bars">${days.map(x=>`<div><span class="sales-bar" style="height:${Math.max(3,x.sales/max*150)}px"></span><span class="profit-bar" style="height:${Math.max(2,x.profit/max*150)}px"></span><small>${x.label}</small><b>${x.sales?rupiah(x.sales):"Rp0"}</b></div>`).join("")}</div>`;
  $("#dashboardStockIssues").innerHTML=lowStocks.slice(0,8).map(p=>`<div class="dashboard-data-row"><span><b>${esc(p.name)}</b><small>Minimum ${money(p.minStock)} ${esc(p.unit)}</small></span><strong class="${p.stock<=0?"negative":""}">${money(p.stock)} ${esc(p.unit)}</strong></div>`).join("")||`<p class="dashboard-empty">Semua stok masih aman.</p>`;
  $("#dashboardRecentTransactions").innerHTML=daily.slice(0,6).map(t=>`<div class="dashboard-data-row"><span><b>${esc(t.invoice)}</b><small>${esc(t.customer||"UMUM")} · ${esc(t.paymentMethod)}</small></span><strong>${rupiah(t.total)}</strong></div>`).join("")||`<p class="dashboard-empty">Belum ada transaksi pada tanggal ini.</p>`;
  const productSales={};daily.forEach(t=>t.items.forEach(i=>{const x=productSales[i.productId]||(productSales[i.productId]={name:i.name,qty:0,revenue:0,profit:0});x.qty+=Number(i.qty||0);x.revenue+=Number(i.amount||0);x.profit+=Number(i.profit||0)}));const topProducts=Object.values(productSales).sort((a,b)=>b.qty-a.qty).slice(0,6);
  $("#dashboardTopProducts").innerHTML=topProducts.map((x,i)=>`<div class="dashboard-data-row ranked"><i>${i+1}</i><span><b>${esc(x.name)}</b><small>${money(x.qty)} terjual</small></span><strong>${rupiah(x.revenue)}</strong></div>`).join("")||`<p class="dashboard-empty">Belum ada produk terjual.</p>`;
  const month=selectedDate.slice(0,7),monthlyIncoming=state.incoming.filter(x=>x.date.startsWith(month)),purchaseTotal=monthlyIncoming.reduce((s,x)=>s+Number(x.total||0),0),supplierTotals=monthlyIncoming.reduce((m,x)=>{m[x.supplier]=(m[x.supplier]||0)+Number(x.total||0);return m},{}),topSuppliers=Object.entries(supplierTotals).sort((a,b)=>b[1]-a[1]).slice(0,3);
  $("#dashboardPurchases").innerHTML=`<div class="purchase-summary"><span><small>Total Pembelian</small><b>${rupiah(purchaseTotal)}</b></span><span><small>Total Transaksi</small><b>${monthlyIncoming.length}</b></span></div>${topSuppliers.map(([name,value],i)=>`<div class="dashboard-data-row"><span>${i+1}. ${esc(name||"Tanpa supplier")}</span><b>${rupiah(value)}</b></div>`).join("")}`;
  const unpaid=state.transactions.filter(t=>t.paymentStatus==="BELUM LUNAS"), allReceivable=unpaid.reduce((sum,t)=>sum+Number(t.remaining||0),0);
  $("#dashboardNotifications").innerHTML=`<p class="critical">${emptyStocks.length} produk stok habis</p><p class="warning">${lowStocks.length-emptyStocks.length} produk stok menipis</p><p class="warning">${unpaid.length} transaksi belum lunas · ${rupiah(allReceivable)}</p>${state.lastBackupAt?`<p class="success">Backup terakhir: ${formatDateTime(state.lastBackupAt)}</p>`:""}`;
}
function saveSettings(e){
  if(!requirePermission("settings")){e.preventDefault();return}
  e.preventDefault();
  const map={
    setStoreName:"storeName",setAddress:"address",setPhone:"phone",setEmail:"email",
    setCashier:"defaultCashier",setDiscountMethod:"discountMethod",setTax:"taxPercent",setBank1Name:"bank1Name",setBank1Number:"bank1Number",
    setBank1Holder:"bank1Holder",setBank2Name:"bank2Name",setBank2Number:"bank2Number",
    setBank2Holder:"bank2Holder",setReceiptFooter1:"receiptFooter1",setReceiptFooter2:"receiptFooter2",
    setReceiptFooter3:"receiptFooter3",setInvoiceFooter1:"invoiceFooter1",setInvoiceFooter2:"invoiceFooter2",
    setInvoiceFooter3:"invoiceFooter3",setInvoiceRegards:"invoiceRegards"
  };
  Object.entries(map).forEach(([id,key])=>{
    state.settings[key]=id==="setTax"?Number($("#"+id).value||0):$("#"+id).value.trim();
  });
  saveState(); renderAll(); toast("Pengaturan disimpan.");
}

function renderReferences(){
  $$("#referenceTabs button").forEach(b=>b.classList.toggle("active",b.dataset.ref===activeReference));
  if(activeReference==="users") return renderUsers();
  const map={categories:["KATEGORI","Nama Kategori"],units:["SATUAN","Nama Satuan"],payments:["METODE BAYAR","Nama Metode Bayar"]};
  const [title,col]=map[activeReference];
  const list=activeReference==="categories"?state.categories:activeReference==="units"?state.units:state.paymentMethods;
  $("#referenceContent").innerHTML=`
    <article class="reference-card reference-card-compact">
      <header class="reference-card-header"><div><b>${title}</b><span>Kelola ${title.toLowerCase()} aplikasi</span></div><button class="button green" id="addReferenceBtn">Tambah Data</button></header>
      <div class="table-box reference-table-box"><table class="excel-table">
        <thead><tr><th>${col}</th><th>Aksi</th></tr></thead>
        <tbody>${list.length?list.map((x,i)=>`<tr><td>${esc(x)}</td><td><button class="mini-btn edit" data-ref-edit="${i}">Edit</button> <button class="mini-btn delete" data-ref-delete="${i}">Hapus</button></td></tr>`).join(""):`<tr><td colspan="2" class="empty-table">Belum ada data.</td></tr>`}</tbody>
      </table></div>
      <footer class="reference-card-footer"><span>${list.length} data</span><span>Data tersimpan di server</span></footer>
    </article>`;
}
function renderUsers(){
  $("#referenceContent").innerHTML=`
    <article class="reference-card">
      <header class="reference-card-header"><div><b>Manajemen Pengguna</b><span>Kelola akun dan akses aplikasi</span></div><div class="reference-card-actions"><button class="button green" id="addUserBtn">Tambah Pengguna</button></div></header>
      <div class="table-box reference-table-box"><table class="excel-table">
        <thead><tr><th>Username</th><th>Level</th><th>Aktif</th><th>Aksi</th></tr></thead>
        <tbody>${users.map(u=>`<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.level)}</td><td><span class="reference-status ${u.active?"active":"inactive"}">${u.active?"Aktif":"Tidak Aktif"}</span></td>
        <td><button class="mini-btn edit" data-user-edit="${u.id}">Edit</button> <button class="mini-btn delete" data-user-delete="${u.id}">Hapus</button></td></tr>`).join("")}</tbody>
      </table></div>
      <footer class="reference-card-footer"><span>${users.length} pengguna</span><span>Password tidak pernah ditampilkan</span></footer>
    </article>`;
}
function referenceModal(index=null){
  const list=activeReference==="categories"?state.categories:activeReference==="units"?state.units:state.paymentMethods;
  openModal(index===null?"Tambah Referensi":"Edit Referensi",`
    <form id="referenceForm" class="modal-form"><label class="wide">Nama<input id="referenceName" value="${index===null?"":esc(list[index])}" required></label>
    <input type="hidden" id="referenceIndex" value="${index===null?"":index}"><div class="form-buttons wide"><button class="button green">Simpan</button></div></form>`);
}
function userModal(id=null){
  const u=users.find(x=>x.id===id);
  openModal(u?"Edit Pengguna":"Tambah Pengguna",`
    <form id="userForm" class="modal-form">
      <input id="userId" type="hidden" value="${u?.id||""}">
      <label>Username<input id="userUsername" value="${esc(u?.username||"")}" required></label>
      <label>${u?"Ganti Password (opsional)":"Password"}<span class="password-input-wrap"><input id="userPassword" type="password" minlength="8" ${u?"":"required"} autocomplete="new-password"><button class="password-toggle" id="toggleUserPassword" type="button" aria-label="Tampilkan password" aria-pressed="false">Lihat</button></span></label>
      <label>Level<select id="userLevel"><option ${u?.level==="ADMINISTRATOR"?"selected":""}>ADMINISTRATOR</option><option ${u?.level==="KASIR"?"selected":""}>KASIR</option></select></label>
      <label>Aktif<select id="userActive"><option value="true" ${u?.active!==false?"selected":""}>YA</option><option value="false" ${u?.active===false?"selected":""}>TIDAK</option></select></label>
      <div class="form-buttons wide"><button class="button green">Simpan</button></div>
    </form>`);
}

function renderProducts(){
  const isAdmin=hasPermission("products-manage");
  fillSelect($("#productCategoryFilter"),state.categories,x=>x,x=>x,true,"Semua Kategori");
  const q=$("#productSearch").value.toLowerCase(),category=$("#productCategoryFilter").value,stockFilter=$("#productStockFilter").value;
  const rows=state.products.filter(p=>(p.name.toLowerCase().includes(q)||p.category.toLowerCase().includes(q))&&(!category||p.category===category)&&(!stockFilter||(stockFilter==="empty"?Number(p.stock)<=0:stockFilter==="low"?Number(p.stock)>0&&Number(p.stock)<=Number(p.minStock||0):Number(p.stock)>Number(p.minStock||0))));
  const pageSize=10,pageCount=Math.max(1,Math.ceil(rows.length/pageSize));productPage=Math.min(Math.max(productPage,1),pageCount);const start=(productPage-1)*pageSize,pagedRows=rows.slice(start,start+pageSize);
  $("#productRecordCount").textContent=`${rows.length} produk`;
  $("#productPageInfo").textContent=rows.length?`Menampilkan ${start+1} sampai ${Math.min(start+pageSize,rows.length)} dari ${rows.length} produk`:`Tidak ada produk`;
  const cost=rows.reduce((s,p)=>s+p.costPrice,0), retail=rows.reduce((s,p)=>s+p.retailPrice,0),
        wholesale=rows.reduce((s,p)=>s+p.wholesalePrice,0), stock=rows.reduce((s,p)=>s+Number(p.stock||0),0),
        stockValue=rows.reduce((s,p)=>s+p.costPrice*Number(p.stock||0),0);
  $("#productSummary").innerHTML=`<article><div><small>Total Record</small><strong>${rows.length}</strong><p>Produk terdaftar</p></div></article>${isAdmin?`<article><div><small>Total Harga Modal</small><strong>${rupiah(cost)}</strong><p>Total seluruh modal</p></div></article>`:""}<article><div><small>Harga Jual Satuan</small><strong>${rupiah(retail)}</strong><p>Total harga jual satuan</p></div></article><article><div><small>Harga Jual Grosir</small><strong>${rupiah(wholesale)}</strong><p>Total harga jual grosir</p></div></article><article><div><small>Total Stok</small><strong>${money(stock)}</strong><p>Total seluruh stok</p></div></article>${isAdmin?`<article><div><small>Nilai Modal Stok</small><strong>${rupiah(stockValue)}</strong><p>Total nilai modal stok</p></div></article>`:""}`;
  $("#productTableBody").innerHTML=pagedRows.length?pagedRows.map(p=>`<tr>
    <td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${esc(p.unit)}</td><td>${p.trackStock?"YA":"TIDAK"}</td>
    <td class="money">${isAdmin?money(p.costPrice):"-"}</td><td class="money">${money(p.retailPrice)}</td><td class="money">${money(p.wholesalePrice)}</td>
    <td class="money">${money(p.discount)}</td><td class="money"><span class="product-stock ${p.stock<=0?"empty":p.stock<=p.minStock?"low":""}">${money(p.stock)}</span></td><td class="money">${money(p.costPrice*p.stock)}</td>
    <td>${isAdmin?`<button class="mini-btn edit" data-product-edit="${p.id}">Edit</button> <button class="mini-btn delete" data-product-delete="${p.id}">Hapus</button>`:"-"}</td>
  </tr>`).join(""):`<tr><td colspan="11" class="empty-table">Produk tidak ditemukan.</td></tr>`;
  const visible=[];for(let p=1;p<=pageCount;p++){if(p===1||p===pageCount||Math.abs(p-productPage)<=1)visible.push(p)}let last=0,buttons=[];for(const p of visible){if(p-last>1)buttons.push(`<span>…</span>`);buttons.push(`<button class="${p===productPage?"active":""}" data-product-page="${p}">${p}</button>`);last=p}$("#productPagination").innerHTML=`<button data-product-page="${productPage-1}" ${productPage===1?"disabled":""}>‹</button>${buttons.join("")}<button data-product-page="${productPage+1}" ${productPage===pageCount?"disabled":""}>›</button>`;
}
function productModal(id=null,initialName=""){
  const p=productById(id);
  openModal(p?"Edit Produk":"Tambah Produk",`
  <form id="productForm" class="modal-form">
    <input id="productId" type="hidden" value="${p?.id||""}">
    <label class="wide">Nama Produk<input id="productName" value="${esc(p?.name||initialName)}" required></label>
    <label>Kategori<select id="productCategory">${state.categories.map(x=>`<option ${x===p?.category?"selected":""}>${esc(x)}</option>`).join("")}</select></label>
    <label>Satuan<select id="productUnit">${state.units.map(x=>`<option ${x===p?.unit?"selected":""}>${esc(x)}</option>`).join("")}</select></label>
    <label>Hitung Stok<select id="productTrack"><option value="true" ${p?.trackStock!==false?"selected":""}>YA</option><option value="false" ${p?.trackStock===false?"selected":""}>TIDAK</option></select></label>
    <label>Aktif<select id="productActive"><option value="true" ${p?.active!==false?"selected":""}>YA</option><option value="false" ${p?.active===false?"selected":""}>TIDAK</option></select></label>
    <label>Harga Modal<input id="productCost" type="number" min="0" value="${p?.costPrice||0}"></label>
    <label>Harga Jual Satuan<input id="productRetail" type="number" min="0" value="${p?.retailPrice||0}"></label>
    <label>Harga Jual Grosir<input id="productWholesale" type="number" min="0" value="${p?.wholesalePrice||0}"></label>
    <label>Diskon<input id="productDiscount" type="number" min="0" value="${p?.discount||0}"></label>
    <label>Stok<input id="productStock" type="number" min="0" step="0.01" value="${p?.stock||0}"></label>
    <label>Stok Minimum<input id="productMinStock" type="number" min="0" value="${p?.minStock||5}"></label>
    <div class="form-buttons wide"><button class="button green">Simpan</button></div>
  </form>`);
}

function renderSuppliers(){
  const q=$("#supplierSearch").value.toLowerCase();
  const rows=state.suppliers.filter(x=>Object.values(x).join(" ").toLowerCase().includes(q));
  $("#supplierRecordInfo").textContent=`Menampilkan ${rows.length} dari ${state.suppliers.length} data`;
  $("#supplierTableBody").innerHTML=rows.length?rows.map(x=>`<tr class="supplier-row ${x.id===selectedSupplierId?"selected-row":""}" data-supplier-view="${x.id}" tabindex="0" title="Klik untuk melihat detail">
    <td><b>${esc(x.name)}</b></td><td>${esc(x.address||"-")}</td><td>${esc(x.phone||"-")}</td><td>${esc(x.email||"-")}</td><td>${esc(x.note||"-")}</td></tr>`).join(""):`<tr><td colspan="5" class="empty-table">Supplier tidak ditemukan.</td></tr>`;
  let selected=state.suppliers.find(x=>x.id===selectedSupplierId);
  if(!selected&&rows.length){selected=rows[0];selectedSupplierId=selected.id}
  $("#supplierDetail").innerHTML=selected?`<div class="detail-card-title"><b>Detail Supplier</b><span>×</span></div>
    <div class="supplier-identity"><span>▦</span><div><h3>${esc(selected.name)}</h3></div></div>
    <dl><dt>Telepon / HP</dt><dd>${esc(selected.phone||"-")}</dd><dt>Email</dt><dd>${esc(selected.email||"-")}</dd><dt>Alamat</dt><dd>${esc(selected.address||"-")}</dd><dt>Keterangan</dt><dd>${esc(selected.note||"-")}</dd></dl>
    <div class="supplier-detail-actions"><button class="button blue" data-supplier-edit="${selected.id}">✎ Edit Supplier</button><button class="button red" data-supplier-delete="${selected.id}">♲ Hapus</button></div>`:`<div class="supplier-empty">Belum ada data supplier.</div>`;
}
function renderCustomers(){
  const regions=[...new Set(state.customers.map(x=>String(x.address||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"id"));
  fillSelect($("#customerRegionFilter"),regions,x=>x,x=>x,true,"Semua Wilayah");
  const q=$("#customerSearch").value.toLowerCase(),region=$("#customerRegionFilter").value;
  const rows=state.customers.filter(x=>Object.values(x).join(" ").toLowerCase().includes(q)&&(!region||x.address===region));
  const pageSize=10,pageCount=Math.max(1,Math.ceil(rows.length/pageSize));customerPage=Math.min(Math.max(customerPage,1),pageCount);const start=(customerPage-1)*pageSize,pagedRows=rows.slice(start,start+pageSize);
  $("#customerRecordCount").textContent=`${rows.length} pelanggan`;$("#customerPageInfo").textContent=rows.length?`Menampilkan ${start+1} hingga ${Math.min(start+pageSize,rows.length)} dari ${rows.length} pelanggan`:`Tidak ada pelanggan`;
  $("#customerTableBody").innerHTML=pagedRows.length?pagedRows.map((x,i)=>`<tr class="${i===0?"customer-highlight":""}"><td><b>${esc(x.name)}</b></td><td>${esc(x.address||"-")}</td><td>${esc(x.phone||"-")}</td><td>${esc(x.email||"-")}</td><td>${esc(x.note||"-")}</td><td><button class="mini-btn edit" data-customer-edit="${x.id}">Edit</button> <button class="mini-btn delete" data-customer-delete="${x.id}">Hapus</button></td></tr>`).join(""):`<tr><td colspan="6" class="empty-table">Pelanggan tidak ditemukan.</td></tr>`;
  const visible=[];for(let p=1;p<=pageCount;p++){if(p===1||p===pageCount||Math.abs(p-customerPage)<=1)visible.push(p)}let last=0,buttons=[];for(const p of visible){if(p-last>1)buttons.push(`<span>…</span>`);buttons.push(`<button class="${p===customerPage?"active":""}" data-customer-page="${p}">${p}</button>`);last=p}$("#customerPagination").innerHTML=`<button data-customer-page="${customerPage-1}" ${customerPage===1?"disabled":""}>‹</button>${buttons.join("")}<button data-customer-page="${customerPage+1}" ${customerPage===pageCount?"disabled":""}>›</button>`;
}
function contactModal(type,id=null,initialName=""){
  const list=type==="supplier"?state.suppliers:state.customers;
  const x=list.find(a=>a.id===id);
  const label=type==="supplier"?"Supplier":"Pelanggan";
  openModal(x?`Edit ${label}`:`Tambah ${label}`,`
  <form id="contactForm" class="modal-form">
    <input id="contactType" type="hidden" value="${type}"><input id="contactId" type="hidden" value="${x?.id||""}">
    <label class="wide">Nama ${label}<input id="contactName" value="${esc(x?.name||initialName)}" required></label>
    <label class="wide">Alamat<input id="contactAddress" value="${esc(x?.address||"")}"></label>
    <label>Telepon/HP<input id="contactPhone" value="${esc(x?.phone||"")}"></label>
    <label>Email<input id="contactEmail" value="${esc(x?.email||"")}"></label>
    <label class="wide">Keterangan<input id="contactNote" value="${esc(x?.note||"")}"></label>
    <div class="form-buttons wide"><button class="button green">Simpan</button></div>
  </form>`);
}

function renderIncoming(){
  fillSelect($("#incomingSupplier"),state.suppliers,x=>x.name,x=>x.name,true,"-- Supplier --");
  fillSelect($("#incomingProduct"),state.products.filter(p=>p.active),x=>x.id,x=>x.name,true,"-- Produk --");
  const q=$("#incomingSearch").value.toLowerCase(), date=$("#incomingDateFilter").value;
  const rows=state.incoming.filter(x=>(x.product+" "+x.supplier).toLowerCase().includes(q)&&(!date||x.date===date));
  const qty=rows.reduce((s,x)=>s+Number(x.qty||0),0), total=rows.reduce((s,x)=>s+Number(x.total||0),0);
  $("#incomingSummary").innerHTML=`<article><div><small>Total Record</small><strong>${rows.length}</strong><p>Catatan barang masuk</p></div></article><article class="green"><div><small>Total Jumlah</small><strong>${money(qty)}</strong><p>Jumlah seluruh item</p></div></article><article class="purple"><div><small>Total Nilai</small><strong>${rupiah(total)}</strong><p>Nilai seluruh pembelian</p></div></article><article class="orange"><div><small>Rata-rata per Record</small><strong>${rupiah(rows.length?total/rows.length:0)}</strong><p>Rata-rata nilai pembelian</p></div></article>`;
  $("#incomingTableBody").innerHTML=rows.length?rows.map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.supplier)}</td><td>${esc(x.product)}</td><td>${esc(x.category)}</td><td>${esc(x.unit)}</td><td>${money(x.purchasePrice)}</td><td>${money(x.qty)}</td><td>${money(x.total)}</td><td><button class="mini-btn delete" data-incoming-delete="${x.id}">Hapus</button></td></tr>`).join(""):`<tr><td colspan="9" class="empty-table">Belum ada catatan barang masuk.</td></tr>`;
  updateIncomingSummary();
}
function updateIncomingProduct(){
  const p=productById($("#incomingProduct").value);
  $("#incomingCategory").value=p?.category||""; $("#incomingUnit").value=p?.unit||"";
  $("#incomingPrice").value=p?.costPrice||0; updateIncomingTotal();
}
function updateIncomingTotal(){
  $("#incomingTotal").value=money(Number($("#incomingPrice").value||0)*Number($("#incomingQty").value||0)); updateIncomingSummary();
}
function updateIncomingSummary(){
  const product=productById($("#incomingProduct").value),qty=Number($("#incomingQty").value||0),total=Number($("#incomingPrice").value||0)*qty;
  $("#incomingSummarySupplier").textContent=$("#incomingSupplier").value||"-";$("#incomingSummaryProduct").textContent=product?.name||"-";$("#incomingSummaryQty").textContent=money(qty);$("#incomingSummaryTotal").textContent=rupiah(total);
}

function renderCashier(){
  const s=state.settings;
  $("#cashierStoreName").textContent=s.storeName; $("#cashierAddress").textContent=s.address;
  $("#cashierPhone").textContent="WA/HP : "+s.phone; $("#cashierName").textContent=state.currentUser||s.defaultCashier;
  const customerInput=$("#cashCustomer"),customerNames=["UMUM",...state.customers.map(customer=>customer.name)].filter((name,index,names)=>name&&names.indexOf(name)===index);
  $("#cashCustomerOptions").innerHTML=customerNames.map(name=>`<option value="${esc(name)}"></option>`).join("");
  if(!customerInput.value)customerInput.value="UMUM";
  $("#quickAddCustomerBtn").classList.toggle("hidden",!hasPermission("customers"));
  fillSelect($("#cashPaymentMethod"),state.paymentMethods,x=>x,x=>x,true,"-- Pilih metode bayar --");
  const activeProducts=state.products.filter(product=>product.active);
  $("#cashProductOptions").innerHTML=activeProducts.map(product=>`<option value="${esc(product.name)}" label="Stok ${money(product.stock)}"></option>`).join("");
  $("#quickAddProductBtn").classList.toggle("hidden",!hasPermission("products-manage"));
  if(!$("#cashInvoice").value) $("#cashInvoice").value=nextInvoice();
  $("#cashDateTime").value=nowLocal();
  updateCashProduct();
  renderCart();
}
function selectedCashProduct(){
  const input=$("#cashProduct"),value=normalizeProductName(input.value);
  const selectedById=productById(input.dataset.productId);
  if(selectedById?.active&&normalizeProductName(selectedById.name)===value)return selectedById;
  const product=state.products.find(item=>item.active&&normalizeProductName(item.name)===value);
  if(product)input.dataset.productId=product.id;else delete input.dataset.productId;
  return product;
}
function updateCashProduct(){
  const p=selectedCashProduct();
  const price=$("#cashPriceType").value==="retail"?p?.retailPrice:p?.wholesalePrice;
  $("#cashPrice").value=price||0; $("#cashItemDiscount").value=p?.discount||0; updateCashLine();
}
function updateCashLine(){
  const total=calculateItemAmount($("#cashPrice").value,$("#cashItemDiscount").value,$("#cashQty").value);
  $("#cashLineTotal").value=money(total);
}
function addCartItem(){
  const p=selectedCashProduct(); if(!p)return toast("Produk belum terdaftar. Cari produk lain atau klik + Tambah.");
  const qty=Number($("#cashQty").value||0); if(qty<=0)return toast("Qty tidak valid.");
  const existingQty=cart.filter(x=>x.productId===p.id).reduce((s,x)=>s+x.qty,0);
  if(p.trackStock && qty+existingQty>p.stock)return toast("Stok tidak mencukupi.");
  const price=Number($("#cashPrice").value||0), discount=Number($("#cashItemDiscount").value||0);
  if(discount<0||discount>price)return toast("Diskon item tidak valid.");
  cart.push({lineId:crypto.randomUUID?.()||String(Date.now()),productId:p.id,name:p.name,costPrice:Number(p.costPrice||0),
    priceType:$("#cashPriceType").value==="retail"?"Harga Jual Satuan":"Harga Jual Grosir",
    price,discount,qty,unit:p.unit,amount:calculateItemAmount(price,discount,qty),profit:(price-discount-Number(p.costPrice||0))*qty});
  renderCart(); toast("Produk ditambahkan.");
}
function cartTotals(){
  const totals=calculateTransactionTotals(cart,$("#cashDiscount").value);
  const paymentMethod=$("#cashPaymentMethod").value, entered=Math.max(0,Number($("#cashPayment").value||0));
  if(paymentMethod==="DP")return {...totals,payment:0,change:0,downPayment:entered,remaining:Math.max(0,totals.total-entered),cashIn:entered,paymentStatus:entered>=totals.total?"LUNAS":"BELUM LUNAS"};
  if(paymentMethod&&paymentMethod!=="Tunai")return {...totals,payment:totals.total,change:0,downPayment:0,remaining:0,cashIn:totals.total,paymentStatus:"LUNAS"};
  return {...totals,payment:entered,change:Math.max(0,entered-totals.total),downPayment:0,remaining:0,cashIn:totals.total,paymentStatus:"LUNAS"};
}
function renderCart(){
  $("#cashierCartBody").innerHTML=cart.length?cart.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.name)}</td><td>${money(x.price)}</td><td>${money(x.discount)}</td><td>${money(x.qty)}</td><td>${esc(x.unit)}</td><td>${money(x.amount)}</td><td><button class="mini-btn delete" data-cart-delete="${x.lineId}">Hapus</button></td></tr>`).join(""):`<tr><td colspan="8"><div class="empty-cart"><b>Keranjang masih kosong</b><small>Tambahkan produk untuk memulai transaksi.</small></div></td></tr>`;
  const t=cartTotals();
  const method=$("#cashPaymentMethod").value, isDP=method==="DP", nonCash=method&&method!=="Tunai"&&method!=="DP";
  $("#cashSubtotal").textContent=money(t.subtotal); $("#cashTax").textContent=money(t.taxAmount);
  $("#cashTotal").textContent=money(t.total); $("#cashChange").textContent=money(t.change); $("#cashRemaining").textContent=money(t.remaining);
  $("#cashDiscountLabel").textContent=state.settings.discountMethod==="Persen"?"Diskon (%)":"Diskon";
  $("#cashDiscountPrefix").textContent=state.settings.discountMethod==="Persen"?"%":"Rp";
  $("#cashPaymentLabel").textContent=isDP?"Jumlah DP":nonCash?"Pembayaran":"Tunai";
  $("#cashChangeLabel").textContent=isDP?"Kembalian":"Kembalian";
  $("#cashRemainingRow").classList.toggle("hidden",!isDP); $("#cashChange").closest(".cashier-change").classList.toggle("hidden",isDP||nonCash);
  $("#cashPayment").readOnly=Boolean(nonCash); if(nonCash)$("#cashPayment").value=t.total;
}
function clearCashier(){
  cart=[]; $("#cashDiscount").value=0; $("#cashPayment").value=0; $("#cashCourier").value="";
  $("#cashCustomer").value="UMUM";
  $("#cashPaymentMethod").value=""; $("#cashProduct").value=""; delete $("#cashProduct").dataset.productId; $("#cashPriceType").value="wholesale";
  $("#cashPrice").value=0; $("#cashItemDiscount").value=0; $("#cashQty").value=1; updateCashLine();
  $("#cashInvoice").value=nextInvoice(); renderCart();
}
function saveTransaction(action="save"){
  if(!cart.length)return toast("Belum ada item transaksi.");
  if(!$("#cashPaymentMethod").value)return toast("Pilih metode bayar terlebih dahulu.");
  const t=cartTotals(), paymentMethod=$("#cashPaymentMethod").value;
  if(t.discountAmount>t.subtotal)return toast("Diskon tidak boleh melebihi subtotal.");
  if(paymentMethod==="Tunai"&&t.payment<t.total)return toast("Uang tunai kurang.");
  if(paymentMethod==="DP"&&t.downPayment<=0)return toast("Jumlah DP harus lebih dari Rp0.");
  for(const item of cart){
    const p=productById(item.productId);
    if(p?.trackStock && item.qty>p.stock)return toast(`Stok ${p.name} tidak cukup.`);
  }
  cart.forEach(item=>{const p=productById(item.productId); if(p?.trackStock)p.stock-=item.qty});
  const tx={
    id:$("#cashInvoice").value,invoice:$("#cashInvoice").value,createdAt:new Date().toISOString(),
    cashier:state.currentUser||state.settings.defaultCashier,courier:$("#cashCourier").value.trim(),
    customer:$("#cashCustomer").value.trim()||"UMUM",paymentMethod:$("#cashPaymentMethod").value,items:clone(cart),
    subtotal:t.subtotal,discountPercent:t.discountPercent,discountAmount:t.discountAmount,taxPercent:t.taxPercent,
    taxAmount:t.taxAmount,total:t.total,payment:t.payment,change:t.change,downPayment:t.downPayment,remaining:t.remaining,cashIn:t.cashIn,paymentStatus:t.paymentStatus
  };
  state.transactions.unshift(tx); saveState(); selectedPrintInvoice=tx.invoice; clearCashier(); renderAll();
  toast(action==="pdf"?"Transaksi disimpan. Pilih ‘Simpan sebagai PDF’ pada dialog cetak.":"Transaksi berhasil disimpan.");
  goPage("print");
  if(action==="print"||action==="pdf")printDocument("receipt",tx);
  return tx;
}

function renderTransactions(){
  fillSelect($("#transactionPaymentFilter"),state.paymentMethods,x=>x,x=>x,true,"Semua Metode Bayar");
  const q=$("#transactionSearch").value.toLowerCase(), date=$("#transactionDateFilter").value, payment=$("#transactionPaymentFilter").value;
  const rows=state.transactions.filter(t=>(t.invoice+" "+t.customer).toLowerCase().includes(q)&&(!date||t.createdAt.slice(0,10)===date)&&(!payment||t.paymentMethod===payment));
  const pageSize=10,pageCount=Math.max(1,Math.ceil(rows.length/pageSize));
  transactionPage=Math.min(Math.max(transactionPage,1),pageCount);
  const start=(transactionPage-1)*pageSize,pagedRows=rows.slice(start,start+pageSize);
  $("#transactionRecordCount").innerHTML=`Total Record: <b>${rows.length}</b>`;
  $("#transactionPageInfo").textContent=rows.length?`Menampilkan ${start+1} sampai ${Math.min(start+pageSize,rows.length)} dari ${rows.length} data`:`Tidak ada data transaksi`;
  $("#transactionTableBody").innerHTML=pagedRows.length?pagedRows.map(t=>`<tr><td class="transaction-number">${esc(t.invoice)}</td><td>${formatDateTime(t.createdAt)}</td><td>${esc(t.cashier)}</td><td>${esc(t.courier||"-")}</td><td>${esc(t.customer)}</td><td>${esc(t.paymentMethod)}</td><td>${money(t.items.reduce((s,i)=>s+i.qty,0))}</td><td>${money(t.subtotal)}</td><td>${money(t.discountPercent)}%</td><td>${money(t.discountAmount)}</td><td>${money(t.taxPercent)}%</td><td>${money(t.taxAmount)}</td><td>${money(t.total)}</td><td>${money(t.payment)}</td><td>${money(t.change)}</td><td>${money(t.downPayment)}</td><td>${money(t.remaining)}</td><td><span class="reference-status ${t.paymentStatus==="LUNAS"?"active":"inactive"}">${esc(t.paymentStatus)}</span></td><td><div class="row-actions"><button class="mini-btn view" data-tx-view="${t.invoice}">Detail</button><button class="mini-btn print" data-tx-print="${t.invoice}">Cetak</button>${hasPermission("transactions-delete")?`<button class="mini-btn delete" data-tx-delete="${t.invoice}">Hapus</button>`:""}</div></td></tr>`).join(""):`<tr><td colspan="19" class="empty-table">Transaksi tidak ditemukan.</td></tr>`;
  const visible=[];for(let p=1;p<=pageCount;p++){if(p===1||p===pageCount||Math.abs(p-transactionPage)<=1)visible.push(p)}
  let last=0;const buttons=[];for(const p of visible){if(p-last>1)buttons.push(`<span>…</span>`);buttons.push(`<button class="${p===transactionPage?"active":""}" data-tx-page="${p}">${p}</button>`);last=p}
  $("#transactionPagination").innerHTML=`<button data-tx-page="${transactionPage-1}" ${transactionPage===1?"disabled":""}>‹</button>${buttons.join("")}<button data-tx-page="${transactionPage+1}" ${transactionPage===pageCount?"disabled":""}>›</button>`;
}
function transactionDetail(t){
  if(!t)return toast("Transaksi tidak ditemukan.");
  const isAdmin=hasPermission("transactions-delete");
  openModal("DETAIL TRANSAKSI KELUAR",`
    <div class="modal-detail-grid">
      <div><p>No. Transaksi: <b>${esc(t.invoice)}</b></p><p>Tgl. Transaksi: ${formatDateTime(t.createdAt)}</p><p>Kasir: ${esc(t.cashier)}</p><p>Pengantar: ${esc(t.courier||"-")}</p><p>Pelanggan: ${esc(t.customer)}</p><p>Metode Bayar: ${esc(t.paymentMethod)}</p><p>Status: <b>${esc(t.paymentStatus)}</b></p></div>
      <div><p>Subtotal: <b>${rupiah(t.subtotal)}</b></p><p>Diskon: ${money(t.discountPercent)}% / ${rupiah(t.discountAmount)}</p><p>Pajak: ${money(t.taxPercent)}% / ${rupiah(t.taxAmount)}</p><p>Total: <b>${rupiah(t.total)}</b></p><p>Bayar: ${rupiah(t.payment)}</p><p>Kembali: ${rupiah(t.change)}</p><p>DP: ${rupiah(t.downPayment)}</p><p>Sisa: ${rupiah(t.remaining)}</p></div>
    </div>
    <table class="excel-table"><thead><tr><th>Nama Barang</th>${isAdmin?"<th>Harga Modal</th><th>Profit</th>":""}<th>Tipe Harga</th><th>Harga</th><th>Diskon</th><th>Qty</th><th>Satuan</th><th>Jumlah</th></tr></thead><tbody>
    ${t.items.map(i=>`<tr><td>${esc(i.name)}</td>${isAdmin?`<td>${money(i.costPrice)}</td><td>${money(i.profit)}</td>`:""}<td>${esc(i.priceType)}</td><td>${money(i.price)}</td><td>${money(i.discount)}</td><td>${money(i.qty)}</td><td>${esc(i.unit)}</td><td>${money(i.amount)}</td></tr>`).join("")}</tbody></table>`);
}
function deleteTransaction(invoice){
  if(!requirePermission("transactions-delete"))return;
  const t=state.transactions.find(x=>x.invoice===invoice); if(!t)return;
  if(window.__deletingTransaction)return;
  if(!confirm(`Hapus transaksi ${invoice} dan kembalikan stok?`))return;
  window.__deletingTransaction=true;
  const deleteButtons=$$("[data-tx-delete]").filter(button=>button.dataset.txDelete===String(invoice));deleteButtons.forEach(button=>button.disabled=true);
  const unresolved=[], returns=[];
  for(const item of t.items){
    const qty=toSafeNumber(item.qty);let product=productById(item.productId);
    if(!product)product=findMatchingProduct(item.name,state.products);
    if(!product||qty<=0){unresolved.push(item.name||"Produk tanpa nama");continue}
    returns.push({item,product,qty});
  }
  if(unresolved.length){window.__deletingTransaction=false;deleteButtons.forEach(button=>button.disabled=false);return toast(`Transaksi tidak dihapus. Produk tidak ditemukan: ${[...new Set(unresolved)].join(", ")}`)}
  returns.forEach(({item,product,qty})=>{if(product.trackStock){product.stock=toSafeNumber(product.stock)+qty}if(!item.productId)item.productId=product.id});
  state.transactions=state.transactions.filter(x=>x.invoice!==invoice);saveState();window.__deletingTransaction=false;renderAll();toast("Transaksi dihapus dan stok dikembalikan.");
}
function deleteIncomingRecord(id){
  if(window.__deletingIncoming)return;
  const record=state.incoming.find(item=>item.id===id);if(!record)return;
  if(!confirm("Hapus catatan barang masuk? Stok akan dikurangi kembali."))return;
  window.__deletingIncoming=true;
  const deleteButtons=$$("[data-incoming-delete]").filter(button=>button.dataset.incomingDelete===String(id));deleteButtons.forEach(button=>button.disabled=true);
  const qty=toSafeNumber(record.qty);let product=productById(record.productId);
  if(!product)product=findMatchingProduct(record.product,state.products);
  if(!product){window.__deletingIncoming=false;deleteButtons.forEach(button=>button.disabled=false);return toast(`Barang masuk tidak dihapus. Produk tidak ditemukan: ${record.product||"-"}`)}
  if(qty<=0){window.__deletingIncoming=false;deleteButtons.forEach(button=>button.disabled=false);return toast("Barang masuk tidak dihapus karena jumlahnya tidak valid.")}
  if(product.trackStock&&toSafeNumber(product.stock)<qty){window.__deletingIncoming=false;deleteButtons.forEach(button=>button.disabled=false);return toast("Barang masuk tidak dapat dihapus karena stok saat ini lebih kecil dari jumlah yang akan dikurangi.")}
  if(product.trackStock)product.stock=toSafeNumber(product.stock)-qty;
  if(!record.productId)record.productId=product.id;
  state.incoming=state.incoming.filter(item=>item.id!==id);saveState();window.__deletingIncoming=false;renderAll();toast("Catatan barang masuk dihapus dan stok dikurangi.");
}

function selectedPrintTransaction(){return state.transactions.find(transaction=>transaction.invoice===selectedPrintInvoice)||state.transactions[0]}
function receiptDateParts(value){
  try{const date=new Date(value);return {date:new Intl.DateTimeFormat("id-ID",{day:"2-digit",month:"2-digit",year:"2-digit"}).format(date),time:new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(date)}}
  catch{return {date:String(value||"-"),time:"-"}}
}
function receiptPaymentHtml(transaction){
  if(transaction.paymentMethod==="Tunai")return `<div class="receipt-row"><span class="label">Tunai</span><span class="value">${rupiah(transaction.payment)}</span></div><div class="receipt-row"><span class="label">Kembalian</span><span class="value">${rupiah(transaction.change)}</span></div>`;
  if(transaction.paymentMethod==="DP")return `<div class="receipt-row"><span class="label">DP</span><span class="value">${rupiah(transaction.downPayment)}</span></div><div class="receipt-row"><span class="label">Sisa Pembayaran</span><span class="value">${rupiah(transaction.remaining)}</span></div><div class="receipt-row"><span class="label">Status</span><span class="value">${esc(transaction.paymentStatus)}</span></div>`;
  return `<div class="receipt-row"><span class="label">${esc(transaction.paymentMethod)}</span><span class="value">${rupiah(transaction.cashIn)}</span></div>`;
}
function a4PaymentHtml(transaction){
  if(transaction.paymentMethod==="Tunai")return `<p>Tunai: <b>${rupiah(transaction.payment)}</b></p><p>Kembalian: <b>${rupiah(transaction.change)}</b></p>`;
  if(transaction.paymentMethod==="DP")return `<p>DP: <b>${rupiah(transaction.downPayment)}</b></p><p>Sisa Pembayaran: <b>${rupiah(transaction.remaining)}</b></p><p>Status: <b>${esc(transaction.paymentStatus)}</b></p>`;
  return `<p>${esc(transaction.paymentMethod)}: <b>${rupiah(transaction.cashIn)}</b></p>`;
}
function renderReceiptHtml(transaction){
  const parts=receiptDateParts(transaction.createdAt);
  const items=transaction.items.map(item=>`<section class="receipt-item"><div class="item-name">${esc(item.name)}</div><div class="item-detail"><span>${money(item.qty)} ${esc(item.unit)} × ${rupiah(item.price)}</span><span>${rupiah(item.amount)}</span></div></section>`).join("");
  return `<div class="receipt-content"><header class="receipt-header"><div class="store-name">SUMBER BERKAH<br>SIDOGURO</div><div class="store-address">ROWO JOMBOR / TRUCUK, KLATEN</div><div class="store-phone">081327375989 / 085727435699</div></header><div class="receipt-divider"></div><section class="receipt-meta"><div class="receipt-row"><span class="label">Tanggal</span><span class="value">${esc(parts.date)}</span></div><div class="receipt-row"><span class="label">Jam</span><span class="value">${esc(parts.time)}</span></div><div class="receipt-row"><span class="label">No. Nota</span><span class="value">${esc(transaction.invoice)}</span></div><div class="receipt-row"><span class="label">Kasir</span><span class="value">${esc(transaction.cashier)}</span></div><div class="receipt-row"><span class="label">Pengantar</span><span class="value">${esc(transaction.courier||"-")}</span></div><div class="receipt-row customer-row"><span class="label">Pelanggan</span><span class="value">${esc(transaction.customer||"UMUM")}</span></div></section><div class="receipt-divider"></div><section class="receipt-items">${items}</section><div class="receipt-divider"></div><section class="receipt-summary"><div class="receipt-row"><span class="label">Subtotal</span><span class="value">${rupiah(transaction.subtotal)}</span></div><div class="receipt-row"><span class="label">Diskon</span><span class="value">${rupiah(transaction.discountAmount)}</span></div><div class="receipt-row"><span class="label">Pajak</span><span class="value">${rupiah(transaction.taxAmount)}</span></div><div class="receipt-row total-row"><span class="label">Total</span><span class="value">${rupiah(transaction.total)}</span></div>${receiptPaymentHtml(transaction)}</section><footer class="receipt-footer"><div>Terimakasih atas pembelian Anda</div><div class="footer-message">simpan nota ini sebagai bukti transaksi</div><div>TF MANDIRI : 1380023004349 Farisa</div></footer></div>`;
}

function receiptCss(root){return `${root}{box-sizing:border-box;width:54mm;max-width:54mm;margin:0 auto;padding:1.5mm .5mm 2mm;background:#fff;color:#000;overflow:visible;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:400;line-height:1.12}${root} *{box-sizing:border-box;max-width:100%}${root} p,${root} h1,${root} h2{margin:0}${root} .receipt-content{width:100%;max-width:100%;margin:0;padding:0}${root} .receipt-header{text-align:center}${root} .store-name{text-align:center;font-size:17px;font-weight:700;line-height:1.05;letter-spacing:.1px}${root} .store-address,${root} .store-phone{text-align:center;font-size:11px;font-weight:400;line-height:1.12;white-space:nowrap}${root} .store-address{margin-top:.7mm}${root} .store-phone{margin-top:.35mm}${root} .receipt-divider{margin:1mm 0;border-top:1px dashed #000}${root} .receipt-row{display:grid;grid-template-columns:20mm minmax(0,1fr);column-gap:1mm;align-items:start;margin:0;line-height:1.12}${root} .receipt-row .label,${root} .receipt-row .value{min-width:0;font-weight:400}${root} .receipt-row .value{text-align:right;overflow-wrap:break-word;word-break:normal;white-space:normal}${root} .customer-row{margin:1mm 0}${root} .customer-row .label,${root} .customer-row .value{font-weight:600}${root} .customer-row .value{overflow-wrap:break-word;word-break:normal;white-space:normal}${root} .receipt-item{margin:1mm 0;font-size:12px;break-inside:avoid;page-break-inside:avoid}${root} .item-name{margin:0;font-size:12.5px;font-weight:600;line-height:1.12;overflow-wrap:anywhere}${root} .item-detail{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1mm;margin-top:.15mm;font-size:12px;font-weight:400;line-height:1.12}${root} .item-detail span{min-width:0;overflow-wrap:anywhere}${root} .item-detail span:last-child{text-align:right;white-space:nowrap}${root} .receipt-summary{font-size:12px;font-weight:400;line-height:1.13;break-inside:avoid;page-break-inside:avoid}${root} .total-row{margin:.8mm 0;padding:1mm 0;border-top:1px dashed #000;border-bottom:1px dashed #000;font-size:14px;line-height:1.1}${root} .total-row .label,${root} .total-row .value{font-weight:700}${root} .receipt-footer{margin-top:1.5mm;text-align:center;font-size:11px;font-weight:400;line-height:1.16;overflow-wrap:anywhere;break-inside:avoid;page-break-inside:avoid}${root} .receipt-footer>div{margin-top:1mm}${root} .receipt-footer>div:first-child{margin-top:0}${root} .footer-message{white-space:nowrap}`}
function buildA4Rows(transaction,withUnit=false){return transaction.items.map(item=>`<tr><td>${esc(item.name)}</td><td class="number">${money(item.qty)}</td>${withUnit?`<td>${esc(item.unit)}</td>`:""}<td class="number">${rupiah(item.price)}</td><td class="number">${rupiah(item.amount)}</td></tr>`).join("")}
function buildInvoiceContent(transaction,settings){
  return `<header class="document-header"><div><h2>${esc(settings.storeName)}</h2><p>${esc(settings.address)}</p><p>WA/HP: ${esc(settings.phone)}</p><p>Email: ${esc(settings.email)}</p></div><div><h1>INVOICE</h1><p>No. Invoice: <b>${esc(transaction.invoice)}</b></p><p>Tanggal: ${formatDateTime(transaction.createdAt)}</p><p>Pembayaran: ${esc(transaction.paymentMethod)}</p></div></header><section class="customer-section"><p>Kepada Yth.</p><b>${esc(transaction.customer||"UMUM")}</b></section><div class="invoice-total">JUMLAH YANG HARUS DIBAYAR<br><strong>${rupiah(transaction.total)}</strong></div><table><thead><tr><th>Nama Produk</th><th>Qty</th><th>Harga</th><th>Jumlah</th></tr></thead><tbody>${buildA4Rows(transaction)}</tbody></table><section class="summary-section"><p>Subtotal: <b>${rupiah(transaction.subtotal)}</b></p><p>Diskon: <b>${rupiah(transaction.discountAmount)}</b></p><p>Pajak: <b>${rupiah(transaction.taxAmount)}</b></p><p>Total: <b>${rupiah(transaction.total)}</b></p>${a4PaymentHtml(transaction)}</section><footer class="document-note"><b>Keterangan:</b><p>${esc(settings.invoiceFooter1)}</p><p>${esc(settings.invoiceFooter2)}</p><p>${esc(settings.invoiceFooter3)}</p></footer>`;
}
function buildFakturContent(transaction,settings){
  return `<header class="document-header"><div><h2>${esc(settings.storeName)}</h2><p>${esc(settings.address)}</p><p>WA/HP: ${esc(settings.phone)}</p></div><div><h1>FAKTUR PENJUALAN</h1><p>Tanggal/Jam: ${formatDateTime(transaction.createdAt)}</p><p>No. Faktur: <b>${esc(transaction.invoice)}</b></p><p>Kasir: ${esc(transaction.cashier)}</p></div></header><section class="customer-section"><p>Kepada Yth.</p><b>${esc(transaction.customer||"UMUM")}</b><p>Pengantar: ${esc(transaction.courier||"-")}</p></section><table><thead><tr><th>Nama Produk</th><th>Qty</th><th>Satuan</th><th>Harga</th><th>Jumlah</th></tr></thead><tbody>${buildA4Rows(transaction,true)}</tbody></table><section class="summary-section"><p>Subtotal: <b>${rupiah(transaction.subtotal)}</b></p><p>Diskon: <b>${rupiah(transaction.discountAmount)}</b></p><p>Pajak: <b>${rupiah(transaction.taxAmount)}</b></p><p>Total: <b>${rupiah(transaction.total)}</b></p>${a4PaymentHtml(transaction)}<p>Metode Pembayaran: <b>${esc(transaction.paymentMethod)}</b></p></section><p>Bank: ${esc(settings.bank1Name)} — ${esc(settings.bank1Number)} — ${esc(settings.bank1Holder)}</p><footer class="signature-section"><div class="signature-block"><span>Hormat Kami,</span><span class="signature-space"></span><span>${esc(settings.invoiceRegards)}</span></div><div class="signature-block"><span>Diterima Oleh,</span><span class="signature-space"></span><span>________________</span></div></footer>`;
}
function printContent(type,transaction,settings){return type==="receipt"?renderReceiptHtml(transaction):type==="invoice"?buildInvoiceContent(transaction,settings):buildFakturContent(transaction,settings)}
function renderPrint(){
  const settings=state.settings,transaction=selectedPrintTransaction();
  $("#printReceiptType").value=settings.receiptType;$("#printMethod").value=settings.printMethod;
  if(!transaction){$("#printPreviews").innerHTML="<p>Belum ada transaksi.</p>";return}
  selectedPrintInvoice=transaction.invoice;$("#printInvoiceSearch").value=transaction.invoice;
  $("#printPreviews").innerHTML=`<style>${receiptCss(".print-sheet.receipt")}</style><section class="print-preview-card receipt-preview"><header><b>Preview Struk 58 mm</b><button class="button blue preview-print-button" data-print-document="receipt" type="button">Cetak Struk 58 mm</button></header><div class="preview-canvas"><article class="print-sheet receipt">${renderReceiptHtml(transaction)}</article></div></section><section class="print-preview-card"><header><b>Preview Invoice A4</b><button class="button blue preview-print-button" data-print-document="invoice" type="button">Cetak Invoice A4</button></header><div class="preview-canvas"><article class="print-sheet a4-preview">${buildInvoiceContent(transaction,settings)}</article></div></section><section class="print-preview-card"><header><b>Preview Faktur A4</b><button class="button blue preview-print-button" data-print-document="faktur" type="button">Cetak Faktur A4</button></header><div class="preview-canvas"><article class="print-sheet a4-preview">${buildFakturContent(transaction,settings)}</article></div></section>`;
}
function receiptPrintCss(){return `@page{size:58mm auto;margin:0}*{box-sizing:border-box;max-width:100%}html,body{width:58mm;margin:0;padding:0;background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}body.print-receipt{width:58mm}${receiptCss(".receipt-paper")}@media print{html,body{width:58mm;margin:0;padding:0;background:#fff}.receipt-paper{width:54mm;max-width:54mm;margin:0 auto;padding:1.5mm .5mm 2mm;box-shadow:none;border:0}}`}
function a4PrintCss(){return `@page{size:A4 portrait;margin:12mm}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Arial,sans-serif;font-size:10pt}body.print-a4{background:#fff}.a4-document{width:100%;max-width:186mm;margin:0 auto}.document-header{display:flex;justify-content:space-between;gap:12mm;border-bottom:1px solid #333;padding-bottom:5mm}.document-header>div{max-width:50%}.document-header h1,.document-header h2{margin:0 0 3mm}.document-header p,.customer-section p,.document-note p{margin:1mm 0}.customer-section{margin:5mm 0}.invoice-total{margin:5mm 0;padding:4mm;border:1px solid #333;text-align:center;font-size:12pt}.invoice-total strong{font-size:16pt}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th,td{border:1px solid #555;padding:2.5mm;overflow-wrap:anywhere}th{background:#eee;text-align:left}.number{text-align:right}tr,.summary-section,.signature-section{break-inside:avoid;page-break-inside:avoid}.summary-section{margin:5mm 0 0 auto;width:75mm;text-align:right}.summary-section p{margin:1mm 0}.document-note{margin-top:7mm}.signature-section{display:flex;justify-content:space-between;margin-top:15mm;text-align:center}.signature-block{display:flex;min-width:58mm;flex-direction:column}.signature-space{display:block;height:35mm}`}
function printFrameHtml(type,transaction){
  const receipt=type==="receipt",css=receipt?receiptPrintCss():a4PrintCss(),bodyClass=receipt?"print-receipt":"print-a4",mainClass=receipt?"receipt-paper":"a4-document";
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(type.toUpperCase())} ${esc(transaction.invoice)}</title><style id="printPageStyle">${css}</style></head><body class="${bodyClass}"><main class="${mainClass}">${printContent(type,transaction,state.settings)}</main></body></html>`;
}
function setPrintButtonsDisabled(disabled){$$('[data-print-document],#printSelectedBtn,#printCashierReceiptBtn,#saveCashierPdfBtn').forEach(button=>button.disabled=disabled)}
async function waitForPrintFrame(frame,type){
  const printDoc=frame.contentDocument;
  if(printDoc.fonts?.ready)await printDoc.fonts.ready.catch(()=>{});
  await Promise.all([...printDoc.images].map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.addEventListener("load",resolve,{once:true});image.addEventListener("error",resolve,{once:true})})));
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(type==="receipt"){
    const receipt=printDoc.querySelector(".receipt-paper"),heightPx=receipt?.scrollHeight||0,heightMm=Math.max(80,Math.ceil(heightPx*25.4/96)+4);
    printDoc.querySelector("#printPageStyle").textContent=`@page{size:58mm ${heightMm}mm;margin:0}${receiptPrintCss().replace(/^@page\{[^}]+\}/,"")}`;
    frame.style.height=`${Math.max(heightPx+20,400)}px`;
    await new Promise(resolve=>requestAnimationFrame(resolve));
  }
}
async function printDocument(type,transaction=selectedPrintTransaction()){
  if(!["receipt","invoice","faktur"].includes(type))return toast("Jenis dokumen cetak tidak valid.");
  if(!transaction)return toast("Pilih transaksi yang akan dicetak terlebih dahulu.");
  if(isPrinting)return toast("Dialog cetak sedang dibuka.");
  isPrinting=true;setPrintButtonsDisabled(true);activePrintFrame?.remove();
  const frame=document.createElement("iframe");activePrintFrame=frame;frame.setAttribute("aria-hidden","true");frame.style.cssText=`position:fixed;left:-10000px;top:0;width:${type==="receipt"?"58mm":"210mm"};height:2000px;border:0;opacity:0;pointer-events:none;background:#fff`;document.body.appendChild(frame);
  let cleaned=false;const cleanup=()=>{if(cleaned)return;cleaned=true;if(activePrintFrame===frame){activePrintFrame=null;frame.remove()}isPrinting=false;setPrintButtonsDisabled(false)};
  try{
    const printDoc=frame.contentDocument;printDoc.open();printDoc.write(printFrameHtml(type,transaction));printDoc.close();
    await waitForPrintFrame(frame,type);
    const printWindow=frame.contentWindow;printWindow.addEventListener("afterprint",cleanup,{once:true});printWindow.focus();printWindow.print();setTimeout(cleanup,1000);
  }catch(error){cleanup();toast("Dokumen cetak gagal disiapkan.");console.error(error)}
}
function printSelected(){
  if(state.settings.printMethod==="Tidak Mencetak")return toast("Metode cetak saat ini diatur ke Tidak Mencetak.");
  const type=state.settings.receiptType.includes("58")?"receipt":state.settings.receiptType.includes("Invoice")?"invoice":"faktur";
  return printDocument(type);
}

function renderStocktake(){
  fillSelect($("#stockProduct"),state.products,x=>x.id,x=>x.name,true,"-- Produk --");
  const q=$("#stockSearch").value.toLowerCase(),date=$("#stockDateFilter").value,rows=state.stocktakes.filter(x=>(x.product+" "+x.category).toLowerCase().includes(q)&&(!date||x.date===date));
  const positive=rows.filter(x=>x.difference>0).reduce((s,x)=>s+x.difference,0),negative=rows.filter(x=>x.difference<0).reduce((s,x)=>s+x.difference,0),difference=rows.reduce((s,x)=>s+x.difference,0);
  $("#stocktakeSummary").innerHTML=`<article><div><small>Total Record</small><strong>${rows.length}</strong><p>Catatan stok opname</p></div></article><article class="green"><div><small>Total Selisih Lebih</small><strong>${money(positive)}</strong><p>Stok fisik lebih banyak</p></div></article><article class="orange"><div><small>Total Selisih Kurang</small><strong>${money(negative)}</strong><p>Stok fisik lebih sedikit</p></div></article><article class="purple"><div><small>Selisih Bersih</small><strong>${money(difference)}</strong><p>Total seluruh selisih</p></div></article>`;
  $("#stocktakeTableBody").innerHTML=rows.length?rows.map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.product)}</td><td>${esc(x.category)}</td><td>${esc(x.unit)}</td><td>${money(x.systemStock)}</td><td>${money(x.physicalStock)}</td><td class="${x.difference<0?"negative":"positive"}">${money(x.difference)}</td><td>${esc(x.note||"-")}</td><td><button class="mini-btn delete" data-stocktake-delete="${x.id}">Hapus</button></td></tr>`).join(""):`<tr><td colspan="9" class="empty-table">Data stok opname tidak ditemukan.</td></tr>`;
  updateStockSummary();
}
function updateStockProduct(){
  const p=productById($("#stockProduct").value); $("#stockCategory").value=p?.category||"";
  $("#stockUnit").value=p?.unit||""; $("#stockSystem").value=p?.stock??""; updateStockDifference();
}
function updateStockDifference(){
  $("#stockDifference").value=Number($("#stockPhysical").value||0)-Number($("#stockSystem").value||0);
  updateStockSummary();
}
function updateStockSummary(){const p=productById($("#stockProduct").value),system=Number($("#stockSystem").value||0),physical=Number($("#stockPhysical").value||0),difference=physical-system;$("#stockSummaryProduct").textContent=p?.name||"-";$("#stockSummarySystem").textContent=money(system);$("#stockSummaryPhysical").textContent=money(physical);$("#stockSummaryDifference").textContent=money(difference);$("#stockSummaryDifference").className=difference<0?"negative":difference>0?"positive":"";}

function renderAll(){
  renderDashboard(); renderSettings(); renderReferences(); renderProducts(); renderSuppliers(); renderCustomers();
  renderIncoming(); renderCashier(); renderTransactions(); renderPrint(); renderStocktake();
}

document.addEventListener("submit",async e=>{
  if(e.target.id==="loginForm"){e.preventDefault();login($("#loginUsername").value,$("#loginPassword").value)}
  if(e.target.id==="settingsForm")saveSettings(e);
  if(e.target.id==="referenceForm"){e.preventDefault();if(!requirePermission("references"))return;const name=$("#referenceName").value.trim(),index=$("#referenceIndex").value;
    const list=activeReference==="categories"?state.categories:activeReference==="units"?state.units:state.paymentMethods;
    if(index==="")list.push(name);else list[Number(index)]=name;saveState();closeModal();renderAll();toast("Referensi disimpan.");
  }
  if(e.target.id==="userForm"){e.preventDefault();if(!requirePermission("references"))return;const id=$("#userId").value,password=$("#userPassword").value,data={username:$("#userUsername").value.trim(),level:$("#userLevel").value,active:$("#userActive").value==="true"};
    try{if(id){await apiRequest(`/users/${id}`,{method:"PUT",body:JSON.stringify(data)});if(password)await apiRequest(`/users/${id}/password`,{method:"PUT",body:JSON.stringify({password})})}else await apiRequest("/users",{method:"POST",body:JSON.stringify({...data,password})});closeModal();if(id===sessionUser?.id&&password){logout();toast("Password berhasil diubah. Silakan login kembali.");return}await loadUsers();toast("Pengguna disimpan.")}catch(error){toast(error.message)}
  }
  if(e.target.id==="productForm"){e.preventDefault();if(!requirePermission("products-manage"))return;const id=$("#productId").value,quickAdd=quickAddTarget==="product"&&!id;const p={id:id||nextId("P",state.products),name:$("#productName").value.trim(),category:$("#productCategory").value,unit:$("#productUnit").value,trackStock:$("#productTrack").value==="true",active:$("#productActive").value==="true",costPrice:Number($("#productCost").value||0),retailPrice:Number($("#productRetail").value||0),wholesalePrice:Number($("#productWholesale").value||0),discount:Number($("#productDiscount").value||0),stock:Number($("#productStock").value||0),minStock:Number($("#productMinStock").value||0)};
    if(id)state.products[state.products.findIndex(x=>x.id===id)]=p;else state.products.push(p);saveState();closeModal();renderAll();if(quickAdd){$("#cashProduct").value=p.name;updateCashProduct()}toast("Produk disimpan.");
  }
  if(e.target.id==="contactForm"){e.preventDefault();const type=$("#contactType").value;if(!requirePermission(type==="supplier"?"suppliers":"customers"))return;const list=type==="supplier"?state.suppliers:state.customers,id=$("#contactId").value,quickAdd=quickAddTarget==="customer"&&type==="customer"&&!id;
    const x={id:id||nextId(type==="supplier"?"S":"C",list),name:$("#contactName").value.trim(),address:$("#contactAddress").value.trim(),phone:$("#contactPhone").value.trim(),email:$("#contactEmail").value.trim(),note:$("#contactNote").value.trim()};
    if(id)list[list.findIndex(a=>a.id===id)]=x;else list.push(x);saveState();closeModal();renderAll();if(quickAdd)$("#cashCustomer").value=x.name;toast("Data disimpan.");
  }
  if(e.target.id==="incomingForm"){e.preventDefault();if(!requirePermission("incoming"))return;const p=productById($("#incomingProduct").value),qty=Number($("#incomingQty").value||0),price=Number($("#incomingPrice").value||0);
    if(!p||!$("#incomingSupplier").value||qty<=0||price<0)return toast("Data barang masuk belum lengkap atau tidak valid.");
    const previousStock=Math.max(0,toSafeNumber(p.stock)),previousCostPrice=Math.max(0,toSafeNumber(p.costPrice));
    const resultingCostPrice=calculateWeightedAverageCost(previousStock,previousCostPrice,qty,price);
    state.incoming.unshift({id:nextId("BM",state.incoming),date:$("#incomingDate").value,createdAt:new Date().toISOString(),supplier:$("#incomingSupplier").value,product:p.name,productId:p.id,category:p.category,unit:p.unit,purchasePrice:price,qty,total:price*qty,previousStock,previousCostPrice,resultingCostPrice,note:$("#incomingNote").value.trim()});
    p.stock=previousStock+qty;p.costPrice=resultingCostPrice;saveState();e.target.reset();$("#incomingDate").value=today();renderAll();toast(`Barang masuk disimpan. Harga modal baru ${rupiah(resultingCostPrice)} per ${p.unit}.`);
  }
  if(e.target.id==="stocktakeForm"){e.preventDefault();if(!requirePermission("stocktake"))return;const p=productById($("#stockProduct").value),physical=Number($("#stockPhysical").value||0);if(!p||physical<0)return toast("Data stok opname tidak valid.");
    const old=p.stock,diff=physical-old;state.stocktakes.unshift({id:nextId("OP",state.stocktakes),date:$("#stockDate").value,product:p.name,productId:p.id,category:p.category,unit:p.unit,systemStock:old,physicalStock:physical,difference:diff,note:$("#stockNote").value.trim()});p.stock=physical;saveState();e.target.reset();$("#stockDate").value=today();renderAll();toast("Stok opname disimpan.");
  }
  if(e.target.id==="passwordForm"){e.preventDefault();if($("#newPassword").value!==$("#confirmPassword").value)return toast("Konfirmasi password tidak sama.");try{await apiRequest("/users/me/password",{method:"PUT",body:JSON.stringify({oldPassword:$("#oldPassword").value,newPassword:$("#newPassword").value})});e.target.reset();logout();toast("Password berhasil diubah. Silakan login kembali.")}catch(error){toast(error.message)}}
});

document.addEventListener("click",async e=>{
  const nav=e.target.closest("[data-page]");if(nav)goPage(nav.dataset.page);
  if(e.target.closest("#sidebarToggle")){
    if(matchMedia("(max-width: 768px)").matches){
      const open=document.body.classList.toggle("mobile-sidebar-open");
      $("#sidebarToggle").setAttribute("aria-expanded",String(open));
      $("#sidebarToggle").setAttribute("aria-label",open?"Tutup navigasi":"Tampilkan navigasi");
    }else{
      const collapsed=document.body.classList.toggle("sidebar-collapsed");
      $("#sidebarToggle").setAttribute("aria-expanded",String(!collapsed));
      $("#sidebarToggle").setAttribute("aria-label",collapsed?"Tampilkan navigasi":"Sembunyikan navigasi");
    }
  }
  if(e.target.id==="sidebarBackdrop")document.body.classList.remove("mobile-sidebar-open");
  if(nav&&matchMedia("(max-width: 768px)").matches)document.body.classList.remove("mobile-sidebar-open");
  if(e.target.id==="logoutBtn")logout();
  if(e.target.id==="modalClose")closeModal();
  if(e.target.id==="toggleUserPassword"){
    const input=$("#userPassword"),show=input?.type==="password";
    if(input)input.type=show?"text":"password";
    e.target.textContent=show?"Sembunyikan":"Lihat";
    e.target.setAttribute("aria-label",show?"Sembunyikan password":"Tampilkan password");
    e.target.setAttribute("aria-pressed",String(show));
  }
  if(e.target.id==="addProductBtn"&&requirePermission("products-manage"))productModal();
  if(e.target.closest("[data-dashboard-add-product]")&&requirePermission("products-manage"))productModal();
  if(e.target.id==="addSupplierBtn"&&requirePermission("suppliers"))contactModal("supplier");
  if(e.target.id==="addCustomerBtn"&&requirePermission("customers"))contactModal("customer");
  if(e.target.id==="addUserBtn"&&requirePermission("references"))userModal();
  if(e.target.id==="addReferenceBtn"&&requirePermission("references"))referenceModal();
  if(e.target.id==="addCartItemBtn")addCartItem();
  if(e.target.id==="quickAddCustomerBtn"&&requirePermission("customers")){quickAddTarget="customer";contactModal("customer",null,$("#cashCustomer").value.trim()==="UMUM"?"":$("#cashCustomer").value.trim())}
  if(e.target.id==="quickAddProductBtn"&&requirePermission("products-manage")){quickAddTarget="product";productModal(null,$("#cashProduct").value.trim())}
  if(e.target.id==="cancelCashierBtn")clearCashier();
  if(e.target.id==="saveTransactionBtn")saveTransaction();
  if(e.target.id==="printCashierReceiptBtn")saveTransaction("print");
  if(e.target.id==="saveCashierPdfBtn")saveTransaction("pdf");
  if(e.target.id==="findPrintInvoiceBtn"){const v=$("#printInvoiceSearch").value.trim();if(!state.transactions.some(t=>t.invoice===v))return toast("Nomor transaksi tidak ditemukan.");selectedPrintInvoice=v;renderPrint();}
  if(e.target.id==="printSelectedBtn")printSelected();
  const printButton=e.target.closest("[data-print-document]");if(printButton)printDocument(printButton.dataset.printDocument);
  if(e.target.id==="backupDataBtn")backupData();
  if(e.target.id==="restoreDataBtn"&&requirePermission("backup"))$("#restoreDataInput")?.click();
  if(e.target.id==="refreshTransactionsBtn"){transactionPage=1;renderTransactions();}
  const txPage=e.target.closest("[data-tx-page]");if(txPage&&!txPage.disabled){transactionPage=Number(txPage.dataset.txPage);renderTransactions();}
  if(e.target.id==="resetAppBtn"&&requirePermission("settings")&&confirm("Semua data aplikasi akan dikembalikan ke data awal. Lanjutkan?")){state=clone(window.SEED_DATA);saveState();location.reload();}
  const ref=e.target.closest("[data-ref]");if(ref&&requirePermission("references")){activeReference=ref.dataset.ref;renderReferences()}
  const refEdit=e.target.closest("[data-ref-edit]");if(refEdit&&requirePermission("references"))referenceModal(Number(refEdit.dataset.refEdit));
  const refDelete=e.target.closest("[data-ref-delete]");if(refDelete&&requirePermission("references")&&confirm("Hapus referensi ini?")){const list=activeReference==="categories"?state.categories:activeReference==="units"?state.units:state.paymentMethods;list.splice(Number(refDelete.dataset.refDelete),1);saveState();renderAll();}
  const ue=e.target.closest("[data-user-edit]");if(ue&&requirePermission("references"))userModal(ue.dataset.userEdit);
  const ud=e.target.closest("[data-user-delete]");if(ud&&requirePermission("references")&&confirm("Hapus pengguna?")){try{await apiRequest(`/users/${ud.dataset.userDelete}`,{method:"DELETE"});await loadUsers();toast("Pengguna dihapus.")}catch(error){toast(error.message)}}
  const pe=e.target.closest("[data-product-edit]");if(pe&&requirePermission("products-manage"))productModal(pe.dataset.productEdit);
  const productPageButton=e.target.closest("[data-product-page]");if(productPageButton&&!productPageButton.disabled){productPage=Number(productPageButton.dataset.productPage);renderProducts();}
  const pd=e.target.closest("[data-product-delete]");if(pd&&requirePermission("products-manage")){state.products=state.products.filter(x=>x.id!==pd.dataset.productDelete);saveState();renderAll();toast("Produk dihapus.");}
  const se=e.target.closest("[data-supplier-edit]");if(se&&requirePermission("suppliers"))contactModal("supplier",se.dataset.supplierEdit);
  const sv=e.target.closest("[data-supplier-view]");if(sv){selectedSupplierId=sv.dataset.supplierView;renderSuppliers();}
  const sd=e.target.closest("[data-supplier-delete]");if(sd&&requirePermission("suppliers")&&confirm("Hapus supplier?")){state.suppliers=state.suppliers.filter(x=>x.id!==sd.dataset.supplierDelete);saveState();renderAll();}
  const ce=e.target.closest("[data-customer-edit]");if(ce&&requirePermission("customers"))contactModal("customer",ce.dataset.customerEdit);
  const customerPageButton=e.target.closest("[data-customer-page]");if(customerPageButton&&!customerPageButton.disabled){customerPage=Number(customerPageButton.dataset.customerPage);renderCustomers();}
  const cd=e.target.closest("[data-customer-delete]");if(cd&&requirePermission("customers")&&confirm("Hapus pelanggan?")){state.customers=state.customers.filter(x=>x.id!==cd.dataset.customerDelete);saveState();renderAll();}
  const ci=e.target.closest("[data-cart-delete]");if(ci){cart=cart.filter(x=>x.lineId!==ci.dataset.cartDelete);renderCart();}
  const iv=e.target.closest("[data-incoming-delete]");if(iv&&requirePermission("incoming"))deleteIncomingRecord(iv.dataset.incomingDelete);
  const tv=e.target.closest("[data-tx-view]");if(tv)transactionDetail(state.transactions.find(x=>x.invoice===tv.dataset.txView));
  const tp=e.target.closest("[data-tx-print]");if(tp){selectedPrintInvoice=tp.dataset.txPrint;goPage("print")}
  const td=e.target.closest("[data-tx-delete]");if(td)deleteTransaction(td.dataset.txDelete);
  const st=e.target.closest("[data-stocktake-delete]");if(st&&requirePermission("stocktake")&&confirm("Hapus riwayat stok opname? Stok saat ini tidak diubah.")){state.stocktakes=state.stocktakes.filter(x=>x.id!==st.dataset.stocktakeDelete);saveState();renderAll();}
  const it=e.target.closest("[data-incoming-tab]");if(it){$$("[data-incoming-tab]").forEach(b=>b.classList.toggle("active",b===it));$("#incomingInput").classList.toggle("hidden",it.dataset.incomingTab!=="input");$("#incomingList").classList.toggle("hidden",it.dataset.incomingTab!=="list");}
  const ss=e.target.closest("[data-stock-tab]");if(ss){$$("[data-stock-tab]").forEach(b=>b.classList.toggle("active",b===ss));$("#stockInput").classList.toggle("hidden",ss.dataset.stockTab!=="input");$("#stockList").classList.toggle("hidden",ss.dataset.stockTab!=="list");}
  if(e.target.id==="exportProductsBtn")csvDownload("daftar-produk.csv",["Nama Produk","Kategori","Satuan","Harga Modal","Harga Satuan","Harga Grosir","Stok"],state.products.map(p=>[p.name,p.category,p.unit,p.costPrice,p.retailPrice,p.wholesalePrice,p.stock]));
  if(e.target.id==="exportSuppliersBtn")csvDownload("daftar-supplier.csv",["Nama","Alamat","Telepon","Email","Keterangan"],state.suppliers.map(x=>[x.name,x.address,x.phone,x.email,x.note]));
  if(e.target.id==="exportCustomersBtn")csvDownload("daftar-pelanggan.csv",["Nama","Alamat","Telepon","Email","Keterangan"],state.customers.map(x=>[x.name,x.address,x.phone,x.email,x.note]));
  if(e.target.id==="exportIncomingBtn")csvDownload("barang-masuk.csv",["Tanggal","Supplier","Produk","Kategori","Satuan","Harga Beli","Jumlah","Total"],state.incoming.map(x=>[x.date,x.supplier,x.product,x.category,x.unit,x.purchasePrice,x.qty,x.total]));
  if(e.target.id==="exportTransactionsBtn")csvDownload("transaksi-keluar.csv",["No Transaksi","Tanggal","Kasir","Pelanggan","Metode","Subtotal","Diskon","Pajak","Total","Bayar","Kembali"],state.transactions.map(x=>[x.invoice,x.createdAt,x.cashier,x.customer,x.paymentMethod,x.subtotal,x.discountAmount,x.taxAmount,x.total,x.payment,x.change]));
});
document.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&e.target.id==="printInvoiceSearch"){
    e.preventDefault(); $("#findPrintInvoiceBtn")?.click();
  }
});
document.addEventListener("input",e=>{
  if(["productSearch","supplierSearch","customerSearch","incomingSearch","incomingDateFilter","stockSearch","stockDateFilter","transactionSearch","transactionDateFilter"].includes(e.target.id)){if(e.target.id.startsWith("transaction"))transactionPage=1;if(e.target.id==="productSearch")productPage=1;if(e.target.id==="customerSearch")customerPage=1;renderAll();}
  if(["incomingPrice","incomingQty"].includes(e.target.id))updateIncomingTotal();
  if(["cashPrice","cashItemDiscount","cashQty"].includes(e.target.id))updateCashLine();
  if(e.target.id==="cashProduct")updateCashProduct();
  if(["cashDiscount","cashPayment"].includes(e.target.id))renderCart();
  if(["stockPhysical"].includes(e.target.id))updateStockDifference();
});
document.addEventListener("keydown",e=>{
  const row=e.target.closest(".supplier-row");
  if(row&&(e.key==="Enter"||e.key===" ")){
    e.preventDefault();
    selectedSupplierId=row.dataset.supplierView;
    renderSuppliers();
  }
});
document.addEventListener("reset",e=>{
  if(e.target.id==="incomingForm")setTimeout(()=>{$("#incomingDate").value=today();updateIncomingSummary();},0);
  if(e.target.id==="stocktakeForm")setTimeout(()=>{$("#stockDate").value=today();updateStockSummary();},0);
});
document.addEventListener("change",e=>{
  if(e.target.id==="incomingProduct")updateIncomingProduct();
  if(e.target.id==="incomingSupplier")updateIncomingSummary();
  if(e.target.id==="cashProduct"||e.target.id==="cashPriceType")updateCashProduct();
  if(e.target.id==="cashPaymentMethod"){if(e.target.value!=="Tunai"&&e.target.value!=="DP")$("#cashPayment").value=0;renderCart();}
  if(e.target.id==="stockProduct")updateStockProduct();
  if(e.target.id==="transactionPaymentFilter"){transactionPage=1;renderTransactions();}
  if(e.target.id==="productCategoryFilter"||e.target.id==="productStockFilter"){productPage=1;renderProducts();}
  if(e.target.id==="customerRegionFilter"){customerPage=1;renderCustomers();}
  if(e.target.id==="dashboardDate")renderDashboard();
  if(e.target.id==="printReceiptType"&&requirePermission("print")){state.settings.receiptType=e.target.value;saveState();renderPrint();toast("Jenis nota disimpan.");}
  if(e.target.id==="printMethod"&&requirePermission("print")){state.settings.printMethod=e.target.value;saveState();toast("Metode cetak disimpan.");}
  if(e.target.id==="restoreDataInput")restoreData(e.target.files?.[0]);
});
$("#modal").addEventListener("click",e=>{if(e.target.id==="modal")closeModal()});
$("#loginForm").addEventListener("submit",e=>{});
window.addEventListener("focus",()=>refreshServerState({notify:true}));
window.addEventListener("online",()=>{syncErrorShown=false;if(stateDirty)queueServerSync();else refreshServerState({notify:true});});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refreshServerState({notify:true});});
$("#incomingDate").value=today();$("#stockDate").value=today();
normalizeInMemoryState();

$("#loginScreen").classList.remove("hidden");
restoreSession();
