document.title = CONFIG.title;
document.getElementById('brand').textContent = CONFIG.title;
document.getElementById('tagline').textContent = CONFIG.tagline;

const CART_KEY = `cart-${SHOP}`;
let products = [];
let category = '';
let cart = loadCart(); // [{variant_id, product_id, qty}]
const selected = {};   // product_id -> variant_id
let lastOrder = null;  // shown in the drawer after a successful order

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch {}
  renderCart();
}

function findVariant(variantId) {
  for (const p of products) {
    const v = p.variants.find((x) => x.id === variantId);
    if (v) return { p, v };
  }
  return null;
}

let lastJson = '';
async function load() {
  const data = await api('/products');
  const json = JSON.stringify(data);
  if (json === lastJson) return; // nothing changed, keep the page as it is
  lastJson = json;
  products = data.products;
  const banner = document.getElementById('storeBanner');
  const sd = data.storeDiscount;
  banner.hidden = !sd.discount_type;
  if (sd.discount_type) banner.textContent = `🎉 Store-wide promotion: ${discountLabel({ type: sd.discount_type, value: sd.discount_value })}`;
  renderCategories();
  renderProducts();
  renderCart();
}

function renderCategories() {
  const cats = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const el = document.getElementById('categories');
  el.hidden = cats.length === 0;
  el.innerHTML = ['', ...cats].map((c) => `<button class="chip ${c === category ? 'on' : ''}" data-cat="${esc(c)}">${esc(c || 'All')}</button>`).join('');
}

function renderProducts() {
  const list = products.filter((p) => !category || p.category === category);
  const el = document.getElementById('products');
  if (list.length === 0) { el.innerHTML = `<p class="muted">No ${CONFIG.itemWord}s yet. Please check back soon.</p>`; return; }
  el.innerHTML = list.map((p) => {
    const inStock = p.variants.filter((v) => v.stock > 0);
    if (!selected[p.id] || !p.variants.some((v) => v.id === selected[p.id])) selected[p.id] = (inStock[0] || p.variants[0])?.id;
    const sel = p.variants.find((v) => v.id === selected[p.id]);
    const inCart = cart.find((c) => c.variant_id === sel?.id)?.qty || 0;
    const left = sel ? sel.stock - inCart : 0;
    return `
    <article class="card">
      <div class="img">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : '<div class="noimg">No image</div>'}
        ${p.applied_discount ? `<span class="tag">${discountLabel(p.applied_discount)}</span>` : ''}</div>
      <div class="body">
        <h3>${esc(p.name)}</h3>
        <div class="price">${rm(p.final_price_sen)} ${p.final_price_sen < p.price_sen ? `<s>${rm(p.price_sen)}</s>` : ''}</div>
        ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
        <div class="muted small">${CONFIG.variantLabel}</div>
        <div class="variants">${p.variants.map((v) => `
          <button class="chip ${v.id === sel?.id ? 'on' : ''}" data-pid="${p.id}" data-vid="${v.id}" ${v.stock === 0 ? 'disabled title="Sold out"' : ''}>${esc(v.name)}</button>`).join('')}
        </div>
        <div class="stock ${left <= 0 ? 'out' : left <= 3 ? 'low' : ''}">${left <= 0 ? (sel?.stock === 0 ? 'Sold out' : 'All remaining stock is in your cart') : `${left} ${CONFIG.stockWord}`}</div>
        <button class="btn primary block" data-add="${sel?.id}" ${left <= 0 ? 'disabled' : ''}>Add to cart</button>
      </div>
    </article>`;
  }).join('');
}

function renderCart() {
  // Drop items that disappeared and cap quantities at current stock.
  cart = cart.filter((c) => findVariant(c.variant_id) || products.length === 0);
  let subtotal = 0, total = 0, count = 0;
  const rows = cart.map((c) => {
    const found = findVariant(c.variant_id);
    if (!found) return '';
    const { p, v } = found;
    const over = c.qty > v.stock;
    subtotal += p.price_sen * c.qty; total += p.final_price_sen * c.qty; count += c.qty;
    return `<div class="cart-row">
      ${p.image ? `<img src="${esc(p.image)}" alt="">` : '<div class="thumb"></div>'}
      <div class="grow"><strong>${esc(p.name)}</strong><div class="muted small">${CONFIG.variantLabel}: ${esc(v.name)}</div>
        ${over ? `<div class="error small">Only ${v.stock} left</div>` : ''}</div>
      <div class="qty"><button class="btn ghost small" data-dec="${v.id}">−</button><span>${c.qty}</span><button class="btn ghost small" data-inc="${v.id}" ${c.qty >= v.stock ? 'disabled' : ''}>+</button></div>
      <div class="right">${rm(p.final_price_sen * c.qty)}</div>
    </div>`;
  }).join('');
  document.getElementById('cartCount').textContent = count;
  document.getElementById('cartItems').innerHTML = rows || (lastOrder ? `<div class="success">
      <h3>Thank you! Order #${lastOrder.id} placed.</h3>
      <p>Please prepare <strong>${rm(lastOrder.total_sen)}</strong> in cash. The seller will contact you on your phone number.</p></div>`
    : '<p class="muted">Your cart is empty.</p>');
  document.getElementById('cartTotals').innerHTML = count ? `
    ${subtotal !== total ? `<div><span>Subtotal</span><span>${rm(subtotal)}</span></div><div class="save"><span>Discount</span><span>− ${rm(subtotal - total)}</span></div>` : ''}
    <div class="grand"><span>Total (COD)</span><span>${rm(total)}</span></div>` : '';
  document.getElementById('checkout').hidden = count === 0;
}

// ---------- events ----------
document.getElementById('categories').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  category = b.dataset.cat; renderCategories(); renderProducts();
});

document.getElementById('products').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-vid]');
  if (chip) { selected[chip.dataset.pid] = Number(chip.dataset.vid); renderProducts(); return; }
  const add = e.target.closest('[data-add]');
  if (add) {
    const vid = Number(add.dataset.add);
    const item = cart.find((c) => c.variant_id === vid);
    lastOrder = null;
    if (item) item.qty++; else cart.push({ variant_id: vid, qty: 1 });
    saveCart(); renderProducts(); toast('Added to cart');
  }
});

document.getElementById('cartItems').addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
  const vid = Number((inc || dec)?.dataset.inc || (inc || dec)?.dataset.dec);
  const item = cart.find((c) => c.variant_id === vid); if (!item) return;
  item.qty += inc ? 1 : -1;
  if (item.qty <= 0) cart = cart.filter((c) => c !== item);
  saveCart(); renderProducts();
});

const drawer = document.getElementById('drawer');
document.getElementById('cartBtn').onclick = () => { drawer.hidden = false; };
document.getElementById('closeCart').onclick = () => { drawer.hidden = true; };
drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.hidden = true; });

const form = document.getElementById('checkout');
form.addEventListener('change', (e) => {
  if (e.target.name === 'method') document.getElementById('deliveryFields').hidden = e.target.value !== 'delivery';
});

document.getElementById('locBtn').onclick = () => {
  const status = document.getElementById('locStatus');
  if (!navigator.geolocation) { status.textContent = 'Location is not supported on this device.'; return; }
  status.textContent = 'Getting location…';
  navigator.geolocation.getCurrentPosition((pos) => {
    form.lat.value = pos.coords.latitude; form.lng.value = pos.coords.longitude;
    status.textContent = '✓ Location shared with the seller';
  }, () => { status.textContent = 'Could not get your location. Please type your address.'; }, { enableHighAccuracy: true, timeout: 10000 });
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  const btn = document.getElementById('placeBtn');
  btn.disabled = true;
  try {
    const order = await api('/orders', { method: 'POST', body: { ...fd, items: cart.map(({ variant_id, qty }) => ({ variant_id, qty })) } });
    lastOrder = order;
    cart = []; saveCart(); form.reset();
    document.getElementById('deliveryFields').hidden = false;
    document.getElementById('locStatus').textContent = '';
    await load();
  } catch (err) {
    toast(err.message, 'err');
    await load();
  } finally { btn.disabled = false; }
});

poll(() => load().catch(() => {}), 5000);
load().catch((err) => { document.getElementById('products').innerHTML = `<p class="error">${esc(err.message)}</p>`; });
