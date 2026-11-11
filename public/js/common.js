// Shared helpers for all four interfaces.
const SHOP = location.pathname.startsWith('/cafe') ? 'cafe' : 'boutique';

const CONFIG = {
  boutique: {
    title: 'Sufi Amanda Boutique',
    tagline: 'Modest fashion, delivered to your door',
    itemWord: 'product',
    variantLabel: 'Colour',
    variantPlaceholder: 'e.g. Dusty Pink',
    stockWord: 'in stock',
    categoryPlaceholder: 'e.g. Baju Kurung, Tudung, Abaya',
  },
  cafe: {
    title: 'Sufi Amanda Cafe',
    tagline: 'Freshly made food and drinks',
    itemWord: 'menu item',
    variantLabel: 'Option',
    variantPlaceholder: 'e.g. Hot, Iced, Large',
    stockWord: 'available',
    categoryPlaceholder: 'e.g. Drinks, Food, Dessert',
  },
}[SHOP];

document.body.dataset.shop = SHOP;

const rm = (sen) => 'RM ' + (sen / 100).toFixed(2);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function discountLabel(d) {
  if (!d) return '';
  return d.type === 'percent' ? `${+d.value}% OFF` : `RM ${(+d.value).toFixed(2)} OFF`;
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/${SHOP}${path}`, {
    method, headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

// Live updates: call `onEvent` whenever stock or orders change on the server.
function subscribe(onEvent) {
  const es = new EventSource(`/api/${SHOP}/stream`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  return es;
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
