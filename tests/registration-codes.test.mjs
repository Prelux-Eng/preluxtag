import assert from "node:assert/strict";
import test from "node:test";

import { nextRegistrationCode } from "../supabase/functions/_shared/registration-codes.js";

test("obra e peça usam a sequência do banco com larguras diferentes", async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: args.p_kind === "work" ? "000001" : "0000001", error: null };
    },
  };
  assert.equal(await nextRegistrationCode(db, "work"), "000001");
  assert.equal(await nextRegistrationCode(db, "piece"), "0000001");
  assert.deepEqual(calls, [
    { name: "next_registration_code", args: { p_kind: "work" } },
    { name: "next_registration_code", args: { p_kind: "piece" } },
  ]);
});

test("resposta sem a largura certa impede gravar código inválido", async () => {
  const db = { async rpc() { return { data: "12345", error: null }; } };
  await assert.rejects(nextRegistrationCode(db, "work"), /número inválido/);
  await assert.rejects(nextRegistrationCode(db, "piece"), /número inválido/);
});
