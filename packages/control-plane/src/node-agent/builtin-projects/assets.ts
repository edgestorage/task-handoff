import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Single source of truth for the built-in project contract between the node
// agent and every packaging path (desktop bundle, npm runtime package). Built-in
// project content ships with the node agent and is never sent over the wire, so
// this module is the only place that resolves, lists and verifies it.
// A project ships two files: a committed `project.json` with the product-owned
// decisions (id, display names, runtimes, where its content comes from) and a
// generated `manifest.json` that binds that source to the materialized content
// digest. Only the source file is tracked in Git: the content and the manifest
// are materialized at build time from published sources.
export const BUILTIN_PROJECT_SOURCE_FILE = "project.json";
export const BUILTIN_PROJECT_MANIFEST_FILE = "manifest.json";
export const BUILTIN_PROJECT_CONTENT_DIR = "content";

export const BuiltinProjectRuntimeSchema = z.enum(["docker", "kubernetes", "local"]);
export type BuiltinProjectRuntime = z.infer<typeof BuiltinProjectRuntimeSchema>;

/**
 * The project id doubles as the suffix of the derived built-in folder id, so it
 * has to leave room for `folder_builtin_` inside the 120-character folder id
 * budget. Failing the manifest here turns a configuration mistake into a startup
 * diagnostic instead of an unusable folder id.
 */
export const BUILTIN_PROJECT_ID_MAX_LENGTH = 105;

/** Locale-keyed display names, mirroring image `localizedDescriptions`. */
export const BuiltinProjectLocalizedNamesSchema = z.record(
  z.string().trim().min(2).max(35),
  z.string().trim().min(1).max(160),
);
export type BuiltinProjectLocalizedNames = z.infer<typeof BuiltinProjectLocalizedNamesSchema>;

/**
 * Manifest of one product-shipped built-in project. It deliberately does not
 * repeat per-file names or digests: the content digest covers the exact sorted
 * set of relative paths and file hashes, so a missing, added, renamed or edited
 * file all change the digest. That keeps the manifest free of a hand-maintained
 * file list that could silently drift from the content.
 */
const BuiltinProjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(BUILTIN_PROJECT_ID_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const BuiltinProjectNameSchema = z.string().trim().min(1).max(160);
const BuiltinProjectRuntimesSchema = z.array(BuiltinProjectRuntimeSchema).min(1).max(3);

export const BuiltinProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: BuiltinProjectIdSchema,
    /** Canonical display name; the stable fallback for every locale. */
    name: BuiltinProjectNameSchema,
    // Structured localization for the project display name, mirroring image
    // `localizedDescriptions`: unknown locales fall back to `name`. Absent means
    // the project ships a single canonical name.
    localizedNames: BuiltinProjectLocalizedNamesSchema.optional(),
    runtimes: BuiltinProjectRuntimesSchema,
    contentDigest: z.string().trim().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type BuiltinProjectManifest = z.infer<typeof BuiltinProjectManifestSchema>;

/**
 * Product-owned declaration of one built-in project, tracked in Git. Its content
 * is never committed: `skill` names the published Agent Skill that the build
 * pulls into `content/<targetDir>`, so the shipped project follows the published
 * skill release instead of a hand-copied snapshot.
 */
export const BuiltinProjectSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/),
    /** Path inside the project content directory; defaults to `.agents/skills/<name>`. */
    targetDir: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type BuiltinProjectSkill = z.infer<typeof BuiltinProjectSkillSchema>;

export const BuiltinProjectSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: BuiltinProjectIdSchema,
    name: BuiltinProjectNameSchema,
    localizedNames: BuiltinProjectLocalizedNamesSchema.optional(),
    runtimes: BuiltinProjectRuntimesSchema,
    skill: BuiltinProjectSkillSchema.optional(),
  })
  .strict();
export type BuiltinProjectSource = z.infer<typeof BuiltinProjectSourceSchema>;

/** Safe relative POSIX path for materialized skill content. */
export function builtinProjectSkillTargetDir(skill: BuiltinProjectSkill) {
  const target = skill.targetDir ?? `.agents/skills/${skill.name}`;
  const normalized = target.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw builtinProjectError("BUILTIN_PROJECT_SOURCE_INVALID", `Built-in project skill target is not a safe relative path: ${target}`, { target });
  }
  return segments.join("/");
}

export function readBuiltinProjectSource(root: string) {
  const sourcePath = path.join(root, BUILTIN_PROJECT_SOURCE_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw builtinProjectError(
      "BUILTIN_PROJECT_SOURCE_INVALID",
      `Built-in project source ${sourcePath} could not be read as JSON.`,
      { root, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const source = BuiltinProjectSourceSchema.safeParse(parsed);
  if (!source.success) {
    throw builtinProjectError(
      "BUILTIN_PROJECT_SOURCE_INVALID",
      `Built-in project source ${sourcePath} does not match the current schema.`,
      { root, issues: source.error.issues },
    );
  }
  return source.data;
}

export type BuiltinProjectFile = {
  /** Path relative to the content directory, always POSIX-separated. */
  path: string;
  absolutePath: string;
  mode: number;
  sha256: string;
  bytes: number;
};

export type BuiltinProjectDefinition = {
  id: string;
  name: string;
  localizedNames?: BuiltinProjectLocalizedNames;
  runtimes: BuiltinProjectRuntime[];
  contentDigest: string;
  root: string;
  contentDir: string;
  files: BuiltinProjectFile[];
};

function builtinProjectError(code: string, message: string, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode: 500, ...(details ? { details } : {}) });
}

export function packagedBuiltinProjectsDir() {
  const moduleDir = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
  const candidates = [
    path.resolve(moduleDir, "../../../../../builtin-projects"),
    path.resolve(moduleDir, "../builtin-projects"),
    path.resolve(moduleDir, "../../builtin-projects"),
  ];
  // A candidate only counts as the shipped directory when it actually holds a
  // built-in project, so an unrelated directory that happens to sit at one of
  // the relative offsets of the in-repo layout can never shadow the packaged one.
  return candidates.find(holdsBuiltinProjects)
    || candidates.find((candidate) => fs.existsSync(candidate))
    || candidates[0];
}

/** True when the directory actually contains a built-in project with a manifest. */
export function holdsBuiltinProjects(directory: string) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => (
      entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, BUILTIN_PROJECT_MANIFEST_FILE))
    ));
  } catch {
    return false;
  }
}

/** Walks a content directory and returns every regular file, sorted by path. */
export function listBuiltinProjectFiles(contentDir: string): BuiltinProjectFile[] {
  const files: BuiltinProjectFile[] = [];
  const walk = (relative: string) => {
    const absolute = relative ? path.join(contentDir, relative) : contentDir;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(contentDir, ...childRelative.split("/"));
      const stat = fs.statSync(absolutePath);
      files.push({
        path: childRelative,
        absolutePath,
        mode: stat.mode & 0o777,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
        bytes: stat.size,
      });
    }
  };
  walk("");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Digest over the sorted (path, content hash) pairs of a content directory. Two
 * directories share a digest only when they materialize exactly the same files
 * with the same bytes.
 *
 * Permission bits are deliberately excluded: they are applied from the shipped
 * file at materialization time, and they are not reproducible across packaging
 * environments (a Windows checkout or a mode-stripping archive reports 0666 for
 * every file), so binding them made the digest environment-dependent without
 * protecting anything the file hash does not already cover.
 */
export function builtinProjectContentDigest(files: BuiltinProjectFile[]) {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(`${file.path}\u0000${file.sha256}\n`);
  return hash.digest("hex");
}

export function readBuiltinProjectManifest(root: string) {
  const manifestPath = path.join(root, BUILTIN_PROJECT_MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw builtinProjectError(
      "BUILTIN_PROJECT_MANIFEST_INVALID",
      `Built-in project manifest ${manifestPath} could not be read as JSON.`,
      { root, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const manifest = BuiltinProjectManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    throw builtinProjectError(
      "BUILTIN_PROJECT_MANIFEST_INVALID",
      `Built-in project manifest ${manifestPath} does not match the current schema.`,
      { root, issues: manifest.error.issues },
    );
  }
  return manifest.data;
}

export function loadBuiltinProjectDefinitions(sourceDir = packagedBuiltinProjectsDir()): BuiltinProjectDefinition[] {
  if (!fs.existsSync(sourceDir)) return [];
  const definitions: BuiltinProjectDefinition[] = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const root = path.join(sourceDir, entry.name);
    if (!fs.existsSync(path.join(root, BUILTIN_PROJECT_MANIFEST_FILE))) continue;
    const manifest = readBuiltinProjectManifest(root);
    const contentDir = path.join(root, BUILTIN_PROJECT_CONTENT_DIR);
    if (!fs.existsSync(contentDir)) {
      throw builtinProjectError("BUILTIN_PROJECT_CONTENT_INVALID", `Built-in project ${manifest.id} has no content directory.`, { root });
    }
    const files = listBuiltinProjectFiles(contentDir);
    const actualDigest = builtinProjectContentDigest(files);
    if (actualDigest !== manifest.contentDigest) {
      // A mismatch means the shipped content is not the revision the manifest
      // describes. Never materialize an unverified project.
      throw builtinProjectError(
        "BUILTIN_PROJECT_CONTENT_INVALID",
        `Built-in project ${manifest.id} content does not match its manifest digest.`,
        { root, expected: manifest.contentDigest, actual: actualDigest },
      );
    }
    definitions.push({
      id: manifest.id,
      name: manifest.name,
      ...(manifest.localizedNames ? { localizedNames: manifest.localizedNames } : {}),
      runtimes: manifest.runtimes,
      contentDigest: manifest.contentDigest,
      root,
      contentDir,
      files,
    });
  }
  return definitions;
}
