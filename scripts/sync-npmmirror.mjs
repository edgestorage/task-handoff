import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { runtimePackages } from "../runtime-packages.config.mjs";

const DEFAULT_REGISTRY = "https://registry.npmmirror.com";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

function normalizeRegistry(value) {
  return value.replace(/\/+$/, "");
}

function packageManifestUrl(registry, packageName) {
  return `${registry}/${packageName}`;
}

function syncCollectionUrl(registry, packageName) {
  return `${registry}/-/package/${packageName}/syncs`;
}

function syncTaskUrl(registry, packageName, taskId) {
  return `${syncCollectionUrl(registry, packageName)}/${encodeURIComponent(taskId)}`;
}

function packageTarballUrl(registry, packageName, version) {
  return `${registry}/${packageName}/-/${packageName.split("/").at(-1)}-${version}.tgz`;
}

async function request(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${url} returned HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
  }
  return body;
}

async function triggerPackageSync({ fetchImpl, registry, packageName, version }) {
  const body = await request(fetchImpl, syncCollectionUrl(registry, packageName), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tips: `TaskHandoff runtime release ${version}`,
    }),
  });
  if (!body?.id) throw new Error(`npmmirror did not return a sync task id for ${packageName}`);
  return body.id;
}

async function readTaskState({ fetchImpl, registry, packageName, taskId }) {
  const body = await request(fetchImpl, syncTaskUrl(registry, packageName, taskId));
  if (!body?.state) throw new Error(`npmmirror did not return a state for ${packageName}`);
  return body.state;
}

async function verifyPublishedPackage({ fetchImpl, registry, packageName, version, distTag }) {
  const manifest = await request(fetchImpl, packageManifestUrl(registry, packageName));
  const versionPublished = Boolean(manifest?.versions?.[version]);
  const tagPublished = !distTag || manifest?.["dist-tags"]?.[distTag] === version;
  const tarballResponse = await fetchImpl(packageTarballUrl(registry, packageName, version), {
    method: "HEAD",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return {
    manifest: versionPublished && tagPublished,
    tarball: tarballResponse.ok,
    latest: manifest?.["dist-tags"]?.latest,
  };
}

function failedResult(packageName, error) {
  return {
    packageName,
    state: "failed",
    verified: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function syncNpmmirror({
  version,
  packages,
  registry = DEFAULT_REGISTRY,
  distTag,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  fetchImpl = fetch,
  now = Date.now,
  sleep = delay,
  log = console,
}) {
  const normalizedRegistry = normalizeRegistry(registry);
  const deadline = now() + timeoutMs;
  const results = packages.map((packageName) => ({
    packageName,
    taskId: null,
    state: "pending",
    verified: false,
    error: null,
  }));

  await Promise.all(results.map(async (result) => {
    try {
      result.taskId = await triggerPackageSync({
        fetchImpl,
        registry: normalizedRegistry,
        packageName: result.packageName,
        version,
      });
      result.state = "waiting";
      log.log(`[npmmirror] queued ${result.packageName}: ${result.taskId}`);
    } catch (error) {
      Object.assign(result, failedResult(result.packageName, error));
      log.warn(`[npmmirror] failed to queue ${result.packageName}: ${result.error}`);
    }
  }));

  while (now() < deadline) {
    const active = results.filter((result) => result.taskId && (result.state === "waiting" || result.state === "processing"));
    if (active.length === 0) break;
    await Promise.all(active.map(async (result) => {
      try {
        result.state = await readTaskState({
          fetchImpl,
          registry: normalizedRegistry,
          packageName: result.packageName,
          taskId: result.taskId,
        });
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
    }));
    if (results.every((result) => result.state !== "waiting" && result.state !== "processing")) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }

  for (const result of results) {
    if (result.state === "waiting" || result.state === "processing") {
      result.state = "timeout";
      result.error ||= "timed out waiting for the npmmirror sync task";
      log.warn(`[npmmirror] timed out ${result.packageName}`);
    }
  }

  const completed = results.filter((result) => result.state === "success");
  while (completed.some((result) => !result.verified) && now() < deadline) {
    await Promise.all(completed.filter((result) => !result.verified).map(async (result) => {
      try {
        const verification = await verifyPublishedPackage({
          fetchImpl,
          registry: normalizedRegistry,
          packageName: result.packageName,
          version,
          distTag,
        });
        result.verified = verification.manifest && verification.tarball;
        if (result.verified) {
          log.log(`[npmmirror] verified ${result.packageName}@${version}`);
        } else if (distTag && verification.latest !== version && verification.manifest === false) {
          result.error = `manifest is not ready${verification.latest ? `; latest is ${verification.latest}` : ""}`;
        } else if (!verification.tarball) {
          result.error = "tarball is not available";
        } else {
          result.error = "manifest is not ready";
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
    }));
    if (completed.every((result) => result.verified)) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }

  for (const result of results) {
    if (result.state === "success" && !result.verified) {
      result.state = "unverified";
      result.error ||= "sync completed but the published version could not be verified";
      log.warn(`[npmmirror] unverified ${result.packageName}: ${result.error}`);
    } else if (result.state === "failed") {
      log.warn(`[npmmirror] failed ${result.packageName}: ${result.error || "sync task failed"}`);
    }
  }

  return {
    ok: results.every((result) => result.state === "success" && result.verified),
    results,
  };
}

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    options: {
      version: { type: "string" },
      registry: { type: "string", default: DEFAULT_REGISTRY },
      "dist-tag": { type: "string" },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      "poll-interval-ms": { type: "string", default: String(DEFAULT_POLL_INTERVAL_MS) },
    },
    strict: true,
  }).values;
}

async function main() {
  const values = parseCliArgs(process.argv.slice(2));
  if (!values.version) throw new Error("--version is required");
  const result = await syncNpmmirror({
    version: values.version,
    packages: Object.values(runtimePackages).map((definition) => definition.packageName),
    registry: values.registry,
    distTag: values["dist-tag"],
    timeoutMs: Number(values["timeout-ms"]),
    pollIntervalMs: Number(values["poll-interval-ms"]),
  });

  for (const item of result.results) {
    console.log(`[npmmirror] ${item.packageName}: state=${item.state} verified=${item.verified}${item.error ? ` error=${item.error}` : ""}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1]) {
  const entrypoint = new URL(import.meta.url).pathname;
  if (process.argv[1] === entrypoint || process.argv[1].endsWith("/scripts/sync-npmmirror.mjs")) {
    main().catch((error) => {
      console.error(`[npmmirror] ${error instanceof Error ? error.stack || error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
