// Database setup using Node's built-in SQLite (Node 22.13+), so there is nothing native to compile.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'shop.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL CHECK (shop IN ('boutique','cafe')),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  price_sen INTEGER NOT NULL,              -- prices stored in sen (RM x 100) to avoid rounding errors
  image TEXT,
  discount_type TEXT CHECK (discount_type IN ('rm','percent')),
  discount_value REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Colour variants for the boutique, options (e.g. Hot / Iced, Regular / Large) for the cafe.
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active INTEGER NOT NULL DEFAULT 1
);

-- Store-wide discount, one row per shop. A product's own discount overrides it.
CREATE TABLE IF NOT EXISTS settings (
  shop TEXT PRIMARY KEY,
  discount_type TEXT CHECK (discount_type IN ('rm','percent')),
  discount_value REAL
);
INSERT OR IGNORE INTO settings (shop) VALUES ('boutique'), ('cafe');

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('delivery','pickup')),
  address TEXT,
  lat REAL,
  lng REAL,
  notes TEXT,
  subtotal_sen INTEGER NOT NULL,
  discount_sen INTEGER NOT NULL,
  total_sen INTEGER NOT NULL,
  payment TEXT NOT NULL DEFAULT 'COD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  original_price_sen INTEGER NOT NULL,
  unit_price_sen INTEGER NOT NULL
);
`);

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, transaction };
