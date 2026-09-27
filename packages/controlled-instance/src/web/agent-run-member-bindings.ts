import path from "node:path";
import { z } from "zod";
import { DomainStore } from "@task-handoff/core/storage/domain-store";

const BindingSchema = z.object({
  runId: z.string().trim().min(1).max(120),
  memberId: z.string().trim().min(1).max(120),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
}).strip();

const StoreSchema = z.object({
  version: z.literal(1),
  bindings: z.array(BindingSchema).max(10_000),
}).strip();

export type AgentRunMemberBinding = z.infer<typeof BindingSchema>;

export class AgentRunMemberBindingStore {
  private readonly store: DomainStore<z.infer<typeof StoreSchema>>;
  private state: z.infer<typeof StoreSchema>;

  constructor(runtimeDir: string) {
    this.store = new DomainStore(path.join(runtimeDir, "agent-run-member-bindings.json"), {
      schema: StoreSchema,
      defaultValue: () => ({ version: 1, bindings: [] }),
      sanitize: (value) => {
        const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        return { version: 1, bindings: Array.isArray(source.bindings) ? source.bindings : [] };
      },
    });
    this.state = this.store.load();
  }

  list() {
    return this.state.bindings.map((binding) => ({ ...binding }));
  }

  get(runId: string, memberId: string) {
    const binding = this.state.bindings.find((candidate) => candidate.runId === runId && candidate.memberId === memberId);
    return binding ? { ...binding } : undefined;
  }

  getBySession(aiSessionId: string) {
    const binding = this.state.bindings.find((candidate) => candidate.aiSessionId === aiSessionId);
    return binding ? { ...binding } : undefined;
  }

  bind(input: Omit<AgentRunMemberBinding, "createdAt" | "closedAt">, timestamp = new Date().toISOString()) {
    const existing = this.get(input.runId, input.memberId) || this.getBySession(input.aiSessionId);
    if (existing) {
      if (existing.runId === input.runId
        && existing.memberId === input.memberId
        && existing.aiSessionId === input.aiSessionId
        && existing.providerSessionId === input.providerSessionId) return existing;
      throw Object.assign(new Error("The AI Session is already bound to another Agent Run member."), {
        code: "AGENT_RUN_MEMBER_SESSION_CONFLICT",
        statusCode: 409,
      });
    }
    const binding = BindingSchema.parse({ ...input, createdAt: timestamp });
    this.state = { ...this.state, bindings: [...this.state.bindings, binding] };
    this.store.save(this.state);
    return { ...binding };
  }

  close(runId: string, memberId: string, timestamp = new Date().toISOString()) {
    const index = this.state.bindings.findIndex((candidate) => candidate.runId === runId && candidate.memberId === memberId);
    if (index < 0) return undefined;
    const current = this.state.bindings[index]!;
    if (current.closedAt) return { ...current };
    const binding = BindingSchema.parse({ ...current, closedAt: timestamp });
    const bindings = [...this.state.bindings];
    bindings[index] = binding;
    this.state = { ...this.state, bindings };
    this.store.save(this.state);
    return { ...binding };
  }
}
