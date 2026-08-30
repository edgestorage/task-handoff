import { JsonFile } from "../../shared/persistence/store.ts";
import {
  ControlPlaneProxyAuthoritySchema,
  sanitizeStoredProxyAuthority,
  type ControlPlaneProxyAuthority,
  type ProxyBindingRecord,
} from "./records.ts";

type ProxyStoreLogger = (message: string, details: Record<string, unknown>) => void;

export class ControlPlaneProxyStore {
  private readonly authority: JsonFile<ControlPlaneProxyAuthority>;

  constructor(filePath: string, logger?: ProxyStoreLogger) {
    this.authority = new JsonFile<ControlPlaneProxyAuthority>(filePath, () => ({ revision: 0, invites: [], bindings: [] }), {
      schema: ControlPlaneProxyAuthoritySchema,
      sanitize: (value: unknown) => sanitizeStoredProxyAuthority(
        value,
        (warning) => logger?.("unknown stored control-plane proxy fields were ignored", warning),
      ),
      logger,
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  }

  init() {
    this.authority.init();
    // Compatibility for v0.0.21: sanitize then rewrite once so historical
    // persisted invite hashes and revoked binding tombstones are removed.
    const migrated = this.authority.get();
    this.authority.put(migrated);
  }

  snapshot() {
    return this.authority.get();
  }

  transaction<T>(mutate: (draft: ControlPlaneProxyAuthority) => T): T {
    const current = this.authority.get();
    const draft = structuredClone(current);
    const result = mutate(draft);
    if (JSON.stringify(draft) !== JSON.stringify(current)) {
      this.authority.put({ ...draft, revision: current.revision + 1 });
    }
    return result;
  }

  listBindings(): ProxyBindingRecord[] {
    return this.snapshot().bindings;
  }

  getBinding(id: string) {
    return this.snapshot().bindings.find((binding) => binding.id === id);
  }
}
