export function getServerConfig() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const organizationId = Deno.env.get("PRELUX_ORGANIZATION_ID");

  if (!supabaseUrl || !serviceRoleKey || !organizationId) {
    throw new Error(
      "Backend não configurado: defina SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e PRELUX_ORGANIZATION_ID.",
    );
  }

  return { supabaseUrl, serviceRoleKey, organizationId };
}
