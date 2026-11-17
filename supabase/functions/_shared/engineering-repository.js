/*
 * Adaptador de persistência da Engenharia.
 * Só esta camada conhece nomes de tabelas e colunas do Supabase.
 */

export const engineeringRepository = Object.freeze({
  getCurrentParameters(db, organizationId) {
    return db
      .from("engineering_parameter_versions")
      .select("id, organization_id, version_number, preparation_workdays, casting_workdays, curing_calendar_days, finishing_workdays, max_castings_per_workday, maximum_order_calendar_days, casting_start_time, concrete_density_kg_m3, created_at")
      .eq("organization_id", organizationId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
  },

  getMoldCatalog(db) {
    return db
      .from("mold_catalog")
      .select("code, mold_type, measure_label, sort_order")
      .order("sort_order", { ascending: true });
  },

  getPositions(db, organizationId) {
    return db
      .from("mold_positions")
      .select("id, code, status, configuration_kind, braco_catalog_code, leito_catalog_code, lateral_catalog_code, version")
      .eq("organization_id", organizationId)
      .order("code", { ascending: true });
  },
});
