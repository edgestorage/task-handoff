import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildModulePath = path.join(root, "shared", "cloud-environment-build.cjs");
const require = createRequire(import.meta.url);
const { configuredCloudEnvironmentVariables } = require("../shared/cloud-environments.cjs");

export function cloudEnvironmentBuildPlugin(environment = process.env) {
  const configured = configuredCloudEnvironmentVariables(environment);
  return {
    name: "task-handoff-cloud-environment-build",
    transform(_code, id) {
      if (path.resolve(id.split("?")[0]) !== buildModulePath) return null;
      return {
        code: `module.exports = Object.freeze(${JSON.stringify(configured)});\n`,
        map: null,
      };
    },
  };
}
