const TOKEN_KEY = `seller-token-${SHOP}`;
let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
let products = [];
let currentTab = 'products';

document.title = `${CONFIG.title} · Seller`;
document.getElementById('loginTitle').textContent = `${CONFIG.title} seller`;
document.getElementById('brand').textContent = CONFIG.title;
document.getElementById('shopLink').href = `/${SHOP}`;
document.getElementById('viewShop').href = `/${SHOP}`;
document.getElementById('variantLegend').textContent = `${CONFIG.variantLabel}s`;
document.getElementById('variantWord').textContent = CONFIG.variantLabel.toLowerCase();
document.getElementById('categoryInput').placeholder = CONFIG.categoryPlaceholder;
const itemTitle = CONFIG.itemWord[0].toUpperCase() + CONFIG.itemWord.slice(1);
document.getElementById('productsHeading').textContent = itemTitle + 's';
document.getElementById('newProduct').textContent = `+ Add ${CONFIG.itemWord}`;

const sapi = (path, opts = {}) => api(path, { ...opts, token }).catch((err) => {
  if (err.status === 401) showLogin();
  throw err;
});

// ---------- login ----------
function showLogin() {
  token = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  document.getElementById('login').hidden = false;
  document.getElementById('app').hidden = true;
}
async function showApp() {
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  await Promise.all([loadProducts(), loadOrders()]);
}
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    ({ token } = await api('/login', { method: 'POST', body: { password: e.target.password.value } }));
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch {}
    e.target.reset();
    showApp();
  } catch (err) { toast(err.message, 'err'); }
});
document.getElementById('logout').onclick = showLogin;

// ---------- tabs ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  currentTab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== currentTab; });
  if (currentTab === 'sales') loadSales();
  if (currentTab === 'orders') loadOrders();
  if (currentTab === 'discount') loadDiscount();
});

// ---------- products ----------
let storeDiscount = {};
async function loadProducts() {
  const data = await sapi('/seller/products');
  products = data.products; storeDiscount = data.storeDiscount;
  const t = document.getElementById('productTable');
  document.getElementById('categoryList').innerHTML = [...new Set(products.map((p) => p.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('');
  if (products.length === 0) { t.innerHTML = `<tr><td class="muted">No ${CONFIG.itemWord}s yet. Click “Add ${CONFIG.itemWord}” to start.</td></tr>`; return; }
  t.innerHTML = `<thead><tr><th></th><th>Name</th><th>Price</th><th>Discount</th><th>${CONFIG.variantLabel}s (stock)</th><th>Total stock</th><th></th></tr></thead><tbody>` +
    products.map((p) => `<tr>
      <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : '<div class="thumb"></div>'}</td>
      <td><strong>${esc(p.name)}</strong><div class="muted small">${esc(p.category)}</div></td>
      <td>${rm(p.final_price_sen)}${p.final_price_sen < p.price_sen ? `<div class="muted small"><s>${rm(p.price_sen)}</s></div>` : ''}</td>
      <td>${p.applied_discount ? `${discountLabel(p.applied_discount)}<div class="muted small">${p.applied_discount.source === 'store' ? 'all products' : 'this product'}</div>` : '—'}</td>
      <td>${p.variants.map((v) => `<span class="pill ${v.stock === 0 ? 'out' : v.stock <= 3 ? 'low' : ''}">${esc(v.name)}: ${v.stock}</span>`).join(' ')}</td>
      <td>${p.total_stock}</td>
      <td class="right nowrap"><button class="btn ghost small" data-edit="${p.id}">Edit</button> <button class="btn ghost small danger" data-del="${p.id}">Remove</button></td>
    </tr>`).join('') + '</tbody>';
}

const dialog = document.getElementById('productDialog');
const pform = document.getElementById('productForm');

function variantRow(v = {}) {
  const div = document.createElement('div');
  div.className = 'row variant-row';
  div.innerHTML = `<input type="hidden" data-f="id" value="${v.id || ''}">
    <input data-f="name" placeholder="${esc(CONFIG.variantPlaceholder)}" value="${esc(v.name || '')}" required>
    <input data-f="stock" type="number" min="0" step="1" placeholder="Stock" value="${v.stock ?? ''}" required>
    <button type="button" class="btn ghost small" data-remove aria-label="Remove">✕</button>`;
  return div;
}

function openProductForm(p) {
  pform.reset();
  pform.id.value = p?.id || '';
  document.getElementById('formTitle').textContent = p ? `Edit ${CONFIG.itemWord}` : `Add ${CONFIG.itemWord}`;
  if (p) {
    pform.name.value = p.name; pform.category.value = p.category; pform.price.value = (p.price_sen / 100).toFixed(2);
    pform.description.value = p.description;
    pform.discount_type.value = p.discount_type || 'none'; pform.discount_value.value = p.discount_value ?? '';
  }
  const prev = document.getElementById('imagePreview');
  prev.hidden = !p?.image; prev.src = p?.image || '';
  const rows = document.getElementById('variantRows');
  rows.innerHTML = '';
  (p?.variants?.length ? p.variants : [{}]).forEach((v) => rows.appendChild(variantRow(v)));
  dialog.showModal();
}

document.getElementById('newProduct').onclick = () => openProductForm();
document.getElementById('cancelProduct').onclick = () => dialog.close();
document.getElementById('addVariant').onclick = () => document.getElementById('variantRows').appendChild(variantRow());
document.getElementById('variantRows').addEventListener('click', (e) => {
  if (e.target.closest('[data-remove]')) {
    const rows = document.getElementById('variantRows');
    if (rows.children.length > 1) e.target.closest('.variant-row').remove();
  }
});
document.getElementById('imageInput').addEventListener('change', (e) => {
  const f = e.target.files[0]; const prev = document.getElementById('imagePreview');
  if (f) { prev.src = URL.createObjectURL(f); prev.hidden = false; }
});

pform.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(pform);
  const variants = [...document.querySelectorAll('.variant-row')].map((r) => ({
    id: r.querySelector('[data-f=id]').value || null,
    name: r.querySelector('[data-f=name]').value,
    stock: r.querySelector('[data-f=stock]').value,
  }));
  fd.set('variants', JSON.stringify(variants));
  if (!fd.get('image')?.size) fd.delete('image');
  const id = fd.get('id'); fd.delete('id');
  try {
    await sapi(id ? `/products/${id}` : '/products', { method: id ? 'PUT' : 'POST', body: fd });
    dialog.close(); toast('Saved'); loadProducts();
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('productTable').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
  if (edit) openProductForm(products.find((p) => p.id === Number(edit.dataset.edit)));
  if (del && confirm('Remove this product from the shop? Past orders are kept.')) {
    await sapi(`/products/${del.dataset.del}`, { method: 'DELETE' }); loadProducts();
  }
});

// ---------- orders ----------
const STATUS_ACTIONS = {
  pending: [['confirmed', 'Confirm'], ['cancelled', 'Cancel']],
  confirmed: [['completed', 'Mark completed (cash received)'], ['cancelled', 'Cancel']],
};
async function loadOrders() {
  const status = document.getElementById('orderFilter').value;
  const [{ orders }, pending] = await Promise.all([
    sapi(`/orders${status ? `?status=${status}` : ''}`),
    sapi('/orders?status=pending'),
  ]);
  const badge = document.getElementById('pendingCount');
  badge.hidden = pending.orders.length === 0; badge.textContent = pending.orders.length;
  const el = document.getElementById('orderList');
  if (orders.length === 0) { el.innerHTML = '<p class="muted">No orders here.</p>'; return; }
  el.innerHTML = orders.map((o) => {
    const mapUrl = o.lat != null ? `https://www.google.com/maps?q=${o.lat},${o.lng}`
      : o.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.address)}` : null;
    return `<article class="order">
      <div class="row between"><strong>Order #${o.id}</strong><span class="status ${o.status}">${o.status}</span></div>
      <div class="muted small">${new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-MY')}</div>
      <div class="profile">
        <div><span class="muted small">Customer</span><div>${esc(o.customer_name)}</div></div>
        <div><span class="muted small">Phone</span><div><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a> · <a href="https://wa.me/${esc(o.phone.replace(/\D/g, '').replace(/^0/, '60'))}" target="_blank">WhatsApp</a></div></div>
        <div><span class="muted small">Method</span><div>${o.method === 'delivery' ? '🚚 Delivery' : '🏪 Self pickup'}</div></div>
        ${o.method === 'delivery' ? `<div class="wide"><span class="muted small">Location</span><div>${esc(o.address || '')}${mapUrl ? ` <a href="${mapUrl}" target="_blank">Open in Google Maps ↗</a>` : ''}${o.lat != null ? ' <span class="muted small">(GPS pin shared)</span>' : ''}</div></div>` : ''}
        ${o.notes ? `<div class="wide"><span class="muted small">Notes</span><div>${esc(o.notes)}</div></div>` : ''}
      </div>
      <table class="table compact">${o.items.map((i) => `<tr><td>${esc(i.product_name)} <span class="muted small">(${esc(i.variant_name)})</span></td><td>× ${i.qty}</td><td class="right">${rm(i.unit_price_sen * i.qty)}</td></tr>`).join('')}
        ${o.discount_sen ? `<tr class="muted"><td colspan="2">Discount</td><td class="right">− ${rm(o.discount_sen)}</td></tr>` : ''}
        <tr><td colspan="2"><strong>Total to collect (COD)</strong></td><td class="right"><strong>${rm(o.total_sen)}</strong></td></tr></table>
      <div class="row end">${(STATUS_ACTIONS[o.status] || []).map(([s, label]) => `<button class="btn ${s === 'cancelled' ? 'ghost danger' : 'primary'} small" data-order="${o.id}" data-status="${s}">${label}</button>`).join('')}</div>
    </article>`;
  }).join('');
}
document.getElementById('orderFilter').onchange = loadOrders;
document.getElementById('orderList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-order]'); if (!b) return;
  if (b.dataset.status === 'cancelled' && !confirm('Cancel this order? The stock will be returned.')) return;
  try { await sapi(`/orders/${b.dataset.order}`, { method: 'PATCH', body: { status: b.dataset.status } }); loadOrders(); loadProducts(); }
  catch (err) { toast(err.message, 'err'); }
});

// ---------- sales ----------
async function loadSales() {
  const f = document.getElementById('salesRange');
  const q = new URLSearchParams();
  if (f.from.value) q.set('from', f.from.value);
  if (f.to.value) q.set('to', f.to.value);
  const { totals: t, items, daily } = await sapi(`/sales?${q}`);
  document.getElementById('stats').innerHTML = [
    ['Income received', rm(t.income_sen), `${t.completed_orders || 0} completed orders`],
    ['Expected COD', rm(t.expected_sen), `${t.open_orders || 0} open orders`],
    ['Items sold', items.reduce((s, i) => s + i.qty, 0), `${items.length} different ${CONFIG.variantLabel.toLowerCase()}s`],
    ['Discounts given', rm(t.discount_given_sen), `${t.cancelled_orders || 0} cancelled orders`],
  ].map(([label, value, sub]) => `<div class="stat"><div class="muted small">${label}</div><div class="value">${value}</div><div class="muted small">${sub}</div></div>`).join('');
  document.getElementById('soldTable').innerHTML = items.length
    ? `<thead><tr><th>${itemTitle}</th><th>${CONFIG.variantLabel}</th><th class="right">Qty sold</th><th class="right">Income</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.product_name)}</td><td>${esc(i.variant_name)}</td><td class="right">${i.qty}</td><td class="right">${rm(i.revenue_sen)}</td></tr>`).join('')}</tbody>`
    : '<tr><td class="muted">No completed sales in this period yet.</td></tr>';
  document.getElementById('dailyTable').innerHTML = daily.length
    ? `<thead><tr><th>Date</th><th class="right">Orders</th><th class="right">Income</th></tr></thead><tbody>${daily.map((d) => `<tr><td>${d.day}</td><td class="right">${d.orders}</td><td class="right">${rm(d.income_sen)}</td></tr>`).join('')}</tbody>`
    : '<tr><td class="muted">—</td></tr>';
}
document.getElementById('salesRange').addEventListener('submit', (e) => { e.preventDefault(); loadSales(); });

// ---------- store-wide discount ----------
function loadDiscount() {
  const f = document.getElementById('storeDiscount');
  f.discount_type.value = storeDiscount.discount_type || 'none';
  f.discount_value.value = storeDiscount.discount_value ?? '';
}
document.getElementById('storeDiscount').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    storeDiscount = await sapi('/discount', { method: 'PUT', body: {
      discount_type: f.discount_type.value, discount_value: f.discount_value.value, override_individual: f.override_individual.checked,
    } });
    f.override_individual.checked = false;
    toast('Discount saved'); loadProducts();
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- live updates ----------
subscribe((ev) => {
  if (!token) return;
  if (ev.type === 'orders') { loadOrders(); if (currentTab === 'sales') loadSales(); if (ev.newOrder) toast(`New order #${ev.newOrder} received`); }
  if (ev.type === 'products') loadProducts();
});

if (token) showApp().catch(() => {}); else showLogin();
