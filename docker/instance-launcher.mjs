import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const current = process.argv[2];
if (!current) throw new Error("Active controlled-instance runtime path is missing.");
const releaseRoot = fs.realpathSync(current);
const manifestPath = path.join(releaseRoot, "runtime-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.packageName !== "@task-handoff/controlled-instance" || typeof manifest.entrypoint !== "string") {
  throw new Error("Active controlled-instance runtime manifest is invalid.");
}
const entrypoint = path.resolve(releaseRoot, manifest.entrypoint);
if (!entrypoint.startsWith(`${releaseRoot}${path.sep}`) || !fs.statSync(entrypoint).isFile()) {
  throw new Error("Active controlled-instance runtime entrypoint is invalid.");
}
process.argv = [process.execPath, entrypoint, "web", "--host", process.env.TASK_HANDOFF_WEB_HOST || "0.0.0.0", "--port", process.env.TASK_HANDOFF_WEB_PORT || "8080"];
await import(pathToFileURL(entrypoint).href);
