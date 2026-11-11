/* Acesso de banco usado somente pelo servico do cadastro integrado. */
export const registrationRepository = Object.freeze({
  getProductionMinutes(db, organizationId) {
    return db.from("calculation_constants")
      .select("constant_key, numeric_value")
      .eq("organization_id", organizationId)
      .in("constant_key", ["production_minutes_braco", "production_minutes_pilar", "production_minutes_viga"]);
  },

  getMoldCatalogEntries(db, codes) {
    return db.from("mold_catalog").select("code, mold_type").in("code", codes);
  },

  createRegistration(db, organizationId, registration) {
    return db.rpc("create_order_piece_registration", {
      p_org_id: organizationId,
      p_registration: registration,
    });
  },
});
