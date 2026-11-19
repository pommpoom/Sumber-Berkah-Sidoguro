-- NOT EXECUTED. Review existing grants before applying during maintenance.
BEGIN;
REVOKE ALL ON FUNCTION public.save_app_state(bigint,jsonb,varchar) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_app_state(bigint,jsonb,varchar) TO service_role;
REVOKE ALL ON public.app_state,public.app_users FROM PUBLIC,anon,authenticated;
COMMIT;
