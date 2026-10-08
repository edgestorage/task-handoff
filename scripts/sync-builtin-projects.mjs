#!/usr/bin/env node
// Materializes the built-in projects that ship with the node agent.
//
// `builtin-projects/<id>/project.json` is the tracked source of truth: it holds
// the product-owned decisions (id, display names, runtimes) and names the
// published Agent Skill the project content comes from. The content directory
// and the generated `manifest.json` are build artifacts and are never committed,
// so a shipped project follows the published skill release instead of a
// hand-copied Git snapshot.
//
// The whole step is gated by the `builtinProjects` feature flag
// (TASK_HANDOFF_BUILTIN_PROJECTS_ENABLED=1). With the flag off nothing is
// materialized and any previously generated content is removed, so a build
// without the flag ships no built-in project and the node agent has nothing to
// offer.
//
// Usage:
//   node scripts/sync-builtin-projects.mjs
//   node scripts/sync-builtin-projects.mjs --projects-dir <dir> --skill-source <dir>
//
// `--skill-source <dir>` copies a local published-skill directory instead of
// downloading the index; it exists for offline and test builds.
// `TASK_HANDOFF_SKILLS_INDEX_URL` overrides the published index, exactly like
// `thctl skill install`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { FEATURE_FLAG_DEFINITIONS, resolveFeatureFlags } = require("../shared/feature-flags.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = await import(pathToFileURL(path.join(root, "packages/control-plane/src/node-agent/builtin-projects/assets.ts")).href);
const skills = await import(pathToFileURL(path.join(root, "apps/thctl/src/skill.ts")).href);

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function projectRoots(projectsDir) {
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsDir, entry.name))
    .sort();
}

/** Removes every artifact this script generates for one project root. */
function pruneProject(projectRoot) {
  fs.rmSync(path.join(projectRoot, assets.BUILTIN_PROJECT_CONTENT_DIR), { recursive: true, force: true });
  fs.rmSync(path.join(projectRoot, assets.BUILTIN_PROJECT_MANIFEST_FILE), { force: true });
}

async function materializeSkillContent({ skill, targetDir, skillSource }) {
  if (skill.name !== skills.SKILL_NAME) {
    throw new Error(`Built-in project declares skill ${skill.name}, but the product publishes only ${skills.SKILL_NAME}.`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (skillSource) {
    const source = path.resolve(skillSource);
    if (!fs.existsSync(path.join(source, skills.SKILL_ENTRY_FILE))) {
      throw new Error(`--skill-source ${source} does not contain ${skills.SKILL_ENTRY_FILE}.`);
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(source, targetDir, { recursive: true });
    return { origin: `${source} (local skill source)` };
  }
  const release = await skills.fetchSkillRelease({ fetchImpl: fetch, env: process.env });
  const files = await skills.downloadSkillReleaseFiles(release, { fetchImpl: fetch });
  for (const file of files) {
    const destination = path.join(targetDir, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content, { mode: 0o644 });
  }
  return { origin: `${release.indexUrl} (skill ${release.entry.name} ${release.entry.version})` };
}

async function main() {
  const projectsDir = path.resolve(argValue("--projects-dir") || path.join(root, "builtin-projects"));
  const skillSource = argValue("--skill-source");
  const enabled = resolveFeatureFlags().builtinProjects;
  const roots = projectRoots(projectsDir);

  if (!enabled) {
    for (const projectRoot of roots) pruneProject(projectRoot);
    console.log(`built-in projects are disabled (${FEATURE_FLAG_DEFINITIONS.builtinProjects.environmentVariable} != 1); nothing is shipped.`);
    return;
  }

  let generated = 0;
  for (const projectRoot of roots) {
    if (!fs.existsSync(path.join(projectRoot, assets.BUILTIN_PROJECT_SOURCE_FILE))) continue;
    const source = assets.readBuiltinProjectSource(projectRoot);
    const contentDir = path.join(projectRoot, assets.BUILTIN_PROJECT_CONTENT_DIR);
    if (source.skill) {
      const targetDir = path.join(contentDir, ...assets.builtinProjectSkillTargetDir(source.skill).split("/"));
      const { origin } = await materializeSkillContent({ skill: source.skill, targetDir, skillSource });
      console.log(`${source.id}: materialized skill ${source.skill.name} from ${origin}`);
    } else if (!fs.existsSync(contentDir)) {
      throw new Error(`Built-in project ${source.id} declares no skill and ships no content directory.`);
    }
    const files = assets.listBuiltinProjectFiles(contentDir);
    // The manifest only binds the product-owned decisions to the exact
    // materialized content, so it is always derived rather than hand-written.
    const manifest = assets.BuiltinProjectManifestSchema.parse({
      schemaVersion: 1,
      id: source.id,
      name: source.name,
      ...(source.localizedNames ? { localizedNames: source.localizedNames } : {}),
      runtimes: source.runtimes,
      contentDigest: assets.builtinProjectContentDigest(files),
    });
    fs.writeFileSync(path.join(projectRoot, assets.BUILTIN_PROJECT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`${source.id}: ${manifest.contentDigest} (${files.length} files)`);
    generated += 1;
  }
  if (!generated) throw new Error(`No built-in project declares a ${assets.BUILTIN_PROJECT_SOURCE_FILE} under ${projectsDir}.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
