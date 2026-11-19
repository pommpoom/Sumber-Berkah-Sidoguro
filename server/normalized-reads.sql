-- REVIEW ONLY. NOT APPLIED. Apply after normalized-schema.sql.
BEGIN;
CREATE FUNCTION public.cashier_read(p_kind text,p_query jsonb,p_actor text,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE c cashier.control; u public.app_users; result jsonb; rows jsonb; n bigint;
 page integer:=coalesce((p_query->>'page')::integer,1); lim integer:=coalesce((p_query->>'limit')::integer,20);
 day date;
BEGIN
 IF jsonb_typeof(p_query) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid query' USING ERRCODE='22023'; END IF;
 day:=CASE WHEN p_query ? 'date' THEN cashier.business_date(p_query->>'date') ELSE cashier.business_day(now()) END;
 SELECT * INTO u FROM public.app_users WHERE id::text=p_actor AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Inactive actor' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM cashier.control WHERE id=true;
 -- STABLE uses the caller's statement snapshot for this check and every subsequent SELECT.
 IF p_query ? 'expectedRevision' THEN
  IF coalesce(p_query->>'expectedRevision','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Invalid expected revision' USING ERRCODE='22023'; END IF;
  IF (p_query->>'expectedRevision')::bigint IS DISTINCT FROM c.revision THEN RAISE EXCEPTION 'Read revision changed' USING ERRCODE='40001'; END IF;
 END IF;
 IF c.mode='legacy' OR c.mode IS DISTINCT FROM p_mode OR c.source_hash IS NULL THEN RAISE EXCEPTION 'Migration not verified or mode mismatch' USING ERRCODE='55000'; END IF;
 IF page<1 OR page>1000000 OR lim<1 OR lim>100 THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023'; END IF;
 IF p_kind IN ('incoming','stocktakes','suppliers') AND u.role<>'ADMINISTRATOR' THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501'; END IF;
 IF p_kind='version' THEN RETURN jsonb_build_object('version',c.revision); END IF;
 IF p_kind IN ('bootstrap','products','customers','suppliers') THEN
  -- Collections are appropriate for the present small catalogue. Fail visibly if it outgrows this contract.
  IF (SELECT count(*) FROM cashier.products)>10000 OR (SELECT count(*) FROM cashier.customers)>10000 OR (SELECT count(*) FROM cashier.suppliers)>10000 THEN RAISE EXCEPTION 'Catalogue requires paginated client' USING ERRCODE='54000'; END IF;
  SELECT coalesce(jsonb_agg(data||jsonb_build_object('stock',stock,'costPrice',cost_price) ORDER BY name,id),'[]') INTO rows FROM cashier.products;
  result:=c.config||jsonb_build_object('products',rows,'customers',(SELECT coalesce(jsonb_agg(data ORDER BY name,id),'[]') FROM cashier.customers),
   'suppliers',CASE WHEN u.role='ADMINISTRATOR' THEN (SELECT coalesce(jsonb_agg(data ORDER BY name,id),'[]') FROM cashier.suppliers) ELSE '[]'::jsonb END,
   'transactions','[]'::jsonb,'incoming','[]'::jsonb,'stocktakes','[]'::jsonb);
  IF p_kind='bootstrap' THEN RETURN jsonb_build_object('state',result,'version',c.revision,'mode',c.mode); END IF;
  RETURN result->p_kind;
 ELSIF p_kind='transaction' THEN
  result:=cashier.transaction_json(coalesce(p_query->>'id',(SELECT id FROM cashier.transactions WHERE invoice=p_query->>'invoice')));
  IF result IS NULL THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='22023'; END IF;
  RETURN result;
 ELSIF p_kind='transactions' THEN
  SELECT count(*) INTO n FROM cashier.transactions t WHERE
   (coalesce(p_query->>'search','')='' OR strpos(lower(t.invoice||' '||coalesce(t.customer,'')),lower(p_query->>'search'))>0)
   AND (p_query->>'date' IS NULL OR t.business_date=(p_query->>'date')::date)
   AND (p_query->>'paymentMethod' IS NULL OR t.payment_method=p_query->>'paymentMethod');
  SELECT coalesce(jsonb_agg(cashier.transaction_json(x.id) ORDER BY x.business_date DESC NULLS LAST,x.occurred_at DESC NULLS LAST,x.id DESC),'[]') INTO rows FROM
   (SELECT t.id,t.business_date,t.occurred_at FROM cashier.transactions t WHERE
    (coalesce(p_query->>'search','')='' OR strpos(lower(t.invoice||' '||coalesce(t.customer,'')),lower(p_query->>'search'))>0)
    AND (p_query->>'date' IS NULL OR t.business_date=(p_query->>'date')::date)
    AND (p_query->>'paymentMethod' IS NULL OR t.payment_method=p_query->>'paymentMethod')
    ORDER BY t.business_date DESC NULLS LAST,t.occurred_at DESC NULLS LAST,t.id DESC LIMIT lim OFFSET (page-1)*lim) x;
  RETURN jsonb_build_object('rows',rows,'page',page,'limit',lim,'total',n,'pages',greatest(1,ceil(n::numeric/lim)));
 ELSIF p_kind='incoming' THEN
  SELECT count(*) INTO n FROM cashier.incoming_stock WHERE (p_query->>'date' IS NULL OR business_date=(p_query->>'date')::date)
   AND (coalesce(p_query->>'search','')='' OR strpos(lower(coalesce(data->>'product','')||' '||coalesce(supplier,'')),lower(p_query->>'search'))>0);
  SELECT coalesce(jsonb_agg(x.data ORDER BY x.business_date DESC NULLS LAST,x.id DESC),'[]') INTO rows FROM
   (SELECT * FROM cashier.incoming_stock WHERE (p_query->>'date' IS NULL OR business_date=(p_query->>'date')::date)
    AND (coalesce(p_query->>'search','')='' OR strpos(lower(coalesce(data->>'product','')||' '||coalesce(supplier,'')),lower(p_query->>'search'))>0)
    ORDER BY business_date DESC NULLS LAST,id DESC LIMIT lim OFFSET (page-1)*lim) x;
  RETURN jsonb_build_object('rows',rows,'page',page,'limit',lim,'total',n,'pages',greatest(1,ceil(n::numeric/lim)),
   'summary',(SELECT jsonb_build_object('qty',coalesce(sum(qty),0),'total',coalesce(sum(total),0)) FROM cashier.incoming_stock WHERE
    (p_query->>'date' IS NULL OR business_date=(p_query->>'date')::date)
    AND (coalesce(p_query->>'search','')='' OR strpos(lower(coalesce(data->>'product','')||' '||coalesce(supplier,'')),lower(p_query->>'search'))>0)));
 ELSIF p_kind='stocktakes' THEN
  SELECT count(*) INTO n FROM cashier.stocktakes WHERE (p_query->>'date' IS NULL OR business_date=(p_query->>'date')::date)
   AND (coalesce(p_query->>'search','')='' OR strpos(lower(coalesce(data->>'product','')||' '||coalesce(data->>'category','')),lower(p_query->>'search'))>0);
  SELECT coalesce(jsonb_agg(x.data ORDER BY x.business_date DESC NULLS LAST,x.id DESC),'[]') INTO rows FROM
   (SELECT * FROM cashier.stocktakes WHERE (p_query->>'date' IS NULL OR business_date=(p_query->>'date')::date)
    AND (coalesce(p_query->>'search','')='' OR strpos(lower(coalesce(data->>'product','')||' '||coalesce(data->>'category','')),lower(p_query->>'search'))>0)
    ORDER BY business_date DESC NULLS LAST,id DESC LIMIT lim OFFSET (page-1)*lim) x;
  RETURN jsonb_build_object('rows',rows,'page',page,'limit',lim,'total',n,'pages',greatest(1,ceil(n::numeric/lim)),
   'summary',(SELECT jsonb_build_object('positive',coalesce(sum(difference) FILTER(WHERE difference>0),0),'negative',coalesce(sum(difference) FILTER(WHERE difference<0),0),'difference',coalesce(sum(difference),0)) FROM cashier.stocktakes WHERE
    (p_query->>'date' IS NULL OR business_date=(p_query->>'date')::date)
    AND (coalesce(p_query->>'search','')='' OR strpos(lower(coalesce(data->>'product','')||' '||coalesce(data->>'category','')),lower(p_query->>'search'))>0)));
 ELSIF p_kind='dashboard' THEN
  SELECT jsonb_build_object(
   'date',day,'count',(SELECT count(*) FROM cashier.transactions WHERE business_date=day),
   'sales',(SELECT coalesce(sum(total),0) FROM cashier.transactions WHERE business_date=day),
   'profit',(SELECT coalesce(sum(i.profit),0) FROM cashier.transaction_items i JOIN cashier.transactions t ON t.id=i.transaction_id WHERE t.business_date=day),
   'moneyIn',(SELECT coalesce(sum(coalesce(dashboard_amount,amount)),0) FROM cashier.transaction_payments WHERE business_date=day),
   'payments',(SELECT coalesce(jsonb_object_agg(method,amount),'{}') FROM (SELECT coalesce(method,'-') method,sum(coalesce(dashboard_amount,amount)) amount FROM cashier.transaction_payments WHERE business_date=day GROUP BY method) q),
   'receivable',(SELECT coalesce(sum(greatest(0,t.total-coalesce(p.amount,0))),0) FROM cashier.transactions t LEFT JOIN (SELECT transaction_id,sum(amount) amount FROM cashier.transaction_payments GROUP BY transaction_id) p ON p.transaction_id=t.id),
   'unpaidCount',(SELECT count(*) FROM cashier.transactions t LEFT JOIN (SELECT transaction_id,sum(amount) amount FROM cashier.transaction_payments GROUP BY transaction_id) p ON p.transaction_id=t.id WHERE t.total>coalesce(p.amount,0)),
   'recent',(SELECT coalesce(jsonb_agg(data ORDER BY business_date DESC,id DESC),'[]') FROM (SELECT data||jsonb_build_object('total',total) data,business_date,id FROM cashier.transactions WHERE business_date=day ORDER BY business_date DESC,id DESC LIMIT 6) q),
   'days',(SELECT jsonb_agg(jsonb_build_object('label',to_char(d,'DD/MM'),'sales',coalesce((SELECT sum(total) FROM cashier.transactions WHERE business_date=d::date),0),'profit',coalesce((SELECT sum(i.profit) FROM cashier.transaction_items i JOIN cashier.transactions t ON t.id=i.transaction_id WHERE t.business_date=d::date),0)) ORDER BY d) FROM generate_series(day-6,day,interval '1 day') d),
   'topProducts',(SELECT coalesce(jsonb_agg(to_jsonb(q)),'[]') FROM (SELECT i.name,sum(i.qty) qty,sum(i.amount) revenue FROM cashier.transaction_items i JOIN cashier.transactions t ON t.id=i.transaction_id WHERE t.business_date=day GROUP BY i.product_id,i.name ORDER BY sum(i.qty) DESC,i.name LIMIT 6) q)
  ) INTO result;
  RETURN CASE WHEN u.role='ADMINISTRATOR' THEN result ELSE cashier.redact_financial(result) END;
 END IF;
 RAISE EXCEPTION 'Unknown read' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION public.cashier_read(text,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cashier_read(text,jsonb,text,text) TO service_role;
COMMIT;
