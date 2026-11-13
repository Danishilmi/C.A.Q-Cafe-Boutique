# C.A.Q Cafe & Boutique

A web app with four interfaces for a boutique and a cafe. Payment is **Cash on Delivery (COD) only** and all prices are in **RM**.

| Interface | URL |
|---|---|
| Boutique, customer | `/boutique` |
| Boutique, seller | `/boutique/seller` |
| Cafe, customer | `/cafe` |
| Cafe, seller | `/cafe/seller` |

## Set up the Supabase database

1. In your Supabase project, open **SQL Editor**, paste each file from `supabase/migrations/` **in filename order**, and press **Run**:
   - `20261112000000_initial_schema.sql`: tables, types and Row Level Security
   - `20261112000100_app_functions.sql`: functions for products, orders, stock and sales
   - `20261112000200_storage_bucket.sql`: the public `product-images` bucket for photos

   If you use the Supabase CLI instead: `supabase link --project-ref <your-ref>` then `supabase db push`.
2. Copy `.env.example` to `.env` and fill in **Project URL** and the **service_role** key from Project Settings → API. Change the two seller passwords too. `.env` is git-ignored; never commit it or share the service_role key.

### Tables

| Table | What it holds |
|---|---|
| `products` | Boutique clothes and cafe menu items: shop, name, description, category, price, image, own discount |
| `variants` | Colours (boutique) or options (cafe) for a product, each with its stock |
| `shop_settings` | One row per shop with the store-wide "all products" discount |
| `orders` | Customer name, phone, delivery or pickup, address and GPS pin, totals, status, always COD |
| `order_items` | What was in each order, with the name and price copied at the time of ordering |

Money is stored in **sen** (RM × 100) as whole numbers, so RM 12.90 is `1290`. All tables have Row Level Security on with no public policies, so only the server can read or write them. Stock changes happen inside Postgres functions that lock the row, so two customers can't both buy the last item.

## Run it

Requires **Node.js 22.9 or newer**.

```bash
npm install
npm start
```

Then open http://localhost:3000. The server reads `.env` automatically.

For local development without Supabase, leave the Supabase values empty and set `DATABASE_URL` to any Postgres database where you have run the migrations. Images are then saved in `./uploads`.

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

- `server.js`: Express API and page routes. Checks the input, then calls the database functions.
- `db.js`: talks to Supabase (`supabase.rpc`) or plain Postgres (`DATABASE_URL`). Every query is a function in `supabase/migrations/`, so prices and stock are always worked out in the database.
- `storage.js`: saves product photos to the Supabase `product-images` bucket (or `./uploads` locally).
- `public/`: plain HTML, CSS and JavaScript. `customer.html` and `seller.html` serve both shops; the URL decides which shop is shown.
- Live updates use Server-Sent Events (`/api/:shop/stream`).

## Assumptions

- The spec described the cafe briefly, so the cafe mirrors the boutique: same discounts, stock, orders and sales audit, with "options" instead of colours.
- Income counts only orders marked **Completed**, meaning the cash has been collected.
- Stock is reserved when the order is placed and returned if the seller cancels.
- Customers do not need an account. Seller login is a simple password per shop and sessions reset when the server restarts.
