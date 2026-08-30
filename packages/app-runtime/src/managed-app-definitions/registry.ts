import { detectManagedApp } from "../managed-apps";
import type { AppCatalogItem, ManagedAppDefinition } from "../types";
import { ccSwitchProvider } from "./cc-switch";
import { chromiumProvider } from "./chromium";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { opencodeProvider } from "./opencode";
import { terminalGuiProvider } from "./terminal-gui";
import { terminalTtyProvider } from "./terminal-tty";
import type { ManagedAppProvider, ManagedAppRegistryOptions } from "./types";
import { vscodeWebProvider } from "./vscode-web";

export class ManagedAppRegistry {
  private readonly providersById: ReadonlyMap<string, ManagedAppProvider>;

  constructor(readonly providers: readonly ManagedAppProvider[]) {
    const providersById = new Map<string, ManagedAppProvider>();
    for (const provider of providers) {
      if (providersById.has(provider.id)) throw new Error(`Duplicate managed app provider id: ${provider.id}`);
      providersById.set(provider.id, provider);
    }
    this.providersById = providersById;
  }

  provider(appId: string) {
    return this.providersById.get(appId);
  }

  runtimeProvider(app: AppCatalogItem) {
    const exact = this.provider(app.id);
    if (exact) return exact;
    const matches = this.providers.filter((provider) => provider.matchesRuntime?.(app));
    if (matches.length > 1) {
      throw new Error(`Multiple managed app providers match runtime for ${app.id}: ${matches.map(({ id }) => id).join(", ")}`);
    }
    return matches[0];
  }

  definitions(options: ManagedAppRegistryOptions = {}): ManagedAppDefinition[] {
    const context = { env: options.env || process.env };
    return this.providers
      .filter((provider) => !provider.optional || options.includeOptional || provider.enabled?.(context))
      .map((provider) => {
        const definition = provider.definition(context);
        if (definition.launcher.id !== provider.id) {
          throw new Error(`Managed app provider ${provider.id} returned launcher id ${definition.launcher.id}`);
        }
        return definition;
      });
  }
}

export function createManagedAppRegistry(providers: readonly ManagedAppProvider[]) {
  return new ManagedAppRegistry(providers);
}

export const builtinManagedAppRegistry = createManagedAppRegistry([
  terminalTtyProvider,
  codexProvider,
  opencodeProvider,
  claudeProvider,
  terminalGuiProvider,
  chromiumProvider,
  vscodeWebProvider,
  ccSwitchProvider,
]);

export function builtinManagedAppDefinitions(options: ManagedAppRegistryOptions = {}) {
  return builtinManagedAppRegistry.definitions(options);
}

export function builtinManagedAppDefinition(appId: string, options: ManagedAppRegistryOptions = {}) {
  return builtinManagedAppDefinitions(options).find((definition) => definition.launcher.id === appId);
}

export function builtinAppCatalog(options: ManagedAppRegistryOptions = {}) {
  return builtinManagedAppDefinitions(options).map((definition) => definition.launcher);
}

export function detectBuiltinManagedApps(options: ManagedAppRegistryOptions = {}) {
  return builtinManagedAppDefinitions(options).map((definition) => ({ definition, detection: detectManagedApp(definition) }));
}

export function publicManagedAppDefinitions(options: ManagedAppRegistryOptions = {}) {
  return builtinManagedAppDefinitions(options).map((definition) => ({
    id: definition.launcher.id,
    name: definition.launcher.name,
    kind: definition.launcher.kind,
    description: definition.launcher.description,
    recipeTypes: [...new Set(definition.distribution.recipes.map((recipe) => recipe.type))],
  }));
}

export const BUILTIN_APP_CATALOG = builtinAppCatalog({ includeOptional: true });
