import { NodeSchema, type Node } from "@task-handoff/protocol/control-plane";
import crypto from "node:crypto";
import { z } from "zod";
import { createId, createSecret, type JsonCollection, type StoredRecord } from "../../shared/persistence/store.ts";
import { CreateNodeJoinInviteInputSchema } from "../application/inputs.ts";
import { now } from "../application/helpers.ts";

const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;

export type NodeJoinInvite = StoredRecord & {
  tokenHash: string;
  expiresAt: string;
  nodeName?: string;
};

export const NodeJoinInviteSchema = z.object({
  id: z.string().trim().min(1),
  tokenHash: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  nodeName: z.string().trim().min(1).max(160).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const CompleteNodeJoinInputSchema = z.object({
  joinToken: z.string().trim().min(1).max(4096),
  nodeId: NodeSchema.shape.id,
  nodeName: NodeSchema.shape.name.optional(),
  keyId: z.string().trim().min(1).max(160),
  secret: z.string().trim().min(1).max(4096),
  pairedAt: z.string().datetime().optional(),
}).strict();

type NodeJoinServiceOptions = {
  invites: JsonCollection<NodeJoinInvite>;
  nodes: JsonCollection<Node>;
};

export class NodeJoinService {
  private readonly options: NodeJoinServiceOptions;

  constructor(options: NodeJoinServiceOptions) {
    this.options = options;
  }

  createInvite(input: unknown = {}) {
    this.pruneExpiredInvites();
    const parsedInput = CreateNodeJoinInviteInputSchema.parse(input && typeof input === "object" ? input : {});
    const timestamp = now();
    const token = createSecret();
    const invite: NodeJoinInvite = {
      id: createId("node_join"),
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + (parsedInput.expiresInMs || DEFAULT_INVITE_TTL_MS)).toISOString(),
      ...(parsedInput.nodeName ? { nodeName: parsedInput.nodeName } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.options.invites.put(invite);
    return { id: invite.id, joinToken: token, expiresAt: invite.expiresAt };
  }

  complete(input: unknown) {
    this.pruneExpiredInvites();
    const parsedInput = CompleteNodeJoinInputSchema.parse(input);
    const tokenHash = hashToken(parsedInput.joinToken);
    const invite = this.options.invites.list().find((candidate) =>
      candidate.tokenHash === tokenHash && Date.parse(candidate.expiresAt) > Date.now());
    if (!invite) {
      throw Object.assign(new Error("Node join token is invalid or expired."), {
        statusCode: 401,
        code: "NODE_JOIN_TOKEN_INVALID",
      });
    }

    // A valid invite is single-use even when the requested node identity conflicts.
    this.options.invites.delete(invite.id);
    const timestamp = now();
    if (this.options.nodes.get(parsedInput.nodeId)) {
      throw Object.assign(new Error(`Node ${parsedInput.nodeId} already exists in this control-plane.`), {
        statusCode: 409,
        code: "NODE_JOIN_NODE_ALREADY_EXISTS",
      });
    }
    return this.options.nodes.put(NodeSchema.parse({
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
  }

  private pruneExpiredInvites() {
    const timestamp = Date.now();
    for (const invite of this.options.invites.list()) {
      if (Date.parse(invite.expiresAt) <= timestamp) this.options.invites.delete(invite.id);
    }
  }
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
