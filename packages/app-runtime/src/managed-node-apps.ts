import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { resolveExecutable } from "@task-handoff/core/core/executable-resolver";
import { selectInstallRecipe } from "./managed-apps";
import { detectManagedAppRecipeTarget, managedNativeAppLauncher } from "./native-package";
import type { ManagedAppDefinition, ManagedAppRecipeArch, ManagedAppRecipePlatform, ManagedAppRecipeTarget } from "./types";

export function managedNodePackageRoot(root: string, appId: string) {
  return path.join(root, "node-package", appId);
}

export function managedNodePackageBin(root: string, appId: string) {
  return path.join(managedNodePackageRoot(root, appId), "node_modules", ".bin");
}

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  writeFileAtomic.sync(file, content, { mode: 0o700 });
}

function managedTarget(root: string, definition: ManagedAppDefinition, platform: NodeJS.Platform, arch: string, target = detectManagedAppRecipeTarget({ platform })) {
  const selected = selectInstallRecipe(definition, {
    platform: platform as ManagedAppRecipePlatform,
    arch: arch as ManagedAppRecipeArch,
    installers: ["apt", "dnf", "brew", "npm"],
    privilege: "root",
  }, target).recipe;
  if (selected?.type === "native-package") return managedNativeAppLauncher(root, definition.launcher.id, selected.launchPath);
  if (selected?.type === "node-package" && selected.managed) return path.join(managedNodePackageBin(root, definition.launcher.id), definition.launcher.id);
  return undefined;
}

export function managedAppLauncherPath(
  root: string,
  definition: ManagedAppDefinition,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  target: ManagedAppRecipeTarget = detectManagedAppRecipeTarget({ platform }),
) {
  return managedTarget(root, definition, platform, arch, target);
}

/** Private launch projection, derived from the registry; never installs or adopts host packages. */
export class ManagedApps {
  readonly definitions: ManagedAppDefinition[];
  readonly bin: string;

  constructor(readonly root: string, definitions: ManagedAppDefinition[]) {
    this.definitions = definitions.filter((definition) => definition.distribution.recipes.some((recipe) => recipe.type === "native-package" || (recipe.type === "node-package" && recipe.managed)));
    this.bin = path.join(root, "bin");
  }

  contains(appId: string) {
    return this.definitions.some((definition) => definition.launcher.id === appId);
  }

  target(appId: string) {
    const definition = this.definitions.find((entry) => entry.launcher.id === appId);
    return definition ? managedTarget(this.root, definition, process.platform, process.arch) : undefined;
  }

  private materializeCommands() {
    for (const definition of this.definitions) {
      const { launcher } = definition;
      const target = managedTarget(this.root, definition, process.platform, process.arch);
      if (!target) continue;
      const message = `${launcher.name} is not installed in this instance. Install it from app management.`;
      const environment = Object.entries(launcher.env || {}).map(([name, value]) => `export ${name}=${quote(value!)}`).join("\n");
      // A permanent entry for every managed command prevents PATH from falling through to a
      // user's installation before install or after uninstall. npm's own bins remain private.
      write(path.join(this.bin, launcher.id), `#!/bin/sh\nif [ ! -x ${quote(target)} ]; then\n  printf '%s\\n' ${quote(message)} >&2\n  exit 127\nfi\n${environment}\nexec ${quote(target)} "$@"\n`);
      if (process.platform === "win32") {
        const executable = target.toLowerCase().endsWith(".exe") ? target : `${target}.cmd`;
        write(path.join(this.bin, `${launcher.id}.cmd`), `@echo off\r\nif not exist "${executable}" (\r\n  echo ${message} 1>&2\r\n  exit /b 127\r\n)\r\n${Object.entries(launcher.env || {}).map(([name, value]) => `set "${name}=${value}"`).join("\r\n")}\r\n${executable.toLowerCase().endsWith(".exe") ? `"${executable}"` : `call "${executable}"`} %*\r\n`);
      }
    }
  }

  environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    this.materializeCommands();
    const normalized = { ...base };
    if (process.platform === "win32") {
      const key = Object.keys(normalized).find((name) => name.toUpperCase() === "PATH");
      if (key && key !== "PATH") { normalized.PATH = normalized.PATH || normalized[key]; delete normalized[key]; }
    }
    const needsNode = this.definitions.some((definition) => definition.distribution.recipes.some((recipe) => recipe.type === "node-package" && recipe.managed));
    const node = needsNode ? resolveExecutable("node", { env: normalized }) : undefined;
    const env = { ...normalized, ...node?.env };
    return { ...env, PATH: [...new Set([this.bin, ...(node ? [path.dirname(node.executable)] : []), ...(env.PATH || "").split(path.delimiter)].filter(Boolean))].join(path.delimiter) };
  }

  terminalEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform === "win32") return this.environment(base);
    const command = base.TASK_HANDOFF_SHELL_COMMAND || base.SHELL || "/bin/sh";
    const prepared = this.prepareShell(command, [], base);
    const wrapper = path.join(this.root, "shell", "interactive");
    const exports = ["BASH_ENV", "ENV", "ZDOTDIR", "TASK_HANDOFF_SHELL_USER_ZDOTDIR"]
      .filter((name) => prepared.env[name] !== undefined)
      .map((name) => `export ${name}=${quote(prepared.env[name]!)}`).join("\n");
    write(wrapper, `#!/bin/sh\n${exports}\nexec ${quote(command)} ${prepared.args.map(quote).join(" ")} "$@"\n`);
    return { ...prepared.env, SHELL: wrapper, TASK_HANDOFF_SHELL_COMMAND: command };
  }

  prepareShell(command: string, args: string[], base: NodeJS.ProcessEnv) {
    const env = this.environment(base);
    const name = path.basename(command).toLowerCase().replace(/\.exe$/, "");
    const shellDir = path.join(this.root, "shell");
    const node = this.definitions.some((definition) => definition.distribution.recipes.some((recipe) => recipe.type === "node-package" && recipe.managed))
      ? resolveExecutable("node", { env })
      : undefined;
    const prefix = [this.bin, ...(node ? [path.dirname(node.executable)] : [])].join(path.delimiter);
    const restore = `export PATH=${quote(prefix)}:"$PATH"\n${this.definitions.map(({ launcher }) => `unalias ${launcher.id} 2>/dev/null || :\nunset -f ${launcher.id} 2>/dev/null || :`).join("\n")}\n`;
    // Shell-specific startup hooks preserve user initialization, then restore the managed
    // command boundary. No general shell library exposes these startup-file contracts.
    if (name === "cmd") return { args: ["/D", ...args], env };
    if (["powershell", "pwsh"].includes(name)) {
      const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const restore = `$env:PATH = ${psQuote(prefix)} + [IO.Path]::PathSeparator + $env:PATH; ${this.definitions.map(({ launcher }) => `Remove-Item -LiteralPath 'Alias:${launcher.id}','Function:${launcher.id}' -ErrorAction SilentlyContinue;`).join(" ")}`;
      const command = args.findIndex((arg) => ["-command", "-c"].includes(arg.toLowerCase()));
      if (command >= 0 && args[command + 1]) return { args: [...args.slice(0, command + 1), `${restore} ${args[command + 1]}`, ...args.slice(command + 2)], env };
      const file = args.findIndex((arg) => ["-file", "-f"].includes(arg.toLowerCase()));
      if (file >= 0 && args[file + 1]) return { args: [...args.slice(0, file), "-Command", `${restore} & ${args.slice(file + 1).map(psQuote).join(" ")}`], env };
      return { args: ["-NoExit", ...args, "-Command", restore], env };
    }
    if (name === "bash") {
      const rc = path.join(shellDir, "bashrc");
      write(rc, `if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n${restore}`);
      const nonInteractive = path.join(shellDir, "bash-env");
      write(nonInteractive, restore);
      return { args: ["--rcfile", rc, ...args], env: { ...env, BASH_ENV: nonInteractive } };
    }
    if (name === "zsh") {
      const original = base.TASK_HANDOFF_SHELL_USER_ZDOTDIR || base.ZDOTDIR || base.HOME || "";
      const zdot = path.join(shellDir, "zsh");
      for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
        write(path.join(zdot, file), `if [ -f ${quote(path.join(original, file))} ]; then . ${quote(path.join(original, file))}; fi\nexport ZDOTDIR=${quote(zdot)}\n${restore}`);
      }
      return { args, env: { ...env, ZDOTDIR: zdot, TASK_HANDOFF_SHELL_USER_ZDOTDIR: original } };
    }
    if (name === "fish") {
      return { args: ["--init-command", `set -gx PATH ${[this.bin, ...(node ? [path.dirname(node.executable)] : [])].map(quote).join(" ")} $PATH; ${this.definitions.map(({ launcher }) => `functions -e ${launcher.id};`).join(" ")}`, ...args], env };
    }
    if (["sh", "dash", "ksh"].includes(name)) {
      const rc = path.join(shellDir, "sh-env");
      const original = base.ENV && base.ENV !== rc ? `if [ -f ${quote(base.ENV)} ]; then . ${quote(base.ENV)}; fi\n` : "";
      write(rc, `${original}${restore}`);
      return { args, env: { ...env, ENV: rc } };
    }
    return { args, env };
  }
}

export { ManagedApps as ManagedNodeApps };
