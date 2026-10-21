import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function createAdminClient({ supabaseUrl, serviceRoleKey }) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
