/* Acesso de banco usado somente pelo servico do cadastro integrado. */
export const registrationRepository = Object.freeze({
  getCastingDurationMinutes(db, organizationId) {
    return db.from("calculation_constants")
      .select("numeric_value, unit")
      .eq("organization_id", organizationId)
      .eq("constant_key", "casting_duration_minutes")
      .maybeSingle();
  },

  getMoldCatalogEntries(db, codes) {
    return db.from("mold_catalog").select("code, mold_type, measure_label").in("code", codes);
  },

  getMoldCatalogByTypes(db, moldTypes) {
    return db.from("mold_catalog").select("code, mold_type, measure_label").in("mold_type", moldTypes);
  },

  getOrder(db, organizationId, orderId) {
    return db.from("orders")
      .select("id, order_number, client_id, start_date, requested_due_date, planned_end_date, forecast_end_date, status, created_at, is_active")
      .eq("organization_id", organizationId)
      .eq("id", orderId)
      .maybeSingle();
  },

  getNextItemSequence(db, organizationId, orderId) {
    return db.from("order_items")
      .select("sequence")
      .eq("organization_id", organizationId)
      .eq("order_id", orderId)
      .order("sequence", { ascending: false })
      .limit(1)
      .maybeSingle();
  },

  createRegistration(db, organizationId, registration) {
    return db.rpc("create_order_piece_registration", {
      p_org_id: organizationId,
      p_registration: registration,
    });
  },

  createOrderHeader(db, organizationId, registration) {
    return db.rpc("create_order_header", {
      p_org_id: organizationId,
      p_registration: registration,
    });
  },

  addOrderPieceItem(db, organizationId, registration) {
    return db.rpc("add_order_piece_item", {
      p_org_id: organizationId,
      p_registration: registration,
    });
  },
});
