-- Skema idempotent untuk Web Kasir Sumber Berkah. Tidak berisi seed operasional atau kredensial.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(80) UNIQUE NOT NULL CHECK (username = upper(trim(username)) AND length(trim(username)) > 0),
  password_hash TEXT NOT NULL CHECK (password_hash LIKE '$2%'),
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMINISTRATOR', 'KASIR')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS app_users_active_role_idx ON public.app_users (active, role);

CREATE TABLE IF NOT EXISTS public.app_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  payload JSONB NOT NULL DEFAULT '{"products":[],"suppliers":[],"customers":[],"transactions":[],"incoming":[],"stocktakes":[]}'::jsonb,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(80)
);

ALTER TABLE public.app_state ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
INSERT INTO public.app_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Tabel sinyal hanya memublikasikan nomor versi. Payload kasir tetap hanya dapat dibaca melalui API terautentikasi.
CREATE TABLE IF NOT EXISTS public.app_sync_signal (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.app_sync_signal (id, version)
SELECT 1, version FROM public.app_state WHERE id = 1
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_sync_signal ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.app_sync_signal TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.app_sync_signal FROM anon, authenticated;
DROP POLICY IF EXISTS app_sync_signal_read ON public.app_sync_signal;
CREATE POLICY app_sync_signal_read ON public.app_sync_signal FOR SELECT TO anon, authenticated USING (id = 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'app_sync_signal'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.app_sync_signal;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS app_users_updated_at ON public.app_users;
CREATE TRIGGER app_users_updated_at BEFORE UPDATE ON public.app_users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.save_app_state(p_expected_version BIGINT, p_payload JSONB, p_updated_by VARCHAR)
RETURNS TABLE (version BIGINT, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_version BIGINT;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'payload must be an object'; END IF;
  UPDATE public.app_state
  SET payload = p_payload, version = app_state.version + 1, updated_at = NOW(), updated_by = p_updated_by
  WHERE id = 1 AND app_state.version = p_expected_version
  RETURNING app_state.version, app_state.updated_at INTO v_version, v_updated_at;

  IF FOUND THEN
    UPDATE public.app_sync_signal SET version = v_version, updated_at = v_updated_at WHERE id = 1;
    RETURN QUERY SELECT v_version, v_updated_at;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_app_state(BIGINT, JSONB, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_app_state(BIGINT, JSONB, VARCHAR) TO service_role;
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_users, public.app_state FROM anon, authenticated;
