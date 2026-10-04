import { installedCliVersion } from "../client-info.ts";
import { CLI_EXIT_CODES, ThctlError } from "../errors.ts";
import { requireConfirmation, type CliContext, type CliInvocation } from "../runtime.ts";
import {
  SKILL_NAME,
  applySkillRelease,
  assertSkillCompatibility,
  downloadSkillReleaseFiles,
  fetchSkillRelease,
  findLegacySkillDirectories,
  inspectSkillDirectory,
  skillNeedsUpdate,
  resolveSkillTarget,
  resolveSkillTargets,
  satisfiesSkillRange,
  type InstalledSkill,
  type SkillRelease,
  type SkillTarget,
} from "../skill.ts";

function optionValue(invocation: CliInvocation, key: string) {
  const value = invocation.options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function targetOptions(invocation: CliInvocation) {
  return { scope: optionValue(invocation, "scope"), dir: optionValue(invocation, "dir") };
}

function loadRelease(context: CliContext) {
  return fetchSkillRelease({ fetchImpl: context.fetchImpl, env: context.env, timeoutMs: 5000 });
}

type SkillStatusRow = {
  scope: string;
  directory: string;
  status: string;
  version?: string;
  latestVersion?: string;
  managed?: boolean;
  modified?: boolean | null;
  command?: string;
};

function summarizeTarget(
  target: SkillTarget,
  installed: InstalledSkill,
  release: SkillRelease | undefined,
  cliVersion: string,
  targetFlag: string,
): SkillStatusRow {
  const compatible = release ? satisfiesSkillRange(cliVersion, release.entry.thctl) : undefined;
  const updatable = release !== undefined && installed.exists && skillNeedsUpdate(installed, release.entry);
  let status: string;
  let command: string | undefined;
  if (!installed.exists) {
    status = "not-installed";
    command = `thctl skill install ${targetFlag}`;
  } else if (installed.managed && installed.modified) {
    status = "local-modified";
    command = `thctl skill update ${targetFlag} --force`;
  } else if (updatable && compatible === false) {
    status = "cli-too-old";
    command = "npm install -g @task-handoff/thctl@latest";
  } else if (updatable) {
    status = "update-available";
    command = `thctl skill update ${targetFlag}`;
  } else if (release) {
    status = "current";
  } else {
    status = "unknown";
  }
  return {
    scope: target.scope,
    directory: target.directory,
    status,
    ...(installed.version ? { version: installed.version } : {}),
    ...(release ? { latestVersion: release.entry.version } : {}),
    ...(installed.exists ? { managed: installed.managed, modified: installed.modified } : {}),
    ...(command ? { command } : {}),
  };
}

export async function skillStatus(context: CliContext, invocation: CliInvocation) {
  const options = targetOptions(invocation);
  const explicit = Boolean(options.dir || options.scope);
  const targets = resolveSkillTargets(process.cwd(), options);
  const targetFlag = (target: SkillTarget) => options.dir ? `--dir ${target.root}` : `--scope ${target.scope}`;
  const cliVersion = installedCliVersion();
  let release: SkillRelease | undefined;
  let indexError: string | undefined;
  try {
    release = await loadRelease(context);
  } catch (error) {
    indexError = error instanceof Error ? error.message : String(error);
  }
  const rows: SkillStatusRow[] = [];
  for (const target of targets) {
    const installed = inspectSkillDirectory(target.directory);
    const legacy = findLegacySkillDirectories(target.root);
    if (!explicit && !installed.exists && legacy.length === 0) continue;
    rows.push(summarizeTarget(target, installed, release, cliVersion, targetFlag(target)));
    for (const directory of legacy) {
      const legacyInstalled = inspectSkillDirectory(directory);
      rows.push({
        scope: target.scope,
        directory,
        status: "legacy-name",
        ...(legacyInstalled.version ? { version: legacyInstalled.version } : {}),
        ...(release ? { latestVersion: release.entry.version } : {}),
        command: `thctl skill install ${targetFlag(target)}`,
      });
    }
  }
  if (indexError) context.output.warn(`Skill index is unavailable: ${indexError}`);
  if (rows.length === 0) {
    return { data: [], message: `Skill \`${SKILL_NAME}\` is not installed. Install it with \`thctl skill install\`.` };
  }
  return {
    data: rows,
    columns: [
      { key: "scope", header: "scope" },
      { key: "status", header: "status" },
      { key: "version", header: "version" },
      { key: "latestVersion", header: "latest" },
      { key: "directory", header: "directory", width: 48 },
    ],
  };
}

export async function skillInstall(context: CliContext, invocation: CliInvocation) {
  const target = resolveSkillTarget(process.cwd(), targetOptions(invocation));
  const existing = inspectSkillDirectory(target.directory);
  if (existing.exists) {
    throw new ThctlError(
      "CLI_SKILL_ALREADY_INSTALLED",
      `Skill \`${SKILL_NAME}\` is already installed at ${target.directory}${existing.version ? ` (v${existing.version})` : ""}. Run \`thctl skill update\`.`,
      CLI_EXIT_CODES.conflict,
      { directory: target.directory },
    );
  }
  const release = await loadRelease(context);
  const cliVersion = installedCliVersion();
  assertSkillCompatibility(release.entry, cliVersion);
  const files = await downloadSkillReleaseFiles(release, { fetchImpl: context.fetchImpl });
  if (context.dryRun) {
    return {
      data: { dryRun: true, name: SKILL_NAME, version: release.entry.version, directory: target.directory, files: release.entry.files },
      message: `Would install skill \`${SKILL_NAME}\` ${release.entry.version} to ${target.directory}.`,
    };
  }
  await requireConfirmation(context, "skill install", `Install skill \`${SKILL_NAME}\` ${release.entry.version} to ${target.directory}?`);
  const provenance = applySkillRelease({ target, release, files, cliVersion });
  return {
    data: {
      name: SKILL_NAME,
      version: provenance.version,
      scope: target.scope,
      directory: target.directory,
      files: release.entry.files,
      verified: provenance.verified === true,
    },
    message: `Installed skill \`${SKILL_NAME}\` ${provenance.version} to ${target.directory}.${legacyNote(target)}`,
  };
}

export async function skillUpdate(context: CliContext, invocation: CliInvocation) {
  const target = resolveSkillTarget(process.cwd(), targetOptions(invocation));
  const existing = inspectSkillDirectory(target.directory);
  if (!existing.exists) {
    const legacy = findLegacySkillDirectories(target.root);
    const legacyHint = legacy.length ? ` Found legacy directories: ${legacy.join(", ")}; run \`thctl skill install\` and remove them after verifying.` : "";
    throw new ThctlError(
      "CLI_SKILL_NOT_INSTALLED",
      `Skill \`${SKILL_NAME}\` is not installed at ${target.directory}. Run \`thctl skill install\`.${legacyHint}`,
      CLI_EXIT_CODES.notFound,
      { directory: target.directory },
    );
  }
  const force = invocation.options.force === true;
  if (existing.managed && existing.modified && !force) {
    throw new ThctlError(
      "CLI_SKILL_LOCALLY_MODIFIED",
      `Skill \`${SKILL_NAME}\` at ${target.directory} has local modifications. Re-run with --force to replace it, or keep the local copy.`,
      CLI_EXIT_CODES.conflict,
      { directory: target.directory },
    );
  }
  const release = await loadRelease(context);
  const cliVersion = installedCliVersion();
  assertSkillCompatibility(release.entry, cliVersion);
  if (existing.managed && !skillNeedsUpdate(existing, release.entry) && !force) {
    return {
      data: { name: SKILL_NAME, version: existing.version, directory: target.directory, updated: false },
      message: `Skill \`${SKILL_NAME}\` is already at ${existing.version ?? "the published release"}; nothing to do.`,
    };
  }
  const files = await downloadSkillReleaseFiles(release, { fetchImpl: context.fetchImpl });
  if (context.dryRun) {
    return {
      data: {
        dryRun: true,
        name: SKILL_NAME,
        from: existing.version,
        to: release.entry.version,
        directory: target.directory,
        files: release.entry.files,
      },
      message: `Would update skill \`${SKILL_NAME}\` ${existing.version ?? "unknown"} → ${release.entry.version} at ${target.directory}.`,
    };
  }
  await requireConfirmation(context, "skill update", `Update skill \`${SKILL_NAME}\` ${existing.version ?? "unknown"} → ${release.entry.version} at ${target.directory}?`);
  const provenance = applySkillRelease({ target, release, files, cliVersion });
  return {
    data: {
      name: SKILL_NAME,
      from: existing.version,
      version: provenance.version,
      scope: target.scope,
      directory: target.directory,
      files: release.entry.files,
      verified: provenance.verified === true,
    },
    message: `Updated skill \`${SKILL_NAME}\` to ${provenance.version} at ${target.directory}.${legacyNote(target)}`,
  };
}

function legacyNote(target: SkillTarget) {
  const legacy = findLegacySkillDirectories(target.root);
  return legacy.length ? ` Legacy skill directories remain: ${legacy.join(", ")}; remove them after verifying the new copy.` : "";
}
