const { createClient } = require('@supabase/supabase-js');

const url = __SUPABASE_URL__;
const publishableKey = __SUPABASE_ANON_KEY__;
const client = url && publishableKey ? createClient(url, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
}) : null;
let channel = null;

window.KASIR_REALTIME = {
  enabled: Boolean(client),
  subscribe(onChange) {
    if (!client || channel) return;
    channel = client
      .channel('kasir-app-state')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_sync_signal', filter: 'id=eq.1' }, payload => onChange(payload.new?.version))
      .subscribe();
  },
  unsubscribe() {
    if (client && channel) client.removeChannel(channel);
    channel = null;
  }
};
