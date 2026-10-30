import fs from "node:fs";

const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.version !== 1 || typeof value.instanceId !== "string" || !value.instanceId || typeof value.instanceCredential !== "string" || !value.instanceCredential) process.exit(78);
const configured = value.environment === undefined ? {} : value.environment;
if (!configured || typeof configured !== "object" || Array.isArray(configured)) process.exit(78);
const environment = {
  ...configured,
  TASK_HANDOFF_REGISTRATION_TOKEN: value.instanceCredential,
  TASK_HANDOFF_PRIVATE_CONFIG_LOADED: "1",
  TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: process.argv[2],
};
if (value.modelCatalog !== undefined) environment.TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON = JSON.stringify(value.modelCatalog);
if (value.codexSettings !== undefined) environment.TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON = JSON.stringify(value.codexSettings);
for (const [key, item] of Object.entries(environment)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") process.exit(78);
  process.stdout.write(`${key}\t${Buffer.from(item).toString("base64")}\n`);
}
