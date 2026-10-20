import { RelaySessionGrantSchema, type RelaySessionGrant } from "@task-handoff/cloud-contracts";
import { z } from "zod";
import { JsonFile } from "../../shared/persistence/store.ts";

const PersistedRelaySessionSchema = z.object({
  allocationId: z.string().trim().min(1).max(160),
  relayUrl: z.string().url(),
  epoch: z.number().int().nonnegative(),
  channelKind: z.literal("access"),
  grant: RelaySessionGrantSchema,
}).refine((entry) => entry.allocationId === entry.grant.allocationId, {
  message: "Persisted allocation identity must match its grant.",
  path: ["allocationId"],
});

const PersistedRelaySessionsSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  sessions: z.array(PersistedRelaySessionSchema).max(50_000),
}).refine((state) => new Set(state.sessions.map((entry) => entry.allocationId)).size === state.sessions.length, {
  message: "Persisted Relay sessions must have unique allocations.",
  path: ["sessions"],
});

export type PersistedRelaySession = z.infer<typeof PersistedRelaySessionSchema>;
type PersistedRelaySessions = z.infer<typeof PersistedRelaySessionsSchema>;

/** Protected local state for grants that may outlive the Coordinator connection. */
export class RelaySessionStore {
  private readonly file: JsonFile<PersistedRelaySessions>;
  private readonly clock: () => number;

  constructor(statePath: string, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
    this.file = new JsonFile<PersistedRelaySessions>(statePath, () => this.empty(), {
      schema: PersistedRelaySessionsSchema,
      directoryMode: 0o700,
      fileMode: 0o600,
      rejectInvalid: true,
    });
  }

  load(): PersistedRelaySession[] {
    const current = this.file.get();
    const now = this.clock();
    const sessions = current.sessions.filter((entry) => Date.parse(entry.grant.expiresAt) > now);
    if (sessions.length !== current.sessions.length) this.putAll(sessions);
    return sessions;
  }

  upsert(entry: PersistedRelaySession) {
    const parsed = PersistedRelaySessionSchema.parse(entry);
    const current = this.file.get();
    const sessions = current.sessions.filter((candidate) => candidate.allocationId !== parsed.allocationId);
    sessions.push(parsed);
    this.putAll(sessions);
  }

  remove(allocationId: string) {
    const current = this.file.get();
    const sessions = current.sessions.filter((entry) => entry.allocationId !== allocationId);
    if (sessions.length !== current.sessions.length) this.putAll(sessions);
  }

  clear() {
    const current = this.file.get();
    if (current.sessions.length) this.putAll([]);
  }

  private putAll(sessions: PersistedRelaySession[]) {
    this.file.put({ version: 1, updatedAt: new Date(this.clock()).toISOString(), sessions });
  }

  private empty(): PersistedRelaySessions {
    return { version: 1, updatedAt: new Date(this.clock()).toISOString(), sessions: [] };
  }
}
