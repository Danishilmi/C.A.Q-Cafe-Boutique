# Sufi Amanda Boutique & Cafe

A web app with four interfaces for a boutique and a cafe. Payment is **Cash on Delivery (COD) only** and all prices are in **RM**.

| Interface | URL |
|---|---|
| Boutique, customer | `/boutique` |
| Boutique, seller | `/boutique/seller` |
| Cafe, customer | `/cafe` |
| Cafe, seller | `/cafe/seller` |

## Run it

Requires **Node.js 22.13 or newer** (uses the built-in `node:sqlite`, so there is no database to install).

```bash
npm install
npm start
```

Then open http://localhost:3000.

Default seller passwords are `boutique123` and `cafe123`. Change them before going live:

```bash
BOUTIQUE_PASSWORD=your-secret CAFE_PASSWORD=another-secret npm start
```

Other settings: `PORT` (default 3000), `DATA_DIR` (database location, default `./data`), `UPLOAD_DIR` (product images, default `./uploads`).

## Features

### Seller (boutique and cafe)
- Add, edit and remove products: name, category, image, price (RM), description.
- Variants with their own stock: colours for the boutique, options such as Hot / Iced or Regular / Large for the cafe.
- Discounts in RM or %:
  - **Per product**, set in the product form.
  - **All products**, in the Discounts tab. A product's own discount takes priority, or tick "also remove individual product discounts" to apply one discount to everything.
- Orders: customer name, phone (tap to call or WhatsApp), delivery or pickup, delivery address with a Google Maps link and GPS pin if the customer shared it. Move orders through Pending → Confirmed → Completed, or Cancel (stock is returned).
- Sales audit: income received, expected COD still to collect, items sold per product and variant, income per day, discounts given, with a date filter.
- New orders appear live without refreshing.

### Customer (boutique and cafe)
- Browse with category filter: image, price (with discount shown), description, variants, and **live stock** that updates when others order.
- Choose a variant, add to cart, change quantities.
- Place order with name, phone, delivery or pickup, address and optional "share my current location".

## How it works

- `server.js`: Express API and page routes. Prices are calculated on the server, and stock is checked and reduced inside a transaction so two customers cannot buy the last item.
- `db.js`: SQLite schema (products, variants, settings, orders, order_items). Money is stored in sen (RM × 100).
- `public/`: plain HTML, CSS and JavaScript. `customer.html` and `seller.html` serve both shops; the URL decides which shop is shown.
- Live updates use Server-Sent Events (`/api/:shop/stream`).

## Assumptions

- The spec described the cafe briefly, so the cafe mirrors the boutique: same discounts, stock, orders and sales audit, with "options" instead of colours.
- Income counts only orders marked **Completed**, meaning the cash has been collected.
- Stock is reserved when the order is placed and returned if the seller cancels.
- Customers do not need an account. Seller login is a simple password per shop and sessions reset when the server restarts.
