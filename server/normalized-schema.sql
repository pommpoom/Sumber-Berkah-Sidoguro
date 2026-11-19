-- REVIEW ONLY. NOT APPLIED. Run as database owner in a controlled migration.
BEGIN;
CREATE SCHEMA IF NOT EXISTS cashier;
REVOKE ALL ON SCHEMA cashier FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA cashier TO service_role;
GRANT SELECT ON public.app_users TO service_role;

CREATE TABLE cashier.control (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  mode text NOT NULL DEFAULT 'legacy' CHECK(mode IN ('legacy','normalized-read','normalized')),
  source_hash text, source_version bigint, migration_review jsonb NOT NULL DEFAULT '{}', revision bigint NOT NULL DEFAULT 0,
  invoice_counter bigint NOT NULL DEFAULT -1,
  config jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cashier.control(id) VALUES(true);
CREATE TABLE cashier.products (
  id text PRIMARY KEY, name text NOT NULL, stock numeric NOT NULL,
  cost_price numeric CHECK(cost_price>=0), track_stock boolean NOT NULL,
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(stock::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE TABLE cashier.customers (id text PRIMARY KEY, name text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cashier.suppliers (LIKE cashier.customers INCLUDING ALL);
CREATE TABLE cashier.transactions (
  id text PRIMARY KEY, invoice text NOT NULL UNIQUE, business_date date, occurred_at text,
  cashier text, customer text, payment_method text, subtotal numeric, discount_amount numeric,
  discount_percent numeric, discount_method text, tax_percent numeric, tax_amount numeric,
  total numeric NOT NULL CHECK(total>=0), revision bigint NOT NULL DEFAULT 1,
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(total::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE TABLE cashier.transaction_items (
  transaction_id text NOT NULL REFERENCES cashier.transactions(id), line_no integer NOT NULL CHECK(line_no>0),
  product_id text REFERENCES cashier.products(id), legacy_product_id text,
  name text, unit text, qty numeric NOT NULL CHECK(qty>0), price numeric NOT NULL CHECK(price>=0),
  discount numeric NOT NULL CHECK(discount>=0), cost_price numeric,
  amount numeric NOT NULL, profit numeric, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(transaction_id,line_no)
);
CREATE TABLE cashier.transaction_payments (
  transaction_id text NOT NULL REFERENCES cashier.transactions(id), id text NOT NULL,
  initial boolean NOT NULL DEFAULT false, amount numeric NOT NULL CHECK(amount>=0), dashboard_amount numeric,
  business_date date, method text, cashier text, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(transaction_id,id)
);
CREATE UNIQUE INDEX payments_one_initial ON cashier.transaction_payments(transaction_id) WHERE initial;
CREATE TABLE cashier.incoming_stock (
  id text PRIMARY KEY, product_id text REFERENCES cashier.products(id), qty numeric NOT NULL CHECK(qty>0),
  purchase_price numeric NOT NULL CHECK(purchase_price>=0), total numeric NOT NULL,
  business_date date, supplier text, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cashier.stocktakes (
  id text PRIMARY KEY, product_id text REFERENCES cashier.products(id), system_stock numeric NOT NULL,
  physical_stock numeric NOT NULL CHECK(physical_stock>=0), difference numeric NOT NULL,
  business_date date, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cashier.quantity_edits (
  id text PRIMARY KEY, transaction_id text NOT NULL REFERENCES cashier.transactions(id),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cashier.operations (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 150), actor text NOT NULL,
  kind text NOT NULL, request jsonb NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_history ON cashier.transactions(business_date DESC, occurred_at DESC, id DESC);
CREATE INDEX transactions_method_date ON cashier.transactions(payment_method,business_date DESC);
CREATE INDEX transactions_customer ON cashier.transactions(customer);
CREATE INDEX items_product ON cashier.transaction_items(product_id);
CREATE INDEX payments_date ON cashier.transaction_payments(business_date);
CREATE INDEX incoming_history ON cashier.incoming_stock(business_date DESC,id DESC);
CREATE INDEX incoming_product ON cashier.incoming_stock(product_id);
CREATE INDEX stocktakes_history ON cashier.stocktakes(business_date DESC,id DESC);
CREATE INDEX stocktakes_product ON cashier.stocktakes(product_id);
CREATE INDEX edits_transaction ON cashier.quantity_edits(transaction_id);

-- Reconstruct only the requested record; unknown historical fields remain intact.
CREATE FUNCTION cashier.transaction_json(p_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT t.data || jsonb_build_object('id',t.id,'invoice',t.invoice,'revision',t.revision,
 'businessDate',t.business_date,'subtotal',t.subtotal,'discountAmount',t.discount_amount,'discountPercent',t.discount_percent,
 'taxAmount',t.tax_amount,'total',t.total,
 'remaining',greatest(0,t.total-p.received),'refundDue',greatest(0,p.received-t.total),
 'paymentStatus',CASE WHEN t.total>p.received THEN 'BELUM LUNAS' ELSE 'LUNAS' END,
 'cashIn',p.initial_amount,'downPayment',CASE WHEN t.payment_method='DP' THEN p.initial_amount ELSE 0 END,
 'items',coalesce((SELECT jsonb_agg(i.data || jsonb_build_object('qty',i.qty,'price',i.price,
 'discount',i.discount,'costPrice',i.cost_price,'amount',i.amount,'profit',i.profit) ORDER BY i.line_no)
 FROM cashier.transaction_items i WHERE i.transaction_id=t.id),'[]'),
 'quantityEdits',coalesce((SELECT jsonb_agg(e.data ORDER BY e.created_at,e.id) FROM cashier.quantity_edits e WHERE e.transaction_id=t.id),'[]'),
 -- Request decimals may be strings; the validated NUMERIC column owns response money.
 'paymentHistory',coalesce((SELECT jsonb_agg(x.data||jsonb_build_object('date',x.business_date,'amount',x.amount) ORDER BY x.business_date,x.id) FROM cashier.transaction_payments x WHERE x.transaction_id=t.id AND NOT x.initial),'[]'))
 FROM cashier.transactions t CROSS JOIN LATERAL
 (SELECT coalesce(sum(amount),0) received,coalesce(sum(amount) FILTER(WHERE initial),0) initial_amount
 FROM cashier.transaction_payments WHERE transaction_id=t.id) p WHERE t.id=p_id;
$$;

-- Strict decimal input: no NaN, infinity, exponent, negative or silently rounded values.
CREATE FUNCTION cashier.number(j jsonb,k text, fallback numeric DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE s text:=j->>k; n numeric;
BEGIN
 IF s IS NULL THEN IF fallback IS NULL THEN RAISE EXCEPTION 'Missing number: %',k USING ERRCODE='22023'; END IF; RETURN fallback; END IF;
 IF s !~ '^[0-9]+(\.[0-9]+)?$' OR length(s)>40 THEN RAISE EXCEPTION 'Invalid number: %',k USING ERRCODE='22023'; END IF;
 n:=s::numeric; IF n>1000000000000000 THEN RAISE EXCEPTION 'Number too large' USING ERRCODE='22023'; END IF; RETURN n;
END $$;

-- JSON dates are date-only business days; never accept PostgreSQL's permissive date parser alone.
CREATE FUNCTION cashier.business_day(at_time timestamptz) RETURNS date
LANGUAGE sql STABLE SET search_path='' AS $$ SELECT (at_time AT TIME ZONE 'Asia/Jakarta')::date $$;
CREATE FUNCTION cashier.business_date(value text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'Date must be YYYY-MM-DD' USING ERRCODE='22023'; END IF;
 RETURN value::date;
END $$;
CREATE FUNCTION cashier.required_text(j jsonb,k text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF jsonb_typeof(j->k) IS DISTINCT FROM 'string' OR length(trim(j->>k))=0 THEN RAISE EXCEPTION 'Required string: %',k USING ERRCODE='22023'; END IF;
 RETURN j->>k;
END $$;
CREATE FUNCTION cashier.validate_config(j jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(j->'settings') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid configuration object' USING ERRCODE='22023'; END IF;
 FOREACH k IN ARRAY ARRAY['categories','units','paymentMethods'] LOOP
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid configuration array: %',k USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(j->k) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(trim(x#>>'{}'))=0) THEN RAISE EXCEPTION 'Invalid configuration entry' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF j#>>'{settings,discountMethod}' IS NULL OR j#>>'{settings,discountMethod}' NOT IN ('Nominal','Persen') THEN RAISE EXCEPTION 'Invalid discount method' USING ERRCODE='22023'; END IF;
 PERFORM cashier.number(j->'settings','taxPercent');
END $$;

CREATE FUNCTION cashier.redact_financial(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE jsonb_typeof(j)
 WHEN 'object' THEN (SELECT coalesce(jsonb_object_agg(key,cashier.redact_financial(value)),'{}') FROM jsonb_each(j) WHERE key !~* '(cost.?price|profit)' AND key<>'lastBackupAt')
 WHEN 'array' THEN (SELECT coalesce(jsonb_agg(cashier.redact_financial(value) ORDER BY ord),'[]') FROM jsonb_array_elements(j) WITH ORDINALITY a(value,ord))
 ELSE j END;
$$;

CREATE FUNCTION public.cashier_command(p_kind text,p_body jsonb,p_operation text,p_actor text,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE op cashier.operations; u public.app_users; p cashier.products; t cashier.transactions;
 b jsonb:=p_body; item jsonb; result jsonb; rowdata jsonb; quantities jsonb; before_qty jsonb;
 v_id text; v_invoice text; v_line integer:=0; v_qty numeric; v_price numeric; v_discount numeric;
 v_sale_subtotal numeric:=0; v_sale_discount_amount numeric; v_sale_discount_percent numeric; tax numeric; v_sale_total numeric;
 v_updated_subtotal numeric; v_updated_discount_amount numeric;
 received numeric; paid numeric; delta numeric; cost numeric; previous numeric; counter bigint;
 v_config jsonb; dbmode text;
BEGIN
 SELECT * INTO u FROM public.app_users WHERE id::text=p_actor AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Inactive actor' USING ERRCODE='42501'; END IF;
 IF p_kind NOT IN ('sale','payment') AND u.role<>'ADMINISTRATOR' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 SELECT mode,c.config INTO dbmode,v_config FROM cashier.control c WHERE id=true FOR UPDATE;
 IF dbmode<>'normalized' OR p_mode IS DISTINCT FROM dbmode THEN RAISE EXCEPTION 'Persistence is read-only or mode changed' USING ERRCODE='55000'; END IF;
 IF (SELECT source_hash FROM cashier.control WHERE id=true) IS NULL THEN RAISE EXCEPTION 'Migration not verified' USING ERRCODE='55000'; END IF;
 IF p_operation IS NULL OR p_operation !~ '^[A-Za-z0-9_-]{8,150}$' OR jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid operation' USING ERRCODE='22023'; END IF;
 -- Unique insertion waits for the first identical operation to commit or roll back.
 INSERT INTO cashier.operations(id,actor,kind,request) VALUES(p_operation,p_actor,p_kind,b) ON CONFLICT DO NOTHING;
 SELECT * INTO op FROM cashier.operations WHERE id=p_operation FOR UPDATE;
 IF op.actor<>p_actor OR op.kind<>p_kind OR op.request<>b THEN RAISE EXCEPTION 'Idempotency key reused with different request' USING ERRCODE='23505'; END IF;
 IF op.response IS NOT NULL THEN RETURN op.response; END IF;
 IF p_kind IN ('sale','payment') THEN PERFORM cashier.validate_config(v_config); END IF;
 IF p_kind IN ('payment','quantity') THEN PERFORM cashier.required_text(b,'id'); END IF;
 IF p_kind IN ('payment','incoming','stocktake') THEN PERFORM cashier.business_date(b->>'date'); END IF;
 IF p_kind IN ('incoming','stocktake') THEN PERFORM cashier.required_text(b,'productId'); END IF;
 IF p_kind='incoming' THEN PERFORM cashier.required_text(b,'supplier'); END IF;

 IF p_kind='sale' THEN
  IF jsonb_typeof(b->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid items array' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(b->'items') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid items count' USING ERRCODE='22023'; END IF;
  PERFORM cashier.required_text(b,'paymentMethod');
  -- Stable lock ordering also covers repeated product lines.
  PERFORM 1 FROM cashier.products WHERE id IN (SELECT x->>'productId' FROM jsonb_array_elements(b->'items') x) ORDER BY id FOR UPDATE;
  v_id:=p_operation;
  FOR item IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid item object' USING ERRCODE='22023'; END IF;
   PERFORM cashier.required_text(item,'productId');
   v_qty:=cashier.number(item,'qty'); v_price:=cashier.number(item,'price'); v_discount:=cashier.number(item,'discount',0);
   IF v_qty<=0 OR v_discount>v_price THEN RAISE EXCEPTION 'Invalid quantity/discount' USING ERRCODE='22023'; END IF;
   SELECT * INTO p FROM cashier.products WHERE id=item->>'productId';
   IF NOT FOUND OR NOT coalesce((p.data->>'active')::boolean,false) THEN RAISE EXCEPTION 'Unknown/inactive product' USING ERRCODE='22023'; END IF;
   IF p.cost_price IS NULL THEN RAISE EXCEPTION 'Product cost needs review' USING ERRCODE='22023'; END IF;
   IF p.track_stock AND p.stock<v_qty THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='22023'; END IF;
   IF p.track_stock THEN UPDATE cashier.products SET stock=stock-v_qty,updated_at=now() WHERE id=p.id; END IF;
   v_sale_subtotal:=v_sale_subtotal+(v_price-v_discount)*v_qty;
  END LOOP;
  v_sale_discount_percent:=CASE WHEN v_config#>>'{settings,discountMethod}'='Persen' THEN least(100,cashier.number(b,'discount',0)) ELSE 0 END;
  v_sale_discount_amount:=least(v_sale_subtotal,CASE WHEN v_config#>>'{settings,discountMethod}'='Persen' THEN v_sale_subtotal*v_sale_discount_percent/100 ELSE cashier.number(b,'discount',0) END);
  IF v_sale_subtotal>0 THEN v_sale_discount_percent:=v_sale_discount_amount/v_sale_subtotal*100; END IF;
  tax:=cashier.number(coalesce(v_config->'settings','{}'),'taxPercent',0);
  v_sale_total:=(v_sale_subtotal-v_sale_discount_amount)*(1+tax/100);
  IF NOT coalesce(v_config->'paymentMethods','[]') ? (b->>'paymentMethod') THEN RAISE EXCEPTION 'Invalid payment method' USING ERRCODE='22023'; END IF;
  paid:=cashier.number(b,'payment',0);
  IF b->>'paymentMethod'='DP' THEN
   IF paid<=0 OR paid>v_sale_total THEN RAISE EXCEPTION 'Invalid DP' USING ERRCODE='22023'; END IF; received:=paid;
  ELSIF b->>'paymentMethod'='Tunai' THEN
   IF paid<v_sale_total THEN RAISE EXCEPTION 'Insufficient cash' USING ERRCODE='22023'; END IF; received:=v_sale_total;
  ELSE paid:=v_sale_total;received:=v_sale_total; END IF;
  LOOP
   UPDATE cashier.control SET invoice_counter=invoice_counter+1 WHERE id=true RETURNING invoice_counter INTO counter;
   v_invoice:=counter::text;
   EXIT WHEN NOT EXISTS(SELECT 1 FROM cashier.transactions WHERE invoice=v_invoice);
  END LOOP;
  rowdata:=jsonb_build_object('id',v_id,'invoice',v_invoice,'createdAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'cashier',u.username,'customer',coalesce(b->>'customer','UMUM'),'courier',coalesce(b->>'courier',''),
   'paymentMethod',b->>'paymentMethod','payment',paid,'change',greatest(0,paid-received),
   'discountMethod',v_config#>>'{settings,discountMethod}','taxPercent',tax,'saveOperationId',p_operation);
  INSERT INTO cashier.transactions(id,invoice,business_date,occurred_at,cashier,customer,payment_method,subtotal,discount_amount,discount_percent,discount_method,tax_percent,tax_amount,total,data)
  VALUES(v_id,v_invoice,cashier.business_day(now()),rowdata->>'createdAt',u.username,rowdata->>'customer',b->>'paymentMethod',v_sale_subtotal,v_sale_discount_amount,v_sale_discount_percent,v_config#>>'{settings,discountMethod}',tax,(v_sale_subtotal-v_sale_discount_amount)*tax/100,v_sale_total,rowdata);
  FOR item IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
   v_line:=v_line+1; SELECT * INTO p FROM cashier.products WHERE id=item->>'productId';
   v_qty:=cashier.number(item,'qty');v_price:=cashier.number(item,'price');v_discount:=cashier.number(item,'discount',0);
   rowdata:=item||jsonb_build_object('productId',p.id,'name',p.name,'unit',p.data->>'unit','lineId',v_id||'-'||v_line);
   INSERT INTO cashier.transaction_items(transaction_id,line_no,product_id,name,unit,qty,price,discount,cost_price,amount,profit,data)
   VALUES(v_id,v_line,p.id,p.name,p.data->>'unit',v_qty,v_price,v_discount,p.cost_price,(v_price-v_discount)*v_qty,(v_price-v_discount-p.cost_price)*v_qty,rowdata);
  END LOOP;
  INSERT INTO cashier.transaction_payments(transaction_id,id,initial,amount,business_date,method,cashier,data)
  VALUES(v_id,p_operation,true,received,cashier.business_day(now()),b->>'paymentMethod',u.username,'{}');
  result:=jsonb_build_object('transaction',cashier.transaction_json(v_id));
 ELSIF p_kind IN ('payment','quantity') THEN
  SELECT * INTO t FROM cashier.transactions WHERE id=b->>'id' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='22023'; END IF;
  IF p_kind='payment' THEN
   PERFORM cashier.required_text(b,'method');
   SELECT coalesce(sum(amount),0) INTO received FROM cashier.transaction_payments WHERE transaction_id=t.id;
   paid:=cashier.number(b,'amount');
   IF paid<=0 OR paid>t.total-received THEN RAISE EXCEPTION 'Payment exceeds remaining balance' USING ERRCODE='22023'; END IF;
   IF b->>'method'='DP' OR NOT coalesce(v_config->'paymentMethods','[]') ? (b->>'method') OR b->>'date' IS NULL THEN RAISE EXCEPTION 'Invalid settlement' USING ERRCODE='22023'; END IF;
   rowdata:=b||jsonb_build_object('id',p_operation,'cashier',u.username,'createdAt',now());
   INSERT INTO cashier.transaction_payments(transaction_id,id,amount,business_date,method,cashier,data)
   VALUES(t.id,p_operation,paid,(b->>'date')::date,b->>'method',u.username,rowdata);
  ELSE
   IF (b->>'revision')::bigint IS DISTINCT FROM t.revision THEN RAISE EXCEPTION 'Transaction changed; reload before editing' USING ERRCODE='40001'; END IF;
   quantities:=b->'quantities';
   IF jsonb_typeof(quantities) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid quantities array' USING ERRCODE='22023'; END IF;
   IF jsonb_array_length(quantities)<>(SELECT count(*) FROM cashier.transaction_items WHERE transaction_id=t.id) THEN RAISE EXCEPTION 'Invalid quantities count' USING ERRCODE='22023'; END IF;
   IF EXISTS(SELECT 1 FROM cashier.transaction_items WHERE transaction_id=t.id AND product_id IS NULL) THEN RAISE EXCEPTION 'Historical product requires reconciliation' USING ERRCODE='22023'; END IF;
   PERFORM 1 FROM cashier.products WHERE id IN(SELECT product_id FROM cashier.transaction_items WHERE transaction_id=t.id) ORDER BY id FOR UPDATE;
   SELECT jsonb_agg(qty ORDER BY line_no) INTO before_qty FROM cashier.transaction_items WHERE transaction_id=t.id;
   FOR item IN SELECT to_jsonb(i) FROM cashier.transaction_items i WHERE transaction_id=t.id ORDER BY line_no LOOP
    v_line:=(item->>'line_no')::int;v_qty:=cashier.number(jsonb_build_object('qty',quantities->(v_line-1)),'qty');
    IF v_qty<=0 THEN RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE='22023'; END IF;
   END LOOP;
   -- Aggregate deltas before checking stock: same product can occur on multiple lines.
   FOR p IN SELECT * FROM cashier.products WHERE id IN(SELECT product_id FROM cashier.transaction_items WHERE transaction_id=t.id) ORDER BY id LOOP
    SELECT sum((quantities->>(line_no-1))::numeric-qty) INTO delta FROM cashier.transaction_items WHERE transaction_id=t.id AND product_id=p.id;
    IF p.track_stock AND p.stock-delta<0 THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='22023'; END IF;
    IF p.track_stock THEN UPDATE cashier.products SET stock=stock-delta,updated_at=now() WHERE id=p.id; END IF;
   END LOOP;
   UPDATE cashier.transaction_items SET qty=(quantities->>(line_no-1))::numeric,
    amount=greatest(0,price-discount)*(quantities->>(line_no-1))::numeric,
    profit=(price-discount-cost_price)*(quantities->>(line_no-1))::numeric,updated_at=now() WHERE transaction_id=t.id;
   SELECT sum(i.amount) INTO v_updated_subtotal FROM cashier.transaction_items i WHERE i.transaction_id=t.id;
   v_updated_discount_amount:=least(v_updated_subtotal,CASE WHEN t.discount_method='Persen' THEN v_updated_subtotal*t.discount_percent/100 ELSE t.discount_amount END);
   UPDATE cashier.transactions x SET subtotal=v_updated_subtotal,discount_amount=v_updated_discount_amount,
    discount_percent=CASE WHEN v_updated_subtotal>0 THEN v_updated_discount_amount/v_updated_subtotal*100 ELSE 0 END,
    tax_amount=(v_updated_subtotal-v_updated_discount_amount)*t.tax_percent/100,
    total=(v_updated_subtotal-v_updated_discount_amount)*(1+t.tax_percent/100) WHERE x.id=t.id;
   INSERT INTO cashier.quantity_edits(id,transaction_id,data) VALUES(p_operation,t.id,jsonb_build_object('id',p_operation,'at',now(),'by',u.username,'before',before_qty,'after',quantities));
  END IF;
  UPDATE cashier.transactions SET revision=revision+1,updated_at=now() WHERE id=t.id;
  result:=jsonb_build_object('transaction',cashier.transaction_json(t.id));
 ELSIF p_kind IN ('incoming','stocktake') THEN
  SELECT * INTO p FROM cashier.products WHERE id=b->>'productId' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found' USING ERRCODE='22023'; END IF;
  IF b->>'date' IS NULL THEN RAISE EXCEPTION 'Date required' USING ERRCODE='22023'; END IF;
  rowdata:=b||jsonb_build_object('id',p_operation,'product',p.name,'category',p.data->>'category','unit',p.data->>'unit','createdAt',now(),'cashier',u.username,'saveOperationId',p_operation);
  IF p_kind='incoming' THEN
   v_qty:=cashier.number(b,'qty');v_price:=cashier.number(b,'purchasePrice');
   IF v_qty<=0 OR p.cost_price IS NULL OR coalesce(b->>'supplier','')='' THEN RAISE EXCEPTION 'Invalid incoming/cost' USING ERRCODE='22023'; END IF;
   cost:=(greatest(0,p.stock)*p.cost_price+v_qty*v_price)/(greatest(0,p.stock)+v_qty);
   rowdata:=rowdata||jsonb_build_object('total',v_qty*v_price,'previousStock',p.stock,'previousCostPrice',p.cost_price,'resultingCostPrice',cost);
   INSERT INTO cashier.incoming_stock(id,product_id,qty,purchase_price,total,business_date,supplier,data) VALUES(p_operation,p.id,v_qty,v_price,v_qty*v_price,(b->>'date')::date,b->>'supplier',rowdata);
   UPDATE cashier.products SET stock=stock+v_qty,cost_price=cost,updated_at=now() WHERE id=p.id;
  ELSE
   v_qty:=cashier.number(b,'physicalStock');previous:=cashier.number(b,'expectedStock');
   IF previous<>p.stock THEN RAISE EXCEPTION 'Stock changed; count again' USING ERRCODE='40001'; END IF;
   rowdata:=rowdata||jsonb_build_object('systemStock',p.stock,'difference',v_qty-p.stock);
   INSERT INTO cashier.stocktakes(id,product_id,system_stock,physical_stock,difference,business_date,data) VALUES(p_operation,p.id,p.stock,v_qty,v_qty-p.stock,(b->>'date')::date,rowdata);
   UPDATE cashier.products SET stock=v_qty,updated_at=now() WHERE id=p.id;
  END IF;
  result:=jsonb_build_object('record',rowdata);
 ELSIF p_kind IN ('product','customer','supplier','config') THEN
  IF (b->>'revision')::bigint IS DISTINCT FROM (SELECT revision FROM cashier.control WHERE id=true) THEN RAISE EXCEPTION 'Data changed; reload before editing' USING ERRCODE='40001'; END IF;
  rowdata:=b->'data';
  IF jsonb_typeof(rowdata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid data' USING ERRCODE='22023'; END IF;
  IF p_kind='config' THEN
   PERFORM cashier.validate_config(rowdata);
   IF jsonb_typeof(rowdata->'settings') IS DISTINCT FROM 'object' OR jsonb_typeof(rowdata->'paymentMethods') IS DISTINCT FROM 'array' OR jsonb_typeof(rowdata->'categories') IS DISTINCT FROM 'array' OR jsonb_typeof(rowdata->'units') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid configuration' USING ERRCODE='22023'; END IF;
   PERFORM cashier.number(rowdata->'settings','taxPercent',0);
   UPDATE cashier.control SET config=rowdata WHERE id=true;
  ELSE
   PERFORM cashier.required_text(rowdata,'id');PERFORM cashier.required_text(rowdata,'name');
   IF coalesce(rowdata->>'id','')='' OR coalesce(rowdata->>'name','')='' THEN RAISE EXCEPTION 'ID and name required' USING ERRCODE='22023'; END IF;
   IF p_kind='product' THEN
    IF jsonb_typeof(rowdata->'trackStock') IS DISTINCT FROM 'boolean' OR jsonb_typeof(rowdata->'active') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Product booleans required' USING ERRCODE='22023'; END IF;
    SELECT * INTO p FROM cashier.products WHERE id=rowdata->>'id' FOR UPDATE;
    v_qty:=cashier.number(rowdata,'stock');cost:=cashier.number(rowdata,'costPrice');
    IF FOUND AND v_qty<>p.stock THEN RAISE EXCEPTION 'Use stocktake to change existing stock' USING ERRCODE='22023'; END IF;
    PERFORM cashier.number(rowdata,'retailPrice');PERFORM cashier.number(rowdata,'wholesalePrice');PERFORM cashier.number(rowdata,'discount',0);PERFORM cashier.number(rowdata,'minStock',0);
    INSERT INTO cashier.products(id,name,stock,cost_price,track_stock,data) VALUES(rowdata->>'id',rowdata->>'name',v_qty,cost,(rowdata->>'trackStock')::boolean,rowdata)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,cost_price=excluded.cost_price,track_stock=excluded.track_stock,data=excluded.data,updated_at=now();
   ELSIF p_kind='customer' THEN
    INSERT INTO cashier.customers(id,name,data) VALUES(rowdata->>'id',rowdata->>'name',rowdata) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=now();
   ELSE
    INSERT INTO cashier.suppliers(id,name,data) VALUES(rowdata->>'id',rowdata->>'name',rowdata) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=now();
   END IF;
  END IF;
  result:=jsonb_build_object('record',rowdata);
 ELSE RAISE EXCEPTION 'Unknown command' USING ERRCODE='22023';
 END IF;
 result:=result||jsonb_build_object('products',(SELECT coalesce(jsonb_agg(x.data||jsonb_build_object('stock',x.stock,'costPrice',x.cost_price)),'[]') FROM cashier.products x WHERE
 x.id=b->>'productId' OR x.id IN(SELECT i->>'productId' FROM jsonb_array_elements(coalesce(b->'items','[]')) i)
 OR x.id IN(SELECT product_id FROM cashier.transaction_items WHERE transaction_id=b->>'id')));
 UPDATE cashier.control SET revision=revision+1,updated_at=now() WHERE id=true;
 result:=result||jsonb_build_object('version',(SELECT revision FROM cashier.control WHERE id=true));
 UPDATE cashier.operations SET response=result WHERE id=p_operation;
 RETURN result;
END $$;

-- Fence old clients and old deployments at the database boundary during cutover.
CREATE FUNCTION cashier.fence_legacy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_mode text;
BEGIN
 -- Locking read follows the latest committed row at READ COMMITTED. A stale
 -- REPEATABLE READ save instead fails serialization; neither can bypass cutover.
 SELECT mode INTO current_mode FROM cashier.control WHERE id=true FOR SHARE;
 IF current_mode IS DISTINCT FROM 'legacy' THEN RAISE EXCEPTION 'Legacy persistence is frozen' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashier_legacy_fence BEFORE UPDATE ON public.app_state FOR EACH ROW EXECUTE FUNCTION cashier.fence_legacy();

-- Operator-only transition. NOT an HTTP RPC and never enables normalized writes.
-- Lock order matches legacy UPDATE: app_state table, then control row.
CREATE FUNCTION cashier.enter_normalized_read(p_source_version bigint,p_source_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE c cashier.control; live_version bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Cutover requires READ COMMITTED' USING ERRCODE='25000';
 END IF;
 LOCK TABLE public.app_state IN EXCLUSIVE MODE;
 SELECT * INTO c FROM cashier.control WHERE id=true FOR UPDATE;
 IF c.mode NOT IN ('legacy','normalized-read') OR c.mode IS NULL THEN RAISE EXCEPTION 'Invalid cutover phase' USING ERRCODE='55000'; END IF;
 IF c.source_version IS NULL OR c.source_hash IS NULL OR p_source_hash IS DISTINCT FROM c.source_hash OR p_source_version IS DISTINCT FROM c.source_version THEN
  RAISE EXCEPTION 'Imported source identity mismatch' USING ERRCODE='40001';
 END IF;
 SELECT version INTO live_version FROM public.app_state WHERE id=1;
 IF live_version IS DISTINCT FROM c.source_version THEN
  RAISE EXCEPTION 'Legacy source changed after import; cutover refused' USING ERRCODE='40001';
 END IF;
 IF c.mode='legacy' THEN
  UPDATE cashier.control SET mode='normalized-read',revision=revision+1,updated_at=now() WHERE id=true;
 END IF;
 RETURN jsonb_build_object('mode','normalized-read','sourceVersion',live_version,'sourceHash',c.source_hash);
END $$;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='cashier' LOOP
  EXECUTE format('ALTER TABLE cashier.%I ENABLE ROW LEVEL SECURITY',r.tablename);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA cashier FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cashier FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA cashier TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cashier TO service_role;
REVOKE ALL ON FUNCTION cashier.enter_normalized_read(bigint,text) FROM PUBLIC,anon,authenticated,service_role;
-- The application backend may update balances/configuration revisions, not migration phase.
REVOKE UPDATE ON cashier.control FROM service_role;
GRANT UPDATE (invoice_counter,revision,config,updated_at) ON cashier.control TO service_role;
REVOKE ALL ON FUNCTION public.cashier_command(text,jsonb,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cashier_command(text,jsonb,text,text,text) TO service_role;
COMMIT;
