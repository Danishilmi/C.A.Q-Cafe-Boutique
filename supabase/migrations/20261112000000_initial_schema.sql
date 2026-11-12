-- C.A.Q Cafe & Boutique: initial database schema for Supabase (Postgres).
-- Run this once in the Supabase SQL Editor, or with `supabase db push`.
--
-- Money is stored as whole sen (RM x 100) in integer columns, so RM 12.90 is 1290.
-- All tables have Row Level Security turned on with no public policies: only the
-- server (using the service_role key or the database password) can read or write.

-- ---------------------------------------------------------------- types
create type public.shop_type as enum ('boutique', 'cafe');
create type public.discount_type as enum ('rm', 'percent');
create type public.order_method as enum ('delivery', 'pickup');
create type public.order_status as enum ('pending', 'confirmed', 'completed', 'cancelled');

-- ---------------------------------------------------------------- tables
create table public.products (
  id              bigint generated always as identity primary key,
  shop            public.shop_type not null,
  name            text not null check (length(trim(name)) > 0),
  description     text not null default '',
  category        text not null default '',
  price_sen       integer not null check (price_sen >= 0),
  image_url       text,
  discount_type   public.discount_type,
  discount_value  numeric(10,2),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint products_discount_pair check ((discount_type is null) = (discount_value is null)),
  constraint products_discount_value check (
    discount_value is null or (discount_value > 0 and (discount_type <> 'percent' or discount_value <= 100)))
);
comment on table public.products is 'Boutique clothes and cafe menu items.';
comment on column public.products.price_sen is 'Price in sen (RM x 100).';
comment on column public.products.discount_type is 'Discount for this product only. Overrides the store-wide discount in shop_settings.';
create index products_shop_active_idx on public.products (shop, active);

-- Colours for the boutique, options (Hot / Iced, Regular / Large) for the cafe. Each has its own stock.
create table public.variants (
  id          bigint generated always as identity primary key,
  product_id  bigint not null references public.products (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  stock       integer not null default 0 check (stock >= 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table public.variants is 'Colour variants (boutique) or options (cafe), each with its own stock count.';
create index variants_product_idx on public.variants (product_id);

-- One row per shop. Holds the store-wide ("all products") discount.
create table public.shop_settings (
  shop            public.shop_type primary key,
  discount_type   public.discount_type,
  discount_value  numeric(10,2),
  updated_at      timestamptz not null default now(),
  constraint settings_discount_pair check ((discount_type is null) = (discount_value is null)),
  constraint settings_discount_value check (
    discount_value is null or (discount_value > 0 and (discount_type <> 'percent' or discount_value <= 100)))
);
insert into public.shop_settings (shop) values ('boutique'), ('cafe');

create table public.orders (
  id             bigint generated always as identity primary key,
  shop           public.shop_type not null,
  customer_name  text not null,
  phone          text not null,
  method         public.order_method not null,
  address        text,
  lat            double precision,
  lng            double precision,
  notes          text,
  subtotal_sen   integer not null check (subtotal_sen >= 0),
  discount_sen   integer not null check (discount_sen >= 0),
  total_sen      integer not null check (total_sen >= 0),
  payment        text not null default 'COD' check (payment = 'COD'),
  status         public.order_status not null default 'pending',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint orders_delivery_address check (method = 'pickup' or length(trim(coalesce(address, ''))) > 0)
);
comment on column public.orders.payment is 'Cash on Delivery is the only payment method.';
create index orders_shop_status_idx on public.orders (shop, status, created_at desc);

-- Product name, variant name and prices are copied in so old orders stay correct after edits.
create table public.order_items (
  id                  bigint generated always as identity primary key,
  order_id            bigint not null references public.orders (id) on delete cascade,
  product_id          bigint not null references public.products (id),
  variant_id          bigint not null references public.variants (id),
  product_name        text not null,
  variant_name        text not null,
  qty                 integer not null check (qty > 0),
  original_price_sen  integer not null,
  unit_price_sen      integer not null
);
create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------- security
alter table public.products      enable row level security;
alter table public.variants      enable row level security;
alter table public.shop_settings enable row level security;
alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;

-- ---------------------------------------------------------------- helpers
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.shop_settings for each row execute function public.touch_updated_at();

-- Price after discount. A product's own discount wins over the store-wide one.
create or replace function public.effective_price_sen(
  p_price_sen integer,
  p_type public.discount_type, p_value numeric,
  s_type public.discount_type, s_value numeric
) returns integer
language sql immutable as $$
  select greatest(0, p_price_sen - case
    when p_type = 'percent' then round(p_price_sen * p_value / 100)
    when p_type = 'rm'      then round(p_value * 100)
    when s_type = 'percent' then round(p_price_sen * s_value / 100)
    when s_type = 'rm'      then round(s_value * 100)
    else 0 end)::integer
$$;
