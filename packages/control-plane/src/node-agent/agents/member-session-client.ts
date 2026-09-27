import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import {
  AgentRunMemberInstanceCloseResultSchema,
  AgentRunMemberInstanceCreateInputSchema,
  AgentRunMemberInstanceCreateResultSchema,
  AgentRunMemberInstanceStatusSchema,
  AgentRunInstanceProbeStateSchema,
  type AgentRunMemberInstanceCreateInput,
} from "@task-handoff/protocol/agent-run-instance";

function clientError(code: string, message: string, statusCode: number, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, statusCode });
}

export class AgentRunMemberSessionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>;

  constructor(
    fetchImpl: typeof fetch,
    resolveInstanceWeb: (instance: ControlledInstance) => Promise<string>,
  ) {
    this.fetchImpl = fetchImpl;
    this.resolveInstanceWeb = resolveInstanceWeb;
  }

  async create(instance: ControlledInstance, input: AgentRunMemberInstanceCreateInput) {
    return AgentRunMemberInstanceCreateResultSchema.parse(await this.request(
      instance,
      "/api/internal/node-agent/agent-runs/members",
      { method: "POST", body: AgentRunMemberInstanceCreateInputSchema.parse(input) },
    ));
  }

  async status(instance: ControlledInstance, runId: string, memberId: string) {
    return AgentRunMemberInstanceStatusSchema.parse(await this.request(
      instance,
      `/api/internal/node-agent/agent-runs/${encodeURIComponent(runId)}/members/${encodeURIComponent(memberId)}`,
      { method: "GET" },
    ));
  }

  async close(instance: ControlledInstance, runId: string, memberId: string) {
    return AgentRunMemberInstanceCloseResultSchema.parse(await this.request(
      instance,
      `/api/internal/node-agent/agent-runs/${encodeURIComponent(runId)}/members/${encodeURIComponent(memberId)}/close`,
      { method: "POST", body: {} },
    ));
  }

  async probeState(instance: ControlledInstance) {
    return AgentRunInstanceProbeStateSchema.parse(await this.request(
      instance,
      "/api/internal/node-agent/agent-runs/probe-state",
      { method: "GET" },
    ));
  }

  private async request(instance: ControlledInstance, route: string, input: { method: "GET" | "POST"; body?: unknown }) {
    if (!instance.registrationToken) {
      throw clientError("AGENT_RUN_INSTANCE_CREDENTIAL_MISSING", "Target instance has no registration credential.", 503);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${await this.resolveInstanceWeb(instance)}${route}`, {
        method: input.method,
        headers: { authorization: `Bearer ${instance.registrationToken}`, "content-type": "application/json" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch (cause) {
      throw clientError("AGENT_RUN_INSTANCE_UNAVAILABLE", "Target instance is temporarily unavailable.", 503, cause);
    }
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw clientError(
        payload.error?.code || "AGENT_RUN_INSTANCE_REQUEST_FAILED",
        payload.error?.message || `Target instance returned HTTP ${response.status}.`,
        response.status,
      );
    }
    return payload.data;
  }
}
