-- Functions the server calls (through supabase.rpc or plain SQL). Each one runs in a
-- single transaction, so stock can never go below zero even when two customers
-- order the last item at the same time.
--
-- Errors use custom codes the server turns into HTTP statuses:
--   CA400 bad input, CA404 not found, CA409 not enough stock.

-- ---------------------------------------------------------------- read
create or replace function public.get_products(p_shop public.shop_type)
returns jsonb language sql stable as $$
  with s as (select * from public.shop_settings where shop = p_shop)
  select jsonb_build_object(
    'storeDiscount', (select jsonb_build_object('discount_type', s.discount_type, 'discount_value', s.discount_value) from s),
    'products', coalesce((
      select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc, x.id desc)
      from (
        select p.id, p.shop, p.name, p.description, p.category, p.price_sen, p.image_url as image,
               p.discount_type, p.discount_value, p.created_at,
               public.effective_price_sen(p.price_sen, p.discount_type, p.discount_value, s.discount_type, s.discount_value) as final_price_sen,
               case
                 when p.discount_type is not null then jsonb_build_object('type', p.discount_type, 'value', p.discount_value, 'source', 'product')
                 when s.discount_type is not null then jsonb_build_object('type', s.discount_type, 'value', s.discount_value, 'source', 'store')
               end as applied_discount,
               coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'stock', v.stock) order by v.id)
                         from public.variants v where v.product_id = p.id and v.active), '[]'::jsonb) as variants,
               coalesce((select sum(v.stock) from public.variants v where v.product_id = p.id and v.active), 0)::int as total_stock
        from public.products p cross join s
        where p.shop = p_shop and p.active
      ) x
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- seller: products
-- Creates a product (p_id null) or updates one. p_variants is a JSON array of
-- {id?, name, stock}. Variants left out are hidden, not deleted, so old orders keep working.
-- p_image null keeps the current image.
create or replace function public.save_product(
  p_shop public.shop_type, p_id bigint, p_name text, p_description text, p_category text,
  p_price_sen integer, p_image text, p_discount_type public.discount_type, p_discount_value numeric,
  p_variants jsonb
) returns bigint language plpgsql as $$
declare
  v_id bigint := p_id;
  v jsonb;
  v_keep bigint[] := '{}';
  v_vid bigint;
begin
  if jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'Add at least one variant with its stock' using errcode = 'CA400';
  end if;

  if v_id is null then
    insert into public.products (shop, name, description, category, price_sen, image_url, discount_type, discount_value)
    values (p_shop, p_name, coalesce(p_description, ''), coalesce(p_category, ''), p_price_sen, p_image, p_discount_type, p_discount_value)
    returning id into v_id;
  else
    update public.products set name = p_name, description = coalesce(p_description, ''), category = coalesce(p_category, ''),
      price_sen = p_price_sen, image_url = coalesce(p_image, image_url),
      discount_type = p_discount_type, discount_value = p_discount_value
    where id = v_id and shop = p_shop;
    if not found then raise exception 'Product not found' using errcode = 'CA404'; end if;
  end if;

  for v in select * from jsonb_array_elements(p_variants) loop
    v_vid := nullif(v->>'id', '')::bigint;
    if v_vid is not null then
      update public.variants set name = v->>'name', stock = (v->>'stock')::int, active = true
      where id = v_vid and product_id = v_id;
      if not found then v_vid := null; end if;
    end if;
    if v_vid is null then
      insert into public.variants (product_id, name, stock) values (v_id, v->>'name', (v->>'stock')::int) returning id into v_vid;
    end if;
    v_keep := v_keep || v_vid;
  end loop;

  update public.variants set active = false where product_id = v_id and not (id = any (v_keep));
  return v_id;
end $$;

create or replace function public.remove_product(p_shop public.shop_type, p_id bigint)
returns void language sql as $$
  update public.products set active = false where id = p_id and shop = p_shop
$$;

create or replace function public.set_store_discount(
  p_shop public.shop_type, p_discount_type public.discount_type, p_discount_value numeric, p_override_individual boolean
) returns jsonb language plpgsql as $$
begin
  update public.shop_settings set discount_type = p_discount_type, discount_value = p_discount_value where shop = p_shop;
  if p_override_individual then
    update public.products set discount_type = null, discount_value = null where shop = p_shop;
  end if;
  return (select jsonb_build_object('discount_type', discount_type, 'discount_value', discount_value)
          from public.shop_settings where shop = p_shop);
end $$;

-- ---------------------------------------------------------------- customer: place order
-- p_items is a JSON array of {variant_id, qty}. Prices are worked out here, never trusted from the browser.
create or replace function public.place_order(
  p_shop public.shop_type, p_customer_name text, p_phone text, p_method public.order_method,
  p_address text, p_lat double precision, p_lng double precision, p_notes text, p_items jsonb
) returns jsonb language plpgsql as $$
declare
  s public.shop_settings;
  it jsonb;
  r record;
  v_qty int;
  v_price int;
  v_subtotal int := 0;
  v_total int := 0;
  v_order_id bigint;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty' using errcode = 'CA400';
  end if;
  select * into s from public.shop_settings where shop = p_shop;

  insert into public.orders (shop, customer_name, phone, method, address, lat, lng, notes, subtotal_sen, discount_sen, total_sen)
  values (p_shop, p_customer_name, p_phone, p_method,
          case when p_method = 'delivery' then p_address end,
          case when p_method = 'delivery' then p_lat end,
          case when p_method = 'delivery' then p_lng end,
          nullif(trim(coalesce(p_notes, '')), ''), 0, 0, 0)
  returning id into v_order_id;

  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::int;
    if v_qty is null or v_qty <= 0 then raise exception 'Invalid quantity' using errcode = 'CA400'; end if;

    -- Lock the variant row so two orders cannot take the same stock.
    select v.id as variant_id, v.name as variant_name, v.stock, p.id as product_id, p.name, p.price_sen,
           p.discount_type, p.discount_value
      into r
      from public.variants v join public.products p on p.id = v.product_id
     where v.id = (it->>'variant_id')::bigint and p.shop = p_shop and p.active and v.active
       for update of v;
    if not found then raise exception 'An item in your cart is no longer available' using errcode = 'CA400'; end if;
    if r.stock < v_qty then
      raise exception 'Only % left of % (%)', r.stock, r.name, r.variant_name using errcode = 'CA409';
    end if;

    v_price := public.effective_price_sen(r.price_sen, r.discount_type, r.discount_value, s.discount_type, s.discount_value);
    v_subtotal := v_subtotal + r.price_sen * v_qty;
    v_total := v_total + v_price * v_qty;

    insert into public.order_items (order_id, product_id, variant_id, product_name, variant_name, qty, original_price_sen, unit_price_sen)
    values (v_order_id, r.product_id, r.variant_id, r.name, r.variant_name, v_qty, r.price_sen, v_price);
    update public.variants set stock = stock - v_qty where id = r.variant_id;
  end loop;

  update public.orders set subtotal_sen = v_subtotal, total_sen = v_total, discount_sen = v_subtotal - v_total
  where id = v_order_id;
  return jsonb_build_object('id', v_order_id, 'total_sen', v_total);
end $$;

-- ---------------------------------------------------------------- seller: orders
create or replace function public.list_orders(p_shop public.shop_type, p_status public.order_status default null)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.id desc), '[]'::jsonb)
  from (
    select o.*,
      coalesce((select jsonb_agg(row_to_json(i)::jsonb order by i.id) from public.order_items i where i.order_id = o.id), '[]'::jsonb) as items
    from public.orders o
    where o.shop = p_shop and (p_status is null or o.status = p_status)
  ) x
$$;

-- pending -> confirmed -> completed, and pending/confirmed -> cancelled (stock is returned).
create or replace function public.update_order_status(p_shop public.shop_type, p_id bigint, p_status public.order_status)
returns void language plpgsql as $$
declare
  v_current public.order_status;
begin
  select status into v_current from public.orders where id = p_id and shop = p_shop for update;
  if not found then raise exception 'Order not found' using errcode = 'CA404'; end if;
  if not (
    (v_current = 'pending' and p_status in ('confirmed', 'cancelled')) or
    (v_current = 'confirmed' and p_status in ('completed', 'cancelled'))
  ) then
    raise exception 'Cannot change a % order to %', v_current, p_status using errcode = 'CA400';
  end if;

  update public.orders set status = p_status where id = p_id;
  if p_status = 'cancelled' then
    update public.variants v set stock = v.stock + i.qty
      from (select variant_id, sum(qty) as qty from public.order_items where order_id = p_id group by variant_id) i
     where v.id = i.variant_id;
  end if;
end $$;

-- ---------------------------------------------------------------- seller: sales audit
-- Income counts completed orders (cash collected). Dates are in Malaysia time.
create or replace function public.sales_report(p_shop public.shop_type, p_from date default null, p_to date default null)
returns jsonb language sql stable as $$
  with o as (
    select *, (created_at at time zone 'Asia/Kuala_Lumpur')::date as day
    from public.orders
    where shop = p_shop
      and (p_from is null or (created_at at time zone 'Asia/Kuala_Lumpur')::date >= p_from)
      and (p_to   is null or (created_at at time zone 'Asia/Kuala_Lumpur')::date <= p_to)
  )
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'income_sen',         coalesce(sum(total_sen) filter (where status = 'completed'), 0),
        'expected_sen',       coalesce(sum(total_sen) filter (where status in ('pending', 'confirmed')), 0),
        'discount_given_sen', coalesce(sum(discount_sen) filter (where status = 'completed'), 0),
        'completed_orders',   count(*) filter (where status = 'completed'),
        'open_orders',        count(*) filter (where status in ('pending', 'confirmed')),
        'cancelled_orders',   count(*) filter (where status = 'cancelled')) from o),
    'items', coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.revenue_sen desc) from (
        select i.product_name, i.variant_name, sum(i.qty)::int as qty, sum(i.qty * i.unit_price_sen)::int as revenue_sen
        from public.order_items i join o on o.id = i.order_id
        where o.status = 'completed'
        group by i.product_id, i.variant_id, i.product_name, i.variant_name) t), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(row_to_json(d)::jsonb order by d.day desc) from (
        select day, sum(total_sen)::int as income_sen, count(*)::int as orders
        from o where status = 'completed' group by day) d), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- permissions
-- Only the server may call these. Browsers using the public anon key cannot.
do $$
declare f text;
begin
  foreach f in array array[
    'get_products(public.shop_type)',
    'save_product(public.shop_type, bigint, text, text, text, integer, text, public.discount_type, numeric, jsonb)',
    'remove_product(public.shop_type, bigint)',
    'set_store_discount(public.shop_type, public.discount_type, numeric, boolean)',
    'place_order(public.shop_type, text, text, public.order_method, text, double precision, double precision, text, jsonb)',
    'list_orders(public.shop_type, public.order_status)',
    'update_order_status(public.shop_type, bigint, public.order_status)',
    'sales_report(public.shop_type, date, date)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end $$;
