const { ControlPlaneService } = require("../../packages/control-plane/src/control-plane/application/service.ts");
const { createControlPlaneDatabase } = require("../../packages/control-plane/src/control-plane/persistence/database/index.ts");
const { controlPlaneStorePaths } = require("../../packages/control-plane/src/control-plane/persistence/paths.ts");
const { SecretEnvelopeService } = require("../../packages/control-plane/src/control-plane/persistence/secret-envelope.ts");

async function createTestControlPlaneService(dataDir, options = {}) {
  const paths = controlPlaneStorePaths(dataDir);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const service = new ControlPlaneService(paths, { ...options, database, secrets });
  await service.init();
  return {
    service,
    database,
    secrets,
    async close() {
      service.dispose();
      await database.close();
    },
  };
}

module.exports = { createTestControlPlaneService };
