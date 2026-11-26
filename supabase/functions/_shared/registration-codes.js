/*
 * A numeração de obras e peças vem de sequências PostgreSQL.
 * A RPC é a única responsável por reservar o próximo número, inclusive
 * quando dois operadores salvam cadastros ao mesmo tempo.
 */
export async function nextRegistrationCode(db, kind) {
  if (kind !== "work" && kind !== "piece") throw new Error("Tipo de numeração inválido.");
  const { data, error } = await db.rpc("next_registration_code", { p_kind: kind });
  if (error) throw Object.assign(new Error("Não foi possível gerar o próximo número. Confira a migration de numeração no Supabase."), { status: 500, cause: error });
  const width = kind === "work" ? 6 : 7;
  if (typeof data !== "string" || !new RegExp(`^\\d{${width}}$`).test(data)) {
    throw Object.assign(new Error("O banco retornou um número inválido para o cadastro."), { status: 500 });
  }
  return data;
}
