import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import type { AccessRepository } from "../persistence/access-repository.ts";
import { createNodeAgentRepository } from "../persistence/repository.ts";
import { openNodeAgentDatabaseSync } from "../persistence/database.ts";
import type { NodeAgentIdentity } from "./types.ts";
import { nowIso as now } from "@task-handoff/core/core/time";
import { normalizeNodeAgentIdentity, type IdentityStoreLogger } from "./normalize.ts";

function defaultLogger(message: string, details: Record<string, unknown>) {
  console.warn(JSON.stringify({ message, ...details }));
}

export class NodeAgentIdentityStore {
  private readonly repository: AccessRepository;
  private readonly logger: IdentityStoreLogger;

  constructor(paths: NodeAgentStorePaths, repositoryOrOptions?: AccessRepository | { logger?: IdentityStoreLogger }, options: { logger?: IdentityStoreLogger } = {}) {
    const repository = repositoryOrOptions && "readIdentity" in repositoryOrOptions ? repositoryOrOptions : undefined;
    const resolvedOptions: { logger?: IdentityStoreLogger } = repository
      ? options
      : (repositoryOrOptions as { logger?: IdentityStoreLogger } | undefined) || options;
    this.repository = repository || createNodeAgentRepository(openNodeAgentDatabaseSync(paths)).access;
    this.logger = resolvedOptions.logger || defaultLogger;
  }

  read() {
    const record = this.repository.readIdentity();
    return record ? normalizeNodeAgentIdentity(record, this.logger) : undefined;
  }

  init() {}

  write(identity: NodeAgentIdentity) {
    const normalized = normalizeNodeAgentIdentity({ ...identity, updatedAt: now() }, this.logger);
    return this.repository.writeIdentity(normalized);
  }
}
