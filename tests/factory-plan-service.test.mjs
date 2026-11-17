import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationRequestFingerprint,
  confirmFactoryPlan,
} from "../supabase/functions/_shared/factory-plan-service.js";

const key = "b77a47c5-379b-44ae-89cb-5823ae3f8921";

function receiptDatabase(receipt) {
  let tableName = null;
  const filters = [];
  return {
    get tableName() { return tableName; },
    from(name) {
      tableName = name;
      return {
        select() { return this; },
        eq(column, value) { filters.push([column, value]); return this; },
        async maybeSingle() {
          if (!receipt) return { data: null, error: null };
          const matches = filters.every(([column, value]) => receipt[column] === value);
          return { data: matches ? receipt : null, error: null };
        },
      };
    },
    rpc() { throw new Error("Um recibo válido deve ser devolvido antes de simular ou gravar."); },
  };
}

test("a impressão digital da confirmação independe da ordem de seleção", () => {
  assert.equal(
    confirmationRequestFingerprint(["pedido-b", "pedido-a"]),
    confirmationRequestFingerprint(["pedido-a", "pedido-b"]),
  );
  assert.notEqual(
    confirmationRequestFingerprint(["pedido-a"]),
    confirmationRequestFingerprint(["pedido-b"]),
  );
});

test("repetir uma confirmação concluída devolve o recibo sem simular ou gravar de novo", async () => {
  const orderIds = ["pedido-a"];
  const response = {
    scenario: { orderCount: 1 },
    result: { scheduledUnitCount: 3, waitingUnitCount: 0 },
    replayed: false,
  };
  const db = receiptDatabase({
    organization_id: "org-1",
    idempotency_key: key,
    request_fingerprint: confirmationRequestFingerprint(orderIds),
    response,
  });

  const result = await confirmFactoryPlan({
    db,
    organizationId: "org-1",
    orderIds,
    idempotencyKey: key,
  });

  assert.equal(db.tableName, "factory_plan_confirmation_receipts");
  assert.deepEqual(result, { ...response, replayed: true });
});

test("uma chave repetida com outra lista de pedidos entra em conflito", async () => {
  const db = receiptDatabase({
    organization_id: "org-1",
    idempotency_key: key,
    request_fingerprint: confirmationRequestFingerprint(["pedido-original"]),
    response: { scenario: {}, result: {} },
  });

  await assert.rejects(
    confirmFactoryPlan({ db, organizationId: "org-1", orderIds: ["pedido-outro"], idempotencyKey: key }),
    (error) => error.status === 409 && /outra solicitação/.test(error.message),
  );
});

test("confirmação sem chave UUID é recusada antes de acessar o banco", async () => {
  let databaseRead = false;
  const db = { from() { databaseRead = true; throw new Error("Leitura inesperada"); } };
  assert.throws(
    () => confirmFactoryPlan({ db, organizationId: "org-1", orderIds: [], idempotencyKey: "inválida" }),
    (error) => error.status === 400 && /chave UUID/.test(error.message),
  );
  assert.equal(databaseRead, false);
});
