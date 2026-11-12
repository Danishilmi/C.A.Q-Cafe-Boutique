const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { rpc, mode } = require('./db');
const { saveImage, UPLOAD_DIR } = require('./storage');

const PORT = process.env.PORT || 3000;

// Seller passwords. Set these in .env before going live.
const PASSWORDS = {
  boutique: process.env.BOUTIQUE_PASSWORD || 'boutique123',
  cafe: process.env.CAFE_PASSWORD || 'cafe123',
};
const SHOPS = ['boutique', 'cafe'];
const sessions = new Map(); // token -> shop

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Friendly URLs for the four interfaces.
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/boutique', page('customer.html'));
app.get('/cafe', page('customer.html'));
app.get('/boutique/seller', page('seller.html'));
app.get('/cafe/seller', page('seller.html'));

// Images are kept in memory briefly, then saved to Supabase Storage (or the uploads folder).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function shopParam(req, res, next) {
  if (!SHOPS.includes(req.params.shop)) return res.status(404).json({ error: 'Unknown shop' });
  next();
}

function requireSeller(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (sessions.get(token) !== req.params.shop) return res.status(401).json({ error: 'Please log in as the seller' });
  next();
}

const toSen = (rm) => Math.round(Number(rm) * 100);

function parseDiscount(type, value) {
  if (!type || type === 'none' || value === '' || value == null) return { type: null, value: null };
  const v = Number(value);
  if (!['rm', 'percent'].includes(type) || !(v > 0)) throw new HttpError(400, 'Discount must be a positive RM amount or percentage');
  if (type === 'percent' && v > 100) throw new HttpError(400, 'Percentage discount cannot exceed 100%');
  return { type, value: v };
}

function parseVariants(raw) {
  let list;
  try { list = JSON.parse(raw || '[]'); } catch { throw new HttpError(400, 'Invalid variants'); }
  list = list.filter((v) => String(v.name || '').trim());
  if (list.length === 0) throw new HttpError(400, 'Add at least one variant with its stock');
  return list.map((v) => {
    const stock = Number.parseInt(v.stock, 10);
    if (!(stock >= 0)) throw new HttpError(400, 'Stock must be 0 or more');
    return { id: v.id ? Number(v.id) : null, name: String(v.name).trim(), stock };
  });
}

function productFields(body) {
  const name = String(body.name || '').trim();
  const price = Number(body.price);
  if (!name) throw new HttpError(400, 'Product name is required');
  if (body.price === '' || !(price >= 0)) throw new HttpError(400, 'Price must be a number in RM');
  return {
    name,
    description: String(body.description || '').trim(),
    category: String(body.category || '').trim(),
    price_sen: toSen(price),
    discount: parseDiscount(body.discount_type, body.discount_value),
    variants: parseVariants(body.variants),
  };
}

// ---------- live updates (Server-Sent Events) ----------
const listeners = { boutique: new Set(), cafe: new Set() };
function broadcast(shop, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners[shop]) res.write(data);
}

app.get('/api/:shop/stream', shopParam, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  listeners[req.params.shop].add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); listeners[req.params.shop].delete(res); });
});

// ---------- public (customer) API ----------
app.get('/api/:shop/products', shopParam, async (req, res) => {
  res.json(await rpc('get_products', { p_shop: req.params.shop }));
});

app.post('/api/:shop/orders', shopParam, async (req, res) => {
  const { shop } = req.params;
  const b = req.body || {};
  const name = String(b.customer_name || '').trim();
  const phone = String(b.phone || '').trim();
  const method = b.method === 'pickup' ? 'pickup' : 'delivery';
  const address = String(b.address || '').trim();
  const num = (x) => (x != null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
  if (!name) throw new HttpError(400, 'Please enter your name');
  if (!/^[0-9+\-\s]{8,15}$/.test(phone)) throw new HttpError(400, 'Please enter a valid phone number');
  if (method === 'delivery' && !address) throw new HttpError(400, 'Please enter your delivery address');
  if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, 'Your cart is empty');

  const order = await rpc('place_order', {
    p_shop: shop,
    p_customer_name: name,
    p_phone: phone,
    p_method: method,
    p_address: address || null,
    p_lat: num(b.lat),
    p_lng: num(b.lng),
    p_notes: String(b.notes || '').trim() || null,
    p_items: b.items.map((it) => ({ variant_id: Number(it.variant_id), qty: Number.parseInt(it.qty, 10) })),
  });
  broadcast(shop, { type: 'products' });
  broadcast(shop, { type: 'orders', newOrder: order.id });
  res.status(201).json(order);
});

// ---------- seller API ----------
app.post('/api/:shop/login', shopParam, (req, res) => {
  const given = String(req.body?.password || '');
  const expected = PASSWORDS[req.params.shop];
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, req.params.shop);
  res.json({ token });
});

app.get('/api/:shop/seller/products', shopParam, requireSeller, async (req, res) => {
  res.json(await rpc('get_products', { p_shop: req.params.shop }));
});

async function saveProduct(req, res, id) {
  const f = productFields(req.body);
  const image = await saveImage(req.file);
  const productId = await rpc('save_product', {
    p_shop: req.params.shop,
    p_id: id,
    p_name: f.name,
    p_description: f.description,
    p_category: f.category,
    p_price_sen: f.price_sen,
    p_image: image,
    p_discount_type: f.discount.type,
    p_discount_value: f.discount.value,
    p_variants: f.variants,
  });
  broadcast(req.params.shop, { type: 'products' });
  res.status(id ? 200 : 201).json({ id: Number(productId) });
}

app.post('/api/:shop/products', shopParam, requireSeller, upload.single('image'), (req, res) => saveProduct(req, res, null));
app.put('/api/:shop/products/:id', shopParam, requireSeller, upload.single('image'), (req, res) => saveProduct(req, res, Number(req.params.id)));

app.delete('/api/:shop/products/:id', shopParam, requireSeller, async (req, res) => {
  await rpc('remove_product', { p_shop: req.params.shop, p_id: Number(req.params.id) });
  broadcast(req.params.shop, { type: 'products' });
  res.json({ ok: true });
});

// Store-wide discount ("apply to all products").
app.put('/api/:shop/discount', shopParam, requireSeller, async (req, res) => {
  const d = parseDiscount(req.body?.discount_type, req.body?.discount_value);
  const result = await rpc('set_store_discount', {
    p_shop: req.params.shop,
    p_discount_type: d.type,
    p_discount_value: d.value,
    p_override_individual: Boolean(req.body?.override_individual),
  });
  broadcast(req.params.shop, { type: 'products' });
  res.json(result);
});

const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];

app.get('/api/:shop/orders', shopParam, requireSeller, async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  res.json({ orders: await rpc('list_orders', { p_shop: req.params.shop, p_status: status }) });
});

app.patch('/api/:shop/orders/:id', shopParam, requireSeller, async (req, res) => {
  const status = req.body?.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown order status');
  await rpc('update_order_status', { p_shop: req.params.shop, p_id: Number(req.params.id), p_status: status });
  broadcast(req.params.shop, { type: 'products' });
  broadcast(req.params.shop, { type: 'orders' });
  res.json({ ok: true });
});

// Sales audit: what has been sold and the income (completed orders, cash collected).
app.get('/api/:shop/sales', shopParam, requireSeller, async (req, res) => {
  const date = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
  res.json(await rpc('sales_report', { p_shop: req.params.shop, p_from: date(req.query.from), p_to: date(req.query.to) }));
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`C.A.Q Cafe & Boutique running at http://localhost:${PORT} (database: ${mode})`);
    console.log(`  Boutique shop:   http://localhost:${PORT}/boutique`);
    console.log(`  Boutique seller: http://localhost:${PORT}/boutique/seller`);
    console.log(`  Cafe menu:       http://localhost:${PORT}/cafe`);
    console.log(`  Cafe seller:     http://localhost:${PORT}/cafe/seller`);
  });
}

module.exports = app;
