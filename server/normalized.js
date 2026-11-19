'use strict';

const MODES = new Set(['legacy', 'normalized-read', 'normalized']);
function mode() {
  const value = process.env.PERSISTENCE_MODE || 'legacy';
  if (!MODES.has(value)) throw Object.assign(new Error('Invalid PERSISTENCE_MODE'), { status: 503 });
  return value;
}
function dbError(error) {
  const status = { '42501':403, '22023':400, '22007':400, '22008':400, '22003':400, '22P02':400, '23502':400, '23503':409, '23514':400, '23505':409, '40001':409, '55000':503 }[error.code] || 503;
  return Object.assign(new Error(status === 503 ? 'Persistence unavailable; retry the same operation.' : error.message), { status });
}
function redact(value, user) {
  if (user.role === 'ADMINISTRATOR' || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(x => redact(x, user));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/cost.?price|profit/i.test(key)&&key!=='lastBackupAt').map(([k,v]) => [k,redact(v,user)]));
}
function install(app, { requireAuth, requireAdmin, getRuntime, requireJson, jsonParser, rejectOversizedBody, stateReadLimiter, stateWriteLimiter }) {
  const available = (req,res,next) => { try { if(mode()==='legacy') return res.status(404).json({message:'Normalized persistence disabled.'}); next(); } catch(e) { next(e); } };
  const writable = (req,res,next) => { try { if(mode()!=='normalized') return res.status(503).json({message:'Persistence is read-only.'}); next(); } catch(e) { next(e); } };
  async function rpc(req,name,args) {
    const {data,error}=await getRuntime().supabase.rpc(name,{...args,p_actor:req.user.id,p_mode:mode()});
    if(error) throw dbError(error);
    return redact(data,req.user);
  }
  app.get('/api/persistence',requireAuth,(_req,res,next)=>{try{res.json({mode:mode()});}catch(e){next(e);}});
  for(const [path,kind,admin] of [['bootstrap','bootstrap'],['sync','version'],['products','products'],['customers','customers'],['suppliers','suppliers',true],['transactions','transactions'],['transactions/:id','transaction'],['transaction-by-invoice','transaction'],['incoming','incoming',true],['stocktakes','stocktakes',true],['dashboard','dashboard']]) {
    app.get(`/api/${path}`,requireAuth,available,...(admin?[requireAdmin]:[]),stateReadLimiter,async(req,res,next)=>{
      try {
        const query={};
        for(const key of ['page','limit','date','search','paymentMethod','invoice','expectedRevision']) {
          const value=req.query[key];
          if(value!==undefined && (typeof value!=='string'||value.length>200)) return res.status(400).json({message:'Invalid query'});
          if(value) query[key]=value;
        }
        for(const key of ['page','limit']) if(query[key] && !/^[1-9]\d{0,6}$/.test(query[key])) return res.status(400).json({message:'Invalid pagination'});
        if(query.limit && Number(query.limit)>100) return res.status(400).json({message:'Maximum limit is 100'});
        if(req.params.id)query.id=req.params.id;
        res.json(await rpc(req,'cashier_read',{p_kind:kind,p_query:query}));
      }catch(e){next(e);}
    });
  }
  const parser=jsonParser(64*1024);
  for(const [method,path,kind,admin,fields] of [
    ['post','transactions','sale',false,['items','customer','courier','discount','payment','paymentMethod']],
    ['post','transactions/:id/payments','payment',false,['amount','method','date','note']],
    ['patch','transactions/:id/items','quantity',true,['quantities','revision']],
    ['post','incoming','incoming',true,['productId','qty','purchasePrice','supplier','date','note']],
    ['post','stocktakes','stocktake',true,['productId','physicalStock','expectedStock','date','note']],
    ['post','products','product',true,['data','revision']],
    ['post','customers','customer',true,['data','revision']],
    ['post','suppliers','supplier',true,['data','revision']],
    ['put','configuration','config',true,['data','revision']]
  ]) app[method](`/api/${path}`,requireJson,rejectOversizedBody(64*1024),requireAuth,available,writable,...(admin?[requireAdmin]:[]),stateWriteLimiter,parser,async(req,res,next)=>{
    try {
      const operation=req.get('Idempotency-Key');
      if(!operation||!/^[A-Za-z0-9_-]{8,150}$/.test(operation))return res.status(400).json({message:'Valid Idempotency-Key required.'});
      if(!req.body||Array.isArray(req.body)||Object.keys(req.body).some(k=>!fields.includes(k)))return res.status(400).json({message:'Unexpected command fields; send only this operation.'});
      if(kind==='sale' && (!Array.isArray(req.body.items)||req.body.items.length<1||req.body.items.length>200||req.body.items.some(i=>!i||typeof i!=='object'||Object.keys(i).some(k=>!['productId','qty','price','discount','priceType'].includes(k)))))return res.status(400).json({message:'Invalid sale items.'});
      res.json(await rpc(req,'cashier_command',{p_kind:kind,p_body:{...req.body,...(req.params.id?{id:req.params.id}:{})},p_operation:operation}));
    }catch(e){next(e);}
  });
}
module.exports={install,mode,redact};
