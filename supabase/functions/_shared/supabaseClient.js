/*
 * Cria o cliente administrativo usado somente no servidor.
 * A chave de serviço vem do ambiente da Edge Function e nunca é devolvida
 * ao navegador. Sessões persistentes não são necessárias nessas chamadas.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function createAdminClient({ supabaseUrl, serviceRoleKey }) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
