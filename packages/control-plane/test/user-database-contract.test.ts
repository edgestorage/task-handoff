import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { createControlPlaneUserRepository } from "../src/control-plane/auth/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";

type Fixture = {
  name: string;
  create(): Promise<{ repository: Awaited<ReturnType<typeof createControlPlaneUserRepository>>; cleanup(): Promise<void> }>;
};

const fixtures: Fixture[] = [{
  name: "sqlite",
  async create() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-db-contract-"));
    const repository = await createControlPlaneUserRepository(controlPlaneStorePaths(dataDir));
    return { repository, cleanup: async () => { await repository.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
  },
}];

const postgresqlUrl = process.env.TASK_HANDOFF_TEST_POSTGRES_URL;
if (postgresqlUrl) {
  fixtures.push({
    name: "postgresql",
    async create() {
      const schema = `task_handoff_contract_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const repository = await createControlPlaneUserRepository(controlPlaneStorePaths(), {
        dialect: "postgresql",
        connectionString: postgresqlUrl,
        schema,
      });
      return {
        repository,
        cleanup: async () => {
          await repository.close();
          const pool = new Pool({ connectionString: postgresqlUrl });
          try { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); }
        },
      };
    },
  });
}

for (const fixture of fixtures) {
  test(`${fixture.name} repository enforces uniqueness and rolls back composite writes`, async () => {
    const current = await fixture.create();
    const timestamp = new Date().toISOString();
    try {
      await assert.rejects(() => current.repository.transaction(async (transaction) => {
        await transaction.users.put({ id: "user_rollback", displayName: "Rollback", status: "active", createdAt: timestamp, updatedAt: timestamp });
        await transaction.identities.put({
          id: "identity_rollback",
          userId: "user_rollback",
          kind: "local-password",
          normalizedLoginName: "same-login",
          passwordHash: "hash",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await transaction.audit.put({
          id: "audit_rollback",
          action: "test.rollback",
          targetType: "user",
          targetId: "user_rollback",
          details: {},
          createdAt: timestamp,
        });
        throw new Error("force rollback");
      }), /force rollback/);
      assert.equal(await current.repository.users.get("user_rollback"), undefined);
      assert.equal(await current.repository.identities.get("identity_rollback"), undefined);
      assert.equal(await current.repository.audit.get("audit_rollback"), undefined);

      await current.repository.transaction(async (transaction) => {
        await transaction.users.put({ id: "user_one", displayName: "One", status: "active", createdAt: timestamp, updatedAt: timestamp });
        await transaction.users.put({ id: "user_two", displayName: "Two", status: "active", createdAt: timestamp, updatedAt: timestamp });
        await transaction.roles.put({ id: "role_one", name: "Role One", system: false, status: "active", permissionIds: ["users:read"], createdAt: timestamp, updatedAt: timestamp });
        await transaction.roles.put({ id: "role_two", name: "Role Two", system: false, status: "active", permissionIds: ["nodes:read"], createdAt: timestamp, updatedAt: timestamp });
        await transaction.identities.put({ id: "identity_one", userId: "user_one", kind: "local-password", normalizedLoginName: "same-login", passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
        await transaction.grants.put({
          userId: "user_one",
          roleIds: ["role_one", "role_two"],
          nodeScope: { kind: "all" },
          instanceScope: { kind: "inherit-node-scope" },
          authorizationRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      });
      assert.deepEqual((await current.repository.grants.get("user_one"))?.roleIds, ["role_one", "role_two"]);
      const currentGrant = (await current.repository.grants.get("user_one"))!;
      await assert.rejects(() => current.repository.grants.put({
        ...currentGrant,
        roleIds: ["role_one", "role_missing"],
        authorizationRevision: 2,
      }));
      assert.deepEqual((await current.repository.grants.get("user_one"))?.roleIds, ["role_one", "role_two"], "failed role replacement must roll back the aggregate");

      await assert.rejects(() => current.repository.sessions.put({
        id: "session_wrong_user",
        userId: "user_two",
        identityId: "identity_one",
        authorizationRevision: 1,
        tokenHash: "wrong-user-hash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        clientType: "web",
        createdAt: timestamp,
        updatedAt: timestamp,
      }), /does not belong/);
      await current.repository.sessions.put({
        id: "session_one",
        userId: "user_one",
        identityId: "identity_one",
        authorizationRevision: 1,
        tokenHash: "session-one-hash",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        clientType: "web",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      assert.equal((await current.repository.sessions.get("session_one"))?.userId, "user_one");
      await assert.rejects(() => current.repository.identities.put({
        id: "identity_two",
        userId: "user_two",
        kind: "local-password",
        normalizedLoginName: "same-login",
        passwordHash: "hash",
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
      assert.equal(await current.repository.identities.get("identity_two"), undefined);

      await Promise.all([
        current.repository.transaction(async (transaction) => {
          await transaction.users.put({ id: "user_concurrent_one", displayName: "Concurrent One", status: "active", createdAt: timestamp, updatedAt: timestamp });
        }),
        current.repository.transaction(async (transaction) => {
          await transaction.users.put({ id: "user_concurrent_two", displayName: "Concurrent Two", status: "active", createdAt: timestamp, updatedAt: timestamp });
        }),
      ]);
      assert.ok(await current.repository.users.get("user_concurrent_one"));
      assert.ok(await current.repository.users.get("user_concurrent_two"));
    } finally {
      await current.cleanup();
    }
  });
}

test("PostgreSQL repository contract is opt-in when no test database is configured", { skip: Boolean(postgresqlUrl) }, () => {
  assert.equal(postgresqlUrl, undefined);
});
