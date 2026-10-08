import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BuiltinProjectDefinition } from "./assets.ts";

export const BUILTIN_PROJECT_MARKER_DIR = ".task-handoff";
export const BUILTIN_PROJECT_MARKER_FILE = "initialized.json";
export const BUILTIN_PROJECT_MARKER_SCHEMA_VERSION = 1;

/**
 * Initialization marker written into the target directory. It lives next to the
 * content on purpose: it is the only thing that proves "this exact directory was
 * already materialized by this product", independent of instance records,
 * caches or configuration. `version` values recorded here are diagnostics only;
 * nothing re-materializes an already marked directory.
 */
export const BuiltinProjectMarkerSchema = z
  .object({
    schemaVersion: z.literal(BUILTIN_PROJECT_MARKER_SCHEMA_VERSION),
    projectId: z.string().trim().min(1).max(120),
    contentDigest: z.string().trim().regex(/^[a-f0-9]{64}$/),
    instanceId: z.string().trim().min(1).max(120).optional(),
    createdAt: z.string().trim().min(1).max(64),
  })
  .strict();
export type BuiltinProjectMarker = z.infer<typeof BuiltinProjectMarkerSchema>;

export type BuiltinProjectInitializationOutcome =
  | { status: "initialized"; targetDir: string; projectId: string; contentDigest: string; filesWritten: number }
  | { status: "already-initialized"; targetDir: string; projectId: string; contentDigest: string };

export function builtinProjectMarkerPath(targetDir: string) {
  return path.join(targetDir, BUILTIN_PROJECT_MARKER_DIR, BUILTIN_PROJECT_MARKER_FILE);
}

/**
 * Reads the marker tolerantly: a directory that carries an unreadable or
 * unrecognized marker is treated as "not initialized by us" so the caller
 * refuses to write instead of overwriting content it cannot account for.
 */
export function readBuiltinProjectMarker(targetDir: string): BuiltinProjectMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(builtinProjectMarkerPath(targetDir), "utf8"));
    const marker = BuiltinProjectMarkerSchema.safeParse(parsed);
    return marker.success ? marker.data : undefined;
  } catch {
    return undefined;
  }
}

function notEmptyError(targetDir: string, details: Record<string, unknown> = {}) {
  return Object.assign(
    new Error(`Built-in project target ${targetDir} already contains content this product did not initialize.`),
    { statusCode: 409, code: "BUILTIN_PROJECT_TARGET_NOT_EMPTY", details: { targetDir, ...details } },
  );
}

function isDirectoryEmpty(dir: string) {
  return fs.readdirSync(dir).length === 0;
}

/**
 * Materializes a built-in project into `targetDir` at most once.
 *
 * - an existing marker short-circuits every write;
 * - a missing or empty target is created and filled, with the marker committed
 *   as part of the atomic rename;
 * - anything else is a conflict that is refused without touching the directory.
 */
export function ensureBuiltinProjectMaterialized(
  definition: BuiltinProjectDefinition,
  targetDir: string,
  options: { instanceId?: string; createdAt?: string } = {},
): BuiltinProjectInitializationOutcome {
  const marker = readBuiltinProjectMarker(targetDir);
  if (marker) {
    return {
      status: "already-initialized",
      targetDir,
      projectId: marker.projectId,
      contentDigest: marker.contentDigest,
    };
  }

  const targetExists = fs.existsSync(targetDir);
  if (targetExists) {
    if (!fs.statSync(targetDir).isDirectory()) throw notEmptyError(targetDir, { reason: "target-is-not-a-directory" });
    if (!isDirectoryEmpty(targetDir)) throw notEmptyError(targetDir, { reason: "target-is-not-empty" });
  }

  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
  // Stage inside the target's parent so the final rename stays on one file
  // system and the directory appears fully written or not at all.
  const stagingDir = fs.mkdtempSync(path.join(parentDir, `.${path.basename(targetDir)}.staging-`));
  try {
    for (const file of definition.files) {
      const destination = path.join(stagingDir, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, fs.readFileSync(file.absolutePath), { mode: file.mode });
      fs.chmodSync(destination, file.mode);
    }
    const committedMarker: BuiltinProjectMarker = {
      schemaVersion: BUILTIN_PROJECT_MARKER_SCHEMA_VERSION,
      projectId: definition.id,
      contentDigest: definition.contentDigest,
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      createdAt: options.createdAt || new Date().toISOString(),
    };
    fs.mkdirSync(path.join(stagingDir, BUILTIN_PROJECT_MARKER_DIR), { recursive: true, mode: 0o755 });
    fs.writeFileSync(
      path.join(stagingDir, BUILTIN_PROJECT_MARKER_DIR, BUILTIN_PROJECT_MARKER_FILE),
      `${JSON.stringify(committedMarker, null, 2)}\n`,
      { mode: 0o644 },
    );
    // Only ever removed when the earlier check proved it is an empty directory.
    if (targetExists) fs.rmdirSync(targetDir);
    fs.renameSync(stagingDir, targetDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return {
    status: "initialized",
    targetDir,
    projectId: definition.id,
    contentDigest: definition.contentDigest,
    filesWritten: definition.files.length,
  };
}
