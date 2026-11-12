// Database access. Every read and write goes through a Postgres function defined in
// supabase/migrations, so the same code works two ways:
//   1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: calls the functions with supabase.rpc() over HTTPS.
//   2. DATABASE_URL: calls them over a direct Postgres connection (handy for local development).
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const supabase = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

let pool = null;
if (!supabase) {
  if (!DATABASE_URL) {
    throw new Error('Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).');
  }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL });
}

// Our functions raise these codes for problems the customer or seller can fix.
const STATUS_BY_CODE = { CA400: 400, CA404: 404, CA409: 409, 23514: 400, '22P02': 400 };

class DbError extends Error {
  constructor(err) {
    super(err.message);
    this.code = err.code;
    this.status = STATUS_BY_CODE[err.code] || 500;
  }
}

async function rpc(name, params = {}) {
  if (supabase) {
    const { data, error } = await supabase.rpc(name, params);
    if (error) throw new DbError(error);
    return data;
  }
  const keys = Object.keys(params);
  const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
  const values = keys.map((k) => {
    const v = params[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  try {
    const { rows } = await pool.query(`select public.${name}(${args}) as result`, values);
    return rows[0].result;
  } catch (err) {
    throw new DbError(err);
  }
}

module.exports = { rpc, supabase, mode: supabase ? 'supabase' : 'postgres' };
