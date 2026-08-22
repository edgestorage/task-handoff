import { NodeSchema, type Node } from "@task-handoff/protocol/control-plane";
import crypto from "node:crypto";
import { z } from "zod";
import { createId, createSecret, type JsonCollection } from "../../shared/persistence/store.ts";
import { CreateNodeJoinInviteInputSchema } from "../application/inputs.ts";
import { now } from "../application/helpers.ts";
import { EphemeralTokenStore } from "../../shared/security/ephemeral-token-store.ts";

const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const COMPLETED_INVITE_STATUS_TTL_MS = 10 * 60 * 1000;

type NodeJoinInvite = {
  id: string;
  tokenHash: string;
  expiresAt: string;
  nodeName?: string;
};

const CompleteNodeJoinInputSchema = z.object({
  joinToken: z.string().trim().min(1).max(4096),
  nodeId: NodeSchema.shape.id,
  nodeName: NodeSchema.shape.name.optional(),
  keyId: z.string().trim().min(1).max(160),
  secret: z.string().trim().min(1).max(4096),
  pairedAt: z.string().datetime().optional(),
}).strict();

type NodeJoinServiceOptions = {
  nodes: JsonCollection<Node>;
};

export class NodeJoinService {
  private readonly options: NodeJoinServiceOptions;
  private readonly invites = new EphemeralTokenStore<NodeJoinInvite>();
  private readonly completedInvites = new EphemeralTokenStore<{ nodeId: string; expiresAt: string }>();

  constructor(options: NodeJoinServiceOptions) {
    this.options = options;
  }

  createInvite(input: unknown = {}) {
    const parsedInput = CreateNodeJoinInviteInputSchema.parse(input && typeof input === "object" ? input : {});
    const token = createSecret();
    const invite: NodeJoinInvite = {
      id: createId("node_join"),
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + (parsedInput.expiresInMs || DEFAULT_INVITE_TTL_MS)).toISOString(),
      ...(parsedInput.nodeName ? { nodeName: parsedInput.nodeName } : {}),
    };
    this.invites.put(invite.tokenHash, invite);
    return { id: invite.id, joinToken: token, expiresAt: invite.expiresAt };
  }

  status(id: string) {
    const completed = this.completedInvites.peek(id);
    if (completed) return { id, status: "completed" as const, nodeId: completed.nodeId };
    if (this.invites.list().some((invite) => invite.id === id)) return { id, status: "pending" as const };
    throw Object.assign(new Error(`Node join invite ${id} was not found or has expired.`), {
      statusCode: 404,
      code: "NODE_JOIN_INVITE_NOT_FOUND",
    });
  }

  complete(input: unknown) {
    const parsedInput = CompleteNodeJoinInputSchema.parse(input);
    const tokenHash = hashToken(parsedInput.joinToken);
    const invite = this.invites.take(tokenHash);
    if (!invite) {
      throw Object.assign(new Error("Node join token is invalid or expired."), {
        statusCode: 401,
        code: "NODE_JOIN_TOKEN_INVALID",
      });
    }

    // A valid invite is single-use even when the requested node identity conflicts.
    const timestamp = now();
    if (this.options.nodes.get(parsedInput.nodeId)) {
      throw Object.assign(new Error(`Node ${parsedInput.nodeId} already exists in this control-plane.`), {
        statusCode: 409,
        code: "NODE_JOIN_NODE_ALREADY_EXISTS",
      });
    }
    const node = this.options.nodes.put(NodeSchema.parse({
      id: parsedInput.nodeId,
      name: parsedInput.nodeName || invite.nodeName || parsedInput.nodeId,
      connectionMode: "reverse-wss",
      auth: {
        mode: "paired-hmac",
        keyId: parsedInput.keyId,
        secret: parsedInput.secret,
        pairedAt: parsedInput.pairedAt || timestamp,
        pairing: { status: "paired" },
      },
      status: "unknown",
      health: "unknown",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    this.completedInvites.put(invite.id, {
      nodeId: node.id,
      expiresAt: new Date(Date.now() + COMPLETED_INVITE_STATUS_TTL_MS).toISOString(),
    });
    return { node, inviteId: invite.id };
  }

}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
