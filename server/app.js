require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const USER_FIELDS = 'id, username, role, active, created_at, updated_at';
const SMALL_JSON_LIMIT = 8 * 1024;
const configuredStateLimitKb = Number(process.env.STATE_JSON_LIMIT_KB || 512);
const STATE_JSON_LIMIT_KB = Number.isSafeInteger(configuredStateLimitKb) && configuredStateLimitKb >= 64 && configuredStateLimitKb <= 2048 ? configuredStateLimitKb : 512;
const STATE_JSON_LIMIT = STATE_JSON_LIMIT_KB * 1024;
let runtime;
let initialization;

function normalizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function validateEnvironment() {
  const required = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'CORS_ORIGIN', 'INITIAL_ADMIN_USERNAME', 'INITIAL_ADMIN_PASSWORD', 'NODE_ENV'];
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) throw Object.assign(new Error(`Environment variable wajib belum diisi: ${missing.join(', ')}`), { status: 503 });
  if (process.env.JWT_SECRET.length < 32) throw Object.assign(new Error('JWT_SECRET harus memiliki minimal 32 karakter.'), { status: 503 });
  if (process.env.INITIAL_ADMIN_PASSWORD.length < 8) throw Object.assign(new Error('INITIAL_ADMIN_PASSWORD harus memiliki minimal 8 karakter.'), { status: 503 });
  if (process.env.STATE_JSON_LIMIT_KB && Number(process.env.STATE_JSON_LIMIT_KB) !== STATE_JSON_LIMIT_KB) throw Object.assign(new Error('STATE_JSON_LIMIT_KB harus bilangan bulat antara 64 dan 2048.'), { status: 503 });
  let url;
  try { url = new URL(process.env.SUPABASE_URL); } catch { throw Object.assign(new Error('SUPABASE_URL tidak valid.'), { status: 503 }); }
  if (url.protocol !== 'https:') throw Object.assign(new Error('SUPABASE_URL wajib menggunakan HTTPS.'), { status: 503 });
  const configuredOrigins = process.env.CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of configuredOrigins) {
    let parsedOrigin;
    try { parsedOrigin = new URL(origin); } catch { throw Object.assign(new Error(`CORS_ORIGIN tidak valid: ${origin}`), { status: 503 }); }
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) throw Object.assign(new Error(`CORS_ORIGIN harus berupa origin HTTP(S) tanpa path: ${origin}`), { status: 503 });
    if (process.env.NODE_ENV === 'production' && parsedOrigin.protocol !== 'https:') throw Object.assign(new Error(`CORS_ORIGIN production wajib menggunakan HTTPS: ${origin}`), { status: 503 });
  }
  return {
    jwtSecret: process.env.JWT_SECRET,
    production: process.env.NODE_ENV === 'production',
    origins: [...new Set(configuredOrigins)],
    supabase: createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  };
}

function getRuntime() {
  if (!runtime) runtime = validateEnvironment();
  return runtime;
}

async function initializeDatabase() {
  const { supabase } = getRuntime();
  const username = normalizeUsername(process.env.INITIAL_ADMIN_USERNAME);
  const { data: existing, error } = await supabase.from('app_users').select('id').eq('username', username).maybeSingle();
  if (error) throw Object.assign(new Error('Database Supabase belum siap. Jalankan server/schema.sql.'), { status: 503, cause: error });
  if (existing) return;
  const passwordHash = await bcrypt.hash(process.env.INITIAL_ADMIN_PASSWORD, 12);
  const { error: insertError } = await supabase.from('app_users').insert({ username, password_hash: passwordHash, role: 'ADMINISTRATOR', active: true });
  if (insertError && insertError.code !== '23505') throw Object.assign(new Error('Administrator awal tidak dapat dibuat.'), { status: 503, cause: insertError });
}

async function ensureReady(_req, _res, next) {
  try {
    getRuntime();
    if (!initialization) initialization = initializeDatabase().catch(error => { initialization = null; throw error; });
    await initialization;
    next();
  } catch (error) { next(error); }
}

function cookieToken(req) {
  const match = String(req.headers.cookie || '').match(/(?:^|;\s*)kasir_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || cookieToken(req);
  if (!token) return res.status(401).json({ message: 'Autentikasi diperlukan.' });
  try {
    const { jwtSecret, supabase } = getRuntime();
    const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    const { data: user, error } = await supabase.from('app_users').select(`${USER_FIELDS}, password_changed_at`).eq('id', claims.sub).maybeSingle();
    if (error) throw error;
    if (!user?.active) return res.status(401).json({ message: 'Sesi tidak valid atau akun tidak aktif.' });
    if (new Date(user.password_changed_at).toISOString() !== claims.pwd) return res.status(401).json({ message: 'Sesi berakhir karena password telah diperbarui.' });
    req.user = user;
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.status(401).json({ message: 'Sesi tidak valid atau sudah berakhir.' });
    return next(error);
  }
}

const requireAdmin = (req, res, next) => req.user.role === 'ADMINISTRATOR' ? next() : res.status(403).json({ message: 'Anda tidak memiliki izin untuk melakukan tindakan ini.' });
const publicUser = user => ({ id: user.id, username: user.username, level: user.role, active: user.active });
const sessionCookieOptions = req => ({
  httpOnly: true,
  secure: getRuntime().production && !/^(localhost|127\.0\.0\.1)$/i.test(req.hostname || ''),
  sameSite: 'lax',
  path: '/'
});
function hasSensitiveKey(value) {
  const pending = [value];
  let inspected = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (++inspected > 100000) return true;
    for (const [key, child] of Object.entries(current)) {
      if (/password|password_hash|token|jwt|secret|supabase/i.test(key)) return true;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}
function withoutSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(withoutSensitiveFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(users|currentUser|password|password_hash|token|jwt|secret|supabase)$/i.test(key)).map(([key, child]) => [key, withoutSensitiveFields(child)]));
}
function validState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recordLists = ['products', 'suppliers', 'customers', 'transactions', 'incoming', 'stocktakes'];
  if (!recordLists.every(key => Array.isArray(value[key]) && value[key].every(item => item && typeof item === 'object' && !Array.isArray(item)))) return false;
  if (value.settings !== undefined && (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings))) return false;
  for (const key of ['categories', 'units', 'paymentMethods']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string'))) return false;
  }
  return true;
}

function requireJson(req, res, next) {
  if (req.is(['application/json', 'application/*+json'])) return next();
  return res.status(415).json({ message: 'Content-Type wajib application/json.' });
}

function rejectOversizedBody(maxBytes) {
  return (req, res, next) => {
    const declaredBytes = Number(req.headers['content-length']);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return res.status(413).json({ message: `Payload terlalu besar. Batas ${Math.floor(maxBytes / 1024)} KB.` });
    return next();
  };
}

function jsonParser(maxBytes) {
  return express.json({
    limit: maxBytes,
    strict: true,
    verify(req, _res, buffer) { req.requestBytes = buffer.length; }
  });
}

const parseSmallJson = jsonParser(SMALL_JSON_LIMIT);
const parseStateJson = jsonParser(STATE_JSON_LIMIT);
const limiterResponse = { message: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.' };
const apiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: limiterResponse });
const healthLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: limiterResponse });
const stateReadLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 180, keyGenerator: req => `user:${req.user.id}`, standardHeaders: true, legacyHeaders: false, message: limiterResponse });
const stateWriteLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 60, keyGenerator: req => `user:${req.user.id}`, standardHeaders: true, legacyHeaders: false, message: limiterResponse });
const userWriteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, keyGenerator: req => `user:${req.user.id}`, standardHeaders: true, legacyHeaders: false, message: limiterResponse });

function requestMetadataLog(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const successfulRead = req.method === 'GET' && res.statusCode < 400;
    if (successfulRead && Math.random() >= 0.1) return;
    const headerBytes = Number(req.headers['content-length']);
    console.info('API request', JSON.stringify({
      method: req.method,
      endpoint: req.originalUrl.split('?')[0],
      status: res.statusCode,
      requestBytes: Number.isFinite(req.requestBytes) ? req.requestBytes : (Number.isFinite(headerBytes) ? headerBytes : 0),
      authenticated: Boolean(req.user),
      durationMs: Date.now() - startedAt
    }));
  });
  next();
}

function stateForCashier(payload) {
  const safe = structuredClone(payload);
  delete safe.users;
  delete safe.lastBackupAt;
  safe.products = (safe.products || []).map(({ costPrice, ...product }) => product);
  safe.transactions = (safe.transactions || []).map(transaction => ({ ...transaction, items: (transaction.items || []).map(({ costPrice, profit, ...item }) => item) }));
  return safe;
}

function mergeCashierState(current, submitted, currentUserName) {
  const merged = structuredClone(current);
  merged.settings = current.settings;
  merged.categories = current.categories;
  merged.units = current.units;
  merged.paymentMethods = current.paymentMethods;
  merged.suppliers = current.suppliers;
  merged.customers = current.customers;
  merged.incoming = current.incoming;
  merged.stocktakes = current.stocktakes;
  const oldProducts = new Map((current.products || []).map(product => [product.id, product]));
  const oldTransactions = new Map((current.transactions || []).map(transaction => [transaction.id || transaction.invoice, transaction]));
  const submittedTransactions = new Map((submitted.transactions || []).map(transaction => [transaction.id || transaction.invoice, transaction]));
  const additions = (submitted.transactions || []).filter(transaction => !oldTransactions.has(transaction.id || transaction.invoice)).map(transaction => {
    if ((current.transactions || []).some(old => old.invoice === transaction.invoice)) throw Object.assign(new Error('Nomor transaksi sudah digunakan.'), { status: 409 });
    const items = (transaction.items || []).map(item => {
      const product = oldProducts.get(item.productId);
      if (!product || !Number.isFinite(item.qty) || item.qty <= 0) throw Object.assign(new Error('Produk/qty tidak valid.'), { status: 400 });
      const costPrice = Number(product?.costPrice || 0);
      return { ...item, costPrice, profit: (Number(item.price || 0) - Number(item.discount || 0) - costPrice) * Number(item.qty || 0) };
    });
    return { ...transaction, cashier: currentUserName, items };
  });
  const updatedExisting = (current.transactions || []).map(transaction => {
    const submittedTransaction = submittedTransactions.get(transaction.id || transaction.invoice);
    if (submittedTransaction && JSON.stringify((submittedTransaction.items || []).map(item => [item.productId, Number(item.qty), Number(item.price), Number(item.discount || 0)])) !== JSON.stringify((transaction.items || []).map(item => [item.productId, Number(item.qty), Number(item.price), Number(item.discount || 0)]))) {
      throw Object.assign(new Error('Hanya administrator dapat mengubah quantity transaksi.'), { status: 403 });
    }
    if (!submittedTransaction) return transaction;
    const existingPayments = Array.isArray(transaction.paymentHistory) ? transaction.paymentHistory : [];
    const existingIds = new Set(existingPayments.map(payment => String(payment.id || '')));
    const isDP = String(transaction.paymentMethod || '').trim().toUpperCase() === 'DP';
    const initialPaid = isDP ? Number(transaction.downPayment || 0) : Number(transaction.cashIn ?? Number(transaction.payment ?? transaction.total ?? 0) - Number(transaction.change || 0));
    let remaining = Math.max(0, Number(transaction.total || 0) - initialPaid - existingPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    const acceptedPayments = [];
    for (const payment of Array.isArray(submittedTransaction.paymentHistory) ? submittedTransaction.paymentHistory : []) {
      if (!payment || existingIds.has(String(payment.id || ''))) continue;
      const amount = Number(payment.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) throw Object.assign(new Error('Nominal pelunasan tidak valid.'), { status: 400 });
      const date = String(payment.date || '').slice(0, 10);
      const method = String(payment.method || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !method || method.toUpperCase() === 'DP' || !payment.id) throw Object.assign(new Error('Data pelunasan tidak valid.'), { status: 400 });
      acceptedPayments.push({ id: String(payment.id || `${transaction.invoice}-PAY-${Date.now()}-${acceptedPayments.length}`), date, method, amount, createdAt: payment.createdAt || new Date().toISOString(), cashier: currentUserName, note: String(payment.note || '').trim() });
      existingIds.add(String(payment.id || ''));
      remaining -= amount;
    }
    if (!acceptedPayments.length) return transaction;
    const paymentHistory = [...existingPayments, ...acceptedPayments];
    const settlementTotal = paymentHistory.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const total = Number(transaction.total || 0);
    const paid = Math.min(total, initialPaid + settlementTotal);
    return { ...transaction, paymentMethod: isDP ? 'DP' : transaction.paymentMethod, paymentHistory, payment: isDP ? paid : transaction.payment, cashIn: initialPaid, remaining: Math.max(0, total - paid), paymentStatus: paid >= total ? 'LUNAS' : 'BELUM LUNAS' };
  });
  merged.transactions = [...additions, ...updatedExisting];
  const soldByProduct = new Map();
  additions.forEach(transaction => transaction.items.forEach(item => soldByProduct.set(item.productId, (soldByProduct.get(item.productId) || 0) + Math.max(0, Number(item.qty || 0)))));
  merged.products = (current.products || []).map(product => {
    const stock = Number(product.stock || 0) - (product.trackStock ? soldByProduct.get(product.id) || 0 : 0);
    if (product.trackStock && stock < 0) throw Object.assign(new Error('Stok tidak mencukupi.'), { status: 400 });
    return { ...product, stock };
  });
  return merged;
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ credentials: true, origin(origin, callback) {
  try {
    const { origins, production } = getRuntime();
    const local = !production && /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin || '');
    if (!origin || origins.includes(origin) || local) return callback(null, true);
    return callback(Object.assign(new Error('Origin tidak diizinkan oleh CORS.'), { status: 403 }));
  } catch (error) { callback(error); }
} }));
app.use('/api', requestMetadataLog, apiLimiter, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/health', healthLimiter, ensureReady, async (_req, res, next) => {
  try {
    const { error } = await getRuntime().supabase.from('app_state').select('id').eq('id', 1).limit(1);
    if (error) throw error;
    res.json({ ok: true, service: 'web-kasir-sumber-berkah', database: 'connected' });
  } catch (error) { next(Object.assign(new Error('Database sedang tidak tersedia.'), { status: 503, cause: error })); }
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { message: 'Terlalu banyak percobaan login. Coba kembali beberapa saat lagi.' } });
app.post('/api/auth/login', loginLimiter, requireJson, rejectOversizedBody(SMALL_JSON_LIMIT), parseSmallJson, ensureReady, async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || typeof password !== 'string' || !password) return res.status(400).json({ message: 'Username dan password wajib diisi.' });
    const { data: user, error } = await getRuntime().supabase.from('app_users').select(`${USER_FIELDS}, password_hash, password_changed_at`).eq('username', username).maybeSingle();
    if (error) throw error;
    if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ message: 'Username atau password salah.' });
    const token = jwt.sign({ sub: user.id, pwd: new Date(user.password_changed_at).toISOString() }, getRuntime().jwtSecret, { algorithm: 'HS256', expiresIn: '8h' });
    res.cookie('kasir_session', token, { ...sessionCookieOptions(req), maxAge: 8 * 60 * 60 * 1000 });
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('kasir_session', sessionCookieOptions(req)); res.json({ ok: true }); });
app.get('/api/auth/me', requireAuth, ensureReady, (req, res) => res.json(publicUser(req.user)));

app.get('/api/state/version', requireAuth, stateReadLimiter, async (_req, res, next) => {
  try {
    const { data, error } = await getRuntime().supabase.from('app_state').select('version').eq('id', 1).maybeSingle();
    if (error) throw error;
    res.json({ version: Number(data?.version || 0) });
  } catch (error) { next(error); }
});

app.get('/api/state', requireAuth, ensureReady, stateReadLimiter, async (req, res, next) => {
  try {
    const { data, error } = await getRuntime().supabase.from('app_state').select('payload, version, updated_at').eq('id', 1).maybeSingle();
    if (error) throw error;
    const payload = withoutSensitiveFields(data?.payload || {});
    res.json({ state: req.user.role === 'ADMINISTRATOR' ? payload : stateForCashier(payload), version: Number(data?.version || 0), updatedAt: data?.updated_at || null, maxRequestBytes: STATE_JSON_LIMIT });
  } catch (error) { next(error); }
});

app.put('/api/state', requireJson, rejectOversizedBody(STATE_JSON_LIMIT), requireAuth, ensureReady, stateWriteLimiter, parseStateJson, async (req, res, next) => {
  try {
    let payload = req.body?.state;
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!validState(payload) || hasSensitiveKey(payload)) return res.status(400).json({ message: 'Struktur data tidak valid atau mengandung field sensitif.' });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return res.status(400).json({ message: 'Versi state tidak valid.' });
    const { supabase } = getRuntime();
    if (req.user.role !== 'ADMINISTRATOR') {
      const { data: current, error: readError } = await supabase.from('app_state').select('payload, version').eq('id', 1).single();
      if (readError) throw readError;
      if (Number(current.version) !== expectedVersion) return res.status(409).json({ message: 'Data telah berubah di perangkat lain.' });
      payload = mergeCashierState(current.payload || {}, payload, req.user.username);
    }
    delete payload.users;
    delete payload.currentUser;
    const { data, error } = await supabase.rpc('save_app_state', { p_expected_version: expectedVersion, p_payload: payload, p_updated_by: req.user.username });
    if (error) throw error;
    const saved = data?.[0];
    if (!saved) return res.status(409).json({ message: 'Data telah berubah di perangkat lain. Ambil data terbaru lalu coba lagi.' });
    res.json({ ok: true, version: Number(saved.version), updatedAt: saved.updated_at });
  } catch (error) { next(error); }
});

app.get('/api/users', requireAuth, ensureReady, requireAdmin, async (_req, res, next) => {
  try {
    const { data, error } = await getRuntime().supabase.from('app_users').select(USER_FIELDS).order('username');
    if (error) throw error;
    res.json(data.map(publicUser));
  } catch (error) { next(error); }
});
app.post('/api/users', requireJson, rejectOversizedBody(SMALL_JSON_LIMIT), requireAuth, ensureReady, requireAdmin, userWriteLimiter, parseSmallJson, async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username), password = req.body?.password, level = req.body?.level;
    if (!username || username.length > 80 || typeof password !== 'string' || password.length < 8 || !['ADMINISTRATOR', 'KASIR'].includes(level)) return res.status(400).json({ message: 'Username, level, atau password (minimal 8 karakter) tidak valid.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const { data, error } = await getRuntime().supabase.from('app_users').insert({ username, password_hash: passwordHash, role: level, active: req.body.active !== false }).select(USER_FIELDS).single();
    if (error?.code === '23505') return res.status(409).json({ message: 'Username sudah digunakan.' });
    if (error) throw error;
    res.status(201).json(publicUser(data));
  } catch (error) { next(error); }
});

async function activeAdminCount() {
  const { count, error } = await getRuntime().supabase.from('app_users').select('id', { count: 'exact', head: true }).eq('role', 'ADMINISTRATOR').eq('active', true);
  if (error) throw error;
  return count || 0;
}
app.put('/api/users/:id', requireJson, rejectOversizedBody(SMALL_JSON_LIMIT), requireAuth, ensureReady, requireAdmin, userWriteLimiter, parseSmallJson, async (req, res, next) => {
  try {
    const { supabase } = getRuntime();
    const { data: target, error: findError } = await supabase.from('app_users').select(USER_FIELDS).eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!target) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
    const username = normalizeUsername(req.body?.username), level = req.body?.level, active = req.body?.active !== false;
    if (!username || username.length > 80 || !['ADMINISTRATOR', 'KASIR'].includes(level)) return res.status(400).json({ message: 'Data pengguna tidak valid.' });
    if (target.id === req.user.id && !active) return res.status(400).json({ message: 'Anda tidak dapat menonaktifkan akun sendiri.' });
    if (target.role === 'ADMINISTRATOR' && target.active && (level !== 'ADMINISTRATOR' || !active) && await activeAdminCount() <= 1) return res.status(409).json({ message: 'Administrator aktif terakhir tidak dapat dinonaktifkan atau diubah levelnya.' });
    const { data, error } = await supabase.from('app_users').update({ username, role: level, active, updated_at: new Date().toISOString() }).eq('id', target.id).select(USER_FIELDS).single();
    if (error?.code === '23505') return res.status(409).json({ message: 'Username sudah digunakan.' });
    if (error) throw error;
    res.json(publicUser(data));
  } catch (error) { next(error); }
});
app.delete('/api/users/:id', requireAuth, ensureReady, requireAdmin, userWriteLimiter, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'Anda tidak dapat menghapus akun sendiri.' });
    const { supabase } = getRuntime();
    const { data: target, error: findError } = await supabase.from('app_users').select(USER_FIELDS).eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!target) return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
    if (target.role === 'ADMINISTRATOR' && target.active && await activeAdminCount() <= 1) return res.status(409).json({ message: 'Administrator aktif terakhir tidak dapat dihapus.' });
    const { error } = await supabase.from('app_users').delete().eq('id', target.id);
    if (error) throw error;
    res.status(204).end();
  } catch (error) { next(error); }
});

async function updatePassword(id, password) {
  if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Password baru minimal 8 karakter.'), { status: 400 });
  const passwordHash = await bcrypt.hash(password, 12);
  const changedAt = new Date().toISOString();
  const { data, error } = await getRuntime().supabase.from('app_users').update({ password_hash: passwordHash, password_changed_at: changedAt, updated_at: changedAt }).eq('id', id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Pengguna tidak ditemukan.'), { status: 404 });
}
app.put('/api/users/me/password', requireJson, rejectOversizedBody(SMALL_JSON_LIMIT), requireAuth, ensureReady, requireAdmin, userWriteLimiter, parseSmallJson, async (req, res, next) => {
  try {
    const { data: user, error } = await getRuntime().supabase.from('app_users').select('password_hash').eq('id', req.user.id).single();
    if (error) throw error;
    if (typeof req.body?.oldPassword !== 'string' || !(await bcrypt.compare(req.body.oldPassword, user.password_hash))) return res.status(400).json({ message: 'Password lama salah.' });
    await updatePassword(req.user.id, req.body?.newPassword);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.put('/api/users/:id/password', requireJson, rejectOversizedBody(SMALL_JSON_LIMIT), requireAuth, ensureReady, requireAdmin, userWriteLimiter, parseSmallJson, async (req, res, next) => { try { await updatePassword(req.params.id, req.body?.password); res.json({ ok: true }); } catch (error) { next(error); } });

app.use('/api', (_req, res) => res.status(404).json({ message: 'Endpoint tidak ditemukan.' }));
app.use((error, _req, res, _next) => {
  console.error('API error:', error.message, error.cause?.message || '');
  const malformedJson = error instanceof SyntaxError && error.status === 400 && 'body' in error;
  const status = error.type === 'entity.too.large' ? 413 : (malformedJson ? 400 : (Number(error.status) || (error.code ? 503 : 500)));
  const safeMessage = status === 413
    ? `Payload terlalu besar. Batas ${Math.floor(STATE_JSON_LIMIT / 1024)} KB untuk state dan ${Math.floor(SMALL_JSON_LIMIT / 1024)} KB untuk permintaan lain.`
    : (malformedJson ? 'JSON tidak valid.' : (status >= 500 ? (status === 503 ? 'Database atau konfigurasi server sedang tidak tersedia.' : 'Terjadi kesalahan pada server.') : error.message));
  res.status(status).json({ message: safeMessage });
});

module.exports = app;
