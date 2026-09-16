const { createClient } = require('@supabase/supabase-js');

const url = __SUPABASE_URL__;
const publishableKey = __SUPABASE_ANON_KEY__;
const client = url && publishableKey ? createClient(url, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
}) : null;
let channel = null;
let connected = false;

window.KASIR_REALTIME = {
  enabled: Boolean(client),
  isConnected() { return connected; },
  subscribe(onChange, onStatus) {
    if (!client || channel) return;
    channel = client
      .channel('kasir-app-state')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_sync_signal', filter: 'id=eq.1' }, payload => onChange(payload.new?.version))
      .subscribe(status => {
        connected = status === 'SUBSCRIBED';
        onStatus?.(connected, status);
      });
  },
  unsubscribe() {
    if (client && channel) client.removeChannel(channel);
    channel = null;
    connected = false;
  }
};
