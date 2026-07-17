import type { ManagedAppDefinition } from "../types";

export type ManagedAppProviderContext = {
  env: NodeJS.ProcessEnv;
};

export type ManagedAppProviderCapabilities = {
  supportsCwdSelection?: boolean;
};

export interface ManagedAppProvider {
  readonly id: string;
  readonly optional?: boolean;
  readonly capabilities?: ManagedAppProviderCapabilities;
  enabled?(context: ManagedAppProviderContext): boolean;
  definition(context: ManagedAppProviderContext): ManagedAppDefinition;
}

export type ManagedAppRegistryOptions = {
  includeOptional?: boolean;
  env?: NodeJS.ProcessEnv;
};
