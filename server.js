const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, transaction } = require('./db');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Seller passwords. Change these with environment variables before going live.
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

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
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

// A product's own discount wins; otherwise the store-wide discount applies.
function effectivePrice(product, storeDiscount) {
  const d = product.discount_type ? { type: product.discount_type, value: product.discount_value, source: 'product' }
    : storeDiscount.discount_type ? { type: storeDiscount.discount_type, value: storeDiscount.discount_value, source: 'store' }
    : null;
  if (!d) return { price_sen: product.price_sen, discount: null };
  const off = d.type === 'percent' ? Math.round(product.price_sen * d.value / 100) : toSen(d.value);
  return { price_sen: Math.max(0, product.price_sen - off), discount: d };
}

function getStoreDiscount(shop) {
  return db.prepare('SELECT discount_type, discount_value FROM settings WHERE shop = ?').get(shop);
}

function listProducts(shop, includeInactive = false) {
  const store = getStoreDiscount(shop);
  const products = db.prepare(`SELECT * FROM products WHERE shop = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY created_at DESC, id DESC`).all(shop);
  const variantStmt = db.prepare('SELECT id, name, stock FROM variants WHERE product_id = ? AND active = 1 ORDER BY id');
  return products.map((p) => {
    const variants = variantStmt.all(p.id).map((v) => ({ ...v }));
    const { price_sen, discount } = effectivePrice(p, store);
    return {
      ...p,
      variants,
      total_stock: variants.reduce((s, v) => s + v.stock, 0),
      final_price_sen: price_sen,
      applied_discount: discount,
    };
  });
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
app.get('/api/:shop/products', shopParam, (req, res) => {
  res.json({ products: listProducts(req.params.shop), storeDiscount: getStoreDiscount(req.params.shop) });
});

app.post('/api/:shop/orders', shopParam, (req, res) => {
  const { shop } = req.params;
  const b = req.body || {};
  const name = String(b.customer_name || '').trim();
  const phone = String(b.phone || '').trim();
  const method = b.method === 'pickup' ? 'pickup' : 'delivery';
  const address = String(b.address || '').trim();
  const lat = b.lat != null && b.lat !== '' ? Number(b.lat) : null;
  const lng = b.lng != null && b.lng !== '' ? Number(b.lng) : null;
  if (!name) throw new HttpError(400, 'Please enter your name');
  if (!/^[0-9+\-\s]{8,15}$/.test(phone)) throw new HttpError(400, 'Please enter a valid phone number');
  if (method === 'delivery' && !address) throw new HttpError(400, 'Please enter your delivery address');
  if (!Array.isArray(b.items) || b.items.length === 0) throw new HttpError(400, 'Your cart is empty');

  const store = getStoreDiscount(shop);
  const order = transaction(() => {
    let subtotal = 0, total = 0;
    const lines = b.items.map((it) => {
      const qty = Number.parseInt(it.qty, 10);
      if (!(qty > 0)) throw new HttpError(400, 'Invalid quantity');
      const row = db.prepare(`SELECT v.id AS variant_id, v.name AS variant_name, v.stock, p.*
        FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ? AND p.shop = ? AND p.active = 1 AND v.active = 1`).get(it.variant_id, shop);
      if (!row) throw new HttpError(400, 'An item in your cart is no longer available');
      if (row.stock < qty) throw new HttpError(409, `Only ${row.stock} left of ${row.name} (${row.variant_name})`);
      const { price_sen } = effectivePrice(row, store);
      subtotal += row.price_sen * qty;
      total += price_sen * qty;
      return { row, qty, price_sen };
    });
    const info = db.prepare(`INSERT INTO orders (shop, customer_name, phone, method, address, lat, lng, notes, subtotal_sen, discount_sen, total_sen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(shop, name, phone, method, method === 'delivery' ? address : null,
      method === 'delivery' ? lat : null, method === 'delivery' ? lng : null, String(b.notes || '').trim() || null,
      subtotal, subtotal - total, total);
    const orderId = Number(info.lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_name, qty, original_price_sen, unit_price_sen)
      VALUES (?,?,?,?,?,?,?,?)`);
    const decStock = db.prepare('UPDATE variants SET stock = stock - ? WHERE id = ?');
    for (const { row, qty, price_sen } of lines) {
      insItem.run(orderId, row.id, row.variant_id, row.name, row.variant_name, qty, row.price_sen, price_sen);
      decStock.run(qty, row.variant_id);
    }
    return { id: orderId, total_sen: total };
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

app.get('/api/:shop/seller/products', shopParam, requireSeller, (req, res) => {
  res.json({ products: listProducts(req.params.shop), storeDiscount: getStoreDiscount(req.params.shop) });
});

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
  if (!(price >= 0)) throw new HttpError(400, 'Price must be a number in RM');
  const discount = parseDiscount(body.discount_type, body.discount_value);
  return { name, description: String(body.description || '').trim(), category: String(body.category || '').trim(), price_sen: toSen(price), discount };
}

app.post('/api/:shop/products', shopParam, requireSeller, upload.single('image'), (req, res) => {
  const f = productFields(req.body);
  const variants = parseVariants(req.body.variants);
  const id = transaction(() => {
    const info = db.prepare(`INSERT INTO products (shop, name, description, category, price_sen, image, discount_type, discount_value)
      VALUES (?,?,?,?,?,?,?,?)`).run(req.params.shop, f.name, f.description, f.category, f.price_sen,
      req.file ? `/uploads/${req.file.filename}` : null, f.discount.type, f.discount.value);
    const pid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO variants (product_id, name, stock) VALUES (?,?,?)');
    variants.forEach((v) => ins.run(pid, v.name, v.stock));
    return pid;
  });
  broadcast(req.params.shop, { type: 'products' });
  res.status(201).json({ id });
});

app.put('/api/:shop/products/:id', shopParam, requireSeller, upload.single('image'), (req, res) => {
  const { shop } = req.params;
  const pid = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ? AND shop = ?').get(pid, shop);
  if (!existing) throw new HttpError(404, 'Product not found');
  const f = productFields(req.body);
  const variants = parseVariants(req.body.variants);
  transaction(() => {
    db.prepare(`UPDATE products SET name=?, description=?, category=?, price_sen=?, discount_type=?, discount_value=?, image=COALESCE(?, image) WHERE id=?`)
      .run(f.name, f.description, f.category, f.price_sen, f.discount.type, f.discount.value, req.file ? `/uploads/${req.file.filename}` : null, pid);
    const keep = new Set();
    for (const v of variants) {
      if (v.id && db.prepare('SELECT 1 FROM variants WHERE id = ? AND product_id = ?').get(v.id, pid)) {
        db.prepare('UPDATE variants SET name=?, stock=?, active=1 WHERE id=?').run(v.name, v.stock, v.id);
        keep.add(v.id);
      } else {
        keep.add(Number(db.prepare('INSERT INTO variants (product_id, name, stock) VALUES (?,?,?)').run(pid, v.name, v.stock).lastInsertRowid));
      }
    }
    // Removed variants are hidden rather than deleted so old orders still make sense.
    for (const { id } of db.prepare('SELECT id FROM variants WHERE product_id = ?').all(pid)) {
      if (!keep.has(id)) db.prepare('UPDATE variants SET active = 0 WHERE id = ?').run(id);
    }
  });
  broadcast(shop, { type: 'products' });
  res.json({ id: pid });
});

app.delete('/api/:shop/products/:id', shopParam, requireSeller, (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ? AND shop = ?').run(Number(req.params.id), req.params.shop);
  broadcast(req.params.shop, { type: 'products' });
  res.json({ ok: true });
});

// Store-wide discount ("apply to all products").
app.put('/api/:shop/discount', shopParam, requireSeller, (req, res) => {
  const d = parseDiscount(req.body?.discount_type, req.body?.discount_value);
  db.prepare('UPDATE settings SET discount_type = ?, discount_value = ? WHERE shop = ?').run(d.type, d.value, req.params.shop);
  // Optionally clear per-product discounts so the store-wide one applies to every product.
  if (req.body?.override_individual) db.prepare('UPDATE products SET discount_type = NULL, discount_value = NULL WHERE shop = ?').run(req.params.shop);
  broadcast(req.params.shop, { type: 'products' });
  res.json(getStoreDiscount(req.params.shop));
});

function getOrderItems(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map((i) => ({ ...i }));
}

app.get('/api/:shop/orders', shopParam, requireSeller, (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE shop = ? AND status = ? ORDER BY id DESC').all(req.params.shop, status)
    : db.prepare('SELECT * FROM orders WHERE shop = ? ORDER BY id DESC').all(req.params.shop);
  res.json({ orders: rows.map((o) => ({ ...o, items: getOrderItems(o.id) })) });
});

const TRANSITIONS = { pending: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [] };

app.patch('/api/:shop/orders/:id', shopParam, requireSeller, (req, res) => {
  const { shop } = req.params;
  const id = Number(req.params.id);
  const next = req.body?.status;
  transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND shop = ?').get(id, shop);
    if (!order) throw new HttpError(404, 'Order not found');
    if (!TRANSITIONS[order.status].includes(next)) throw new HttpError(400, `Cannot change a ${order.status} order to ${next}`);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next, id);
    if (next === 'cancelled') {
      // Put the stock back.
      const inc = db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ?');
      getOrderItems(id).forEach((i) => inc.run(i.qty, i.variant_id));
    }
  });
  broadcast(shop, { type: 'products' });
  broadcast(shop, { type: 'orders' });
  res.json({ ok: true });
});

// Sales audit: what has been sold and the income. Income counts completed orders (cash collected on delivery).
app.get('/api/:shop/sales', shopParam, requireSeller, (req, res) => {
  const { shop } = req.params;
  const from = req.query.from || '0000-01-01';
  const to = req.query.to || '9999-12-31';
  const range = [shop, from, to];
  const where = `o.shop = ? AND date(o.created_at, '+8 hours') BETWEEN ? AND ?`;
  const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='completed' THEN total_sen END),0) AS income_sen,
      COALESCE(SUM(CASE WHEN status IN ('pending','confirmed') THEN total_sen END),0) AS expected_sen,
      COALESCE(SUM(CASE WHEN status='completed' THEN discount_sen END),0) AS discount_given_sen,
      SUM(status='completed') AS completed_orders,
      SUM(status IN ('pending','confirmed')) AS open_orders,
      SUM(status='cancelled') AS cancelled_orders
    FROM orders o WHERE ${where}`).get(...range);
  const items = db.prepare(`SELECT i.product_name, i.variant_name, SUM(i.qty) AS qty, SUM(i.qty * i.unit_price_sen) AS revenue_sen
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE ${where} AND o.status = 'completed'
    GROUP BY i.product_id, i.variant_id ORDER BY revenue_sen DESC`).all(...range);
  const daily = db.prepare(`SELECT date(o.created_at, '+8 hours') AS day, SUM(total_sen) AS income_sen, COUNT(*) AS orders
    FROM orders o WHERE ${where} AND o.status = 'completed' GROUP BY day ORDER BY day DESC`).all(...range);
  res.json({ totals: { ...totals }, items: items.map((r) => ({ ...r })), daily: daily.map((r) => ({ ...r })) });
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sufi Amanda running at http://localhost:${PORT}`);
    console.log(`  Boutique shop:   http://localhost:${PORT}/boutique`);
    console.log(`  Boutique seller: http://localhost:${PORT}/boutique/seller`);
    console.log(`  Cafe menu:       http://localhost:${PORT}/cafe`);
    console.log(`  Cafe seller:     http://localhost:${PORT}/cafe/seller`);
  });
}

module.exports = app;
