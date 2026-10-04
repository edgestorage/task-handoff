const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ControlPlaneAuth } = require("../packages/control-plane/src/control-plane/auth/service.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");

const CLIENT = { name: "dev-mac", platform: "darwin", version: "1.0.0" };

function tempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

test("enabling authentication revokes a disabled-mode local trust session", async () => {
  const dataDir = tempDataDir("cp-auth-mode-boundary");
  const paths = controlPlaneStorePaths(dataDir);

  const disabled = new ControlPlaneAuth(paths, { mode: "disabled" });
  try {
    const created = await disabled.createLocalCliSession({ client: CLIENT }, { remoteAddress: "127.0.0.1" });
    assert.ok(created.sessionToken);
    assert.notEqual(await disabled.authorizationForSessionToken(created.sessionToken, ["cli"]), undefined);

    // The local trust boundary only exists while authentication is disabled:
    // switching modes must revoke the credential instead of carrying it over.
    const enabled = new ControlPlaneAuth(paths, { mode: "password" });
    try {
      await enabled.init();
      await enabled.bootstrapAdmin({ username: "admin", password: "password123" });
      assert.equal(await enabled.authorizationForSessionToken(created.sessionToken, ["cli"]), undefined);
      assert.equal(await enabled.currentAccess(created.sessionToken, ["cli"]), undefined);
      assert.equal(await enabled.renewSession(created.sessionToken, ["cli"]), undefined);
      const users = await enabled.users.list();
      assert.equal(users.some((user) => user.displayName === "Local Operator"), false);
    } finally {
      enabled.close();
    }

    // Returning to disabled mode recreates the operator and mints a fresh session.
    const disabledAgain = new ControlPlaneAuth(paths, { mode: "disabled" });
    try {
      const reminted = await disabledAgain.createLocalCliSession({ client: CLIENT }, { remoteAddress: "127.0.0.1" });
      assert.notEqual(await disabledAgain.authorizationForSessionToken(reminted.sessionToken, ["cli"]), undefined);
    } finally {
      disabledAgain.close();
    }
  } finally {
    disabled.close();
  }
});
