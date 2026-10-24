import crypto from "node:crypto";
import {
  NODE_RELAY_ADAPTIVE_SELECTION_UNSUPPORTED_CODE,
  NodeRelayAllocationResponseSchema,
  NodeRelayClaimGrantSchema,
  NodeRelayBindingRedemptionSchema,
  NodeRelayCredentialSchema,
  NodeRelayNodeAllocationSchema,
  NodeRelayProbeTargetsResponseSchema,
  OfficialAudience,
  OUTBOUND_CONNECTION_PROTOCOL_VERSION,
  RELAY_FRAMING_PROTOCOL_VERSION,
  canonicalJson,
} from "@task-handoff/cloud-contracts";
import {
  EncryptedNodeRelayChannel,
  NODE_RELAY_DIRECTION_CONTROL_PLANE,
  NODE_RELAY_DIRECTION_NODE,
  acceptNodeRelayHandshake,
  nodeRelayFingerprint,
  type NodeRelayFrameSocket,
} from "../../src/shared/cloud-relay/node-relay-session.ts";
import { NODE_RELAY_MAIN_STREAM_ID, type NodeRelayDataFrame } from "@task-handoff/protocol/node-relay-channel";
import { linkedFrameSockets, ed25519Identity, type InMemoryFrameSocket } from "./cloud-relay-node-harness.ts";

/** Signs cloud capabilities exactly like the Coordinator's SignedCapabilityKeyring. */
export function cloudSigningKey(issuerId = "cloud_issuer", kid = "cloud_signing_key_1") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    kid,
    publicKey: String((publicKey.export({ format: "jwk" }) as { x: string }).x),
    sign(purpose: string, payload: unknown) {
      const protectedHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", kid, issuer: issuerId, purpose })).toString("base64url");
      const body = Buffer.from(canonicalJson(payload)).toString("base64url");
      return `${issuerId}.${protectedHeader}.${crypto.sign(null, Buffer.from(`${protectedHeader}.${body}`), privateKey).toString("base64url")}`;
    },
  };
}

export type CloudClaim = {
  controlPlaneId: string;
  controlPlanePublicKey: string;
  accountId?: string;
  ownerAccountId?: string;
  accessMode?: "owner" | "shared";
  shareGrantId?: string;
  shareRevision?: number;
  shareRole?: "use";
  bindingId?: string;
  bindingRevision?: number;
  displayName?: string;
};

/**
 * In-process stand-in for the Coordinator's node API: binding tokens, account
 * redemption, credential lifecycle, claim authorizations and allocation
 * issuance, all schema-validated against the shared contracts.
 */
export function cloudRelayCloudStub(options: { serviceOrigin: string; token?: string; accountId?: string; nodeHandle?: string }) {
  const serviceOrigin = new URL(options.serviceOrigin).origin;
  const signingKey = cloudSigningKey();
  const state = {
    bindingToken: options.token ?? "thnb_test_binding_token_000000000000",
    redeemed: false,
    credential: "thnc_test_credential_000000000000",
    credentialExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    credentialRejected: false,
    registryRevoked: false,
    unreachable: false,
    unbinds: 0,
    redemptions: [] as Array<{ nodeId?: string; displayName?: string }>,
    allocationRequests: [] as Array<{ controlPlaneId?: string; refreshControlPlaneIds?: string[] }>,
    ignoreRefresh: false,
    adaptiveSelection: false,
    failAdaptiveAllocations: false,
    probeTargetFailure: undefined as { status: number; code: string; message?: string } | undefined,
    probeTargetRequests: [] as Array<{ nodeId?: string; controlPlaneIds?: string[] }>,
    allocationV2Requests: [] as Array<{ controlPlaneId?: string; refreshControlPlaneIds?: string[]; probeEvidence?: any }>,
    probeTargets: undefined as Array<{ relayId: string; relayUrl: string }> | undefined,
    relayByControlPlane: new Map<string, { relayId: string; relayUrl: string }>(),
    claims: new Map<string, CloudClaim>(),
    issued: new Map<string, any>(),
    transformAllocation: undefined as ((allocation: any) => any) | undefined,
    relayUrl: "wss://relay.cloud.example.com/relay",
    relayId: "relay_test_1",
  };
  let allocationSequence = 0;
  const issueAllocations = (body: { controlPlaneId?: string; refreshControlPlaneIds?: string[] }) => {
    const refresh = new Set<string>(body.refreshControlPlaneIds ?? []);
    const nodeHandle = options.nodeHandle ?? "nrh_test_node_handle";
    return [...state.claims.values()]
      .filter((claim) => !body.controlPlaneId || claim.controlPlaneId === body.controlPlaneId)
      .map((claim) => {
        if (refresh.has(claim.controlPlaneId) && !state.ignoreRefresh) state.issued.delete(claim.controlPlaneId);
        const existing = state.issued.get(claim.controlPlaneId);
        if (existing) return existing;
        const relay = state.relayByControlPlane.get(claim.controlPlaneId) ?? { relayId: state.relayId, relayUrl: state.relayUrl };
        const allocationId = `allocation_test_${++allocationSequence}`;
        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
        const shared = claim.accessMode === "shared" ? {
          ownerAccountId: claim.ownerAccountId,
          accessMode: "shared" as const,
          shareGrantId: claim.shareGrantId,
          shareRevision: claim.shareRevision,
          shareRole: "use" as const,
        } : {};
        const base = {
          protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION,
          channelKind: "node" as const,
          allocationId,
          relayId: relay.relayId,
          controlPlaneId: claim.controlPlaneId,
          accountId: claim.accountId ?? options.accountId ?? "account_test",
          bindingId: claim.bindingId ?? "binding_test",
          bindingRevision: claim.bindingRevision ?? 1,
          nodeHandle,
          trafficClass: "interactive" as const,
          issuedAt: new Date().toISOString(),
          expiresAt,
          ...shared,
        };
        const nodeAttach = { ...base, audience: OfficialAudience.RelayNodeAgentAttach, role: "node-agent", nonce: crypto.randomBytes(24).toString("base64url"), signature: "s".repeat(43) };
        const grantPayload = {
          protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION,
          audience: OfficialAudience.RelayNodeClaimGrant,
          grantId: `grant_${allocationId}`,
          allocationId,
          nodeHandle,
          controlPlaneId: claim.controlPlaneId,
          accountId: claim.accountId ?? options.accountId ?? "account_test",
          bindingId: claim.bindingId ?? "binding_test",
          bindingRevision: claim.bindingRevision ?? 1,
          relayId: relay.relayId,
          relayRegion: "test-region",
          relayUrl: relay.relayUrl,
          nonce: crypto.randomBytes(24).toString("base64url"),
          issuedAt: base.issuedAt,
          expiresAt,
          ...shared,
          controlPlanePublicKey: claim.controlPlanePublicKey,
        };
        const claimGrant = NodeRelayClaimGrantSchema.parse({ ...grantPayload, signature: signingKey.sign("node-relay-claim-grant", grantPayload) });
        const allocation = NodeRelayNodeAllocationSchema.parse({
          allocationId,
          relayId: relay.relayId,
          relayRegion: "test-region",
          relayUrl: relay.relayUrl,
          claimGrant,
          nodeAttach,
          expiresAt,
        });
        const transformed = state.transformAllocation ? state.transformAllocation(allocation) : allocation;
        state.issued.set(claim.controlPlaneId, transformed);
        return transformed;
      });
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    if (state.unreachable) throw new TypeError("cloud relay test stack is unreachable");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const failure = (status: number, code: string, message = code) => json(status, { error: { code, message } });
    const credential = /^Bearer (.+)$/.exec(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""))?.[1];
    const authenticate = () => {
      if (state.credentialRejected || state.registryRevoked || !state.redeemed || credential !== state.credential) {
        throw { status: 401, code: "NODE_RELAY_CREDENTIAL_INVALID" };
      }
    };
    try {
      if (path === "/api/v1/node-relay/v1/redeem") {
        if (body.token !== state.bindingToken || state.redeemed) return failure(409, "NODE_RELAY_BINDING_TOKEN_INVALID");
        state.redeemed = true;
        state.redemptions.push({ ...(body.nodeId ? { nodeId: body.nodeId } : {}), ...(body.displayName ? { displayName: body.displayName } : {}) });
        return json(200, {
          data: NodeRelayBindingRedemptionSchema.parse({
            nodeHandle: options.nodeHandle ?? "nrh_test_node_handle",
            accountId: options.accountId ?? "account_test",
            serviceOrigin,
            credential: state.credential,
            credentialExpiresAt: state.credentialExpiresAt,
            serviceSigningKey: { kid: signingKey.kid, publicKey: signingKey.publicKey },
          }),
        });
      }
      if (path === "/api/v1/node-relay/v1/credential/renew") {
        authenticate();
        state.credential = `thnc_test_credential_${crypto.randomBytes(8).toString("hex")}`;
        state.credentialExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        return json(200, { data: NodeRelayCredentialSchema.parse({ credential: state.credential, expiresAt: state.credentialExpiresAt }) });
      }
      if (path === "/api/v1/node-relay/v1/allocations") {
        authenticate();
        state.allocationRequests.push(body);
        const allocations = issueAllocations(body);
        return json(200, { data: NodeRelayAllocationResponseSchema.parse({ allocations }) });
      }
      if (path === "/api/v1/node-relay/v2/probe-targets") {
        authenticate();
        state.probeTargetRequests.push(body);
        if (!state.adaptiveSelection) return failure(404, NODE_RELAY_ADAPTIVE_SELECTION_UNSUPPORTED_CODE);
        if (state.probeTargetFailure) {
          const { status, code, message } = state.probeTargetFailure;
          return failure(status, code, message);
        }
        const targets = (state.probeTargets ?? [{ relayId: state.relayId, relayUrl: state.relayUrl }]).slice(0, 3);
        return json(200, { data: NodeRelayProbeTargetsResponseSchema.parse({ targets }) });
      }
      if (path === "/api/v1/node-relay/v2/allocations") {
        authenticate();
        state.allocationV2Requests.push(body);
        if (!state.adaptiveSelection) return failure(404, NODE_RELAY_ADAPTIVE_SELECTION_UNSUPPORTED_CODE);
        if (state.failAdaptiveAllocations) return failure(503, "NODE_RELAY_ALLOCATION_UNAVAILABLE");
        const allocations = issueAllocations(body);
        return json(200, { data: NodeRelayAllocationResponseSchema.parse({ allocations }) });
      }
      if (path === "/api/v1/node-relay/v1/unbind") {
        authenticate();
        state.unbinds += 1;
        return json(200, { data: { unbound: true, nodeHandle: options.nodeHandle ?? "nrh_test_node_handle" } });
      }
    } catch (error) {
      const failureRecord = error as { status?: number; code?: string };
      return failure(failureRecord.status ?? 500, failureRecord.code ?? "NODE_RELAY_REQUEST_FAILED");
    }
    return failure(404, "NOT_FOUND", "Route not found.");
  };
  return {
    fetchImpl,
    state,
    signingKey,
    serviceOrigin,
    claimNode(claim: CloudClaim) {
      state.claims.set(claim.controlPlaneId, claim);
    },
    dropClaim(controlPlaneId: string) {
      state.claims.delete(controlPlaneId);
    },
    revokeCredential() {
      state.credentialRejected = true;
    },
    revokeRegistry() {
      state.registryRevoked = true;
    },
    issuedAllocation(controlPlaneId: string) {
      return state.issued.get(controlPlaneId);
    },
    setAllocationTransform(transform: ((allocation: any) => any) | undefined) {
      state.transformAllocation = transform;
    },
    setRelayUrl(relayUrl: string) {
      state.relayUrl = relayUrl;
    },
    setAdaptiveSelection(enabled: boolean) {
      state.adaptiveSelection = enabled;
    },
    setRelayForControlPlane(controlPlaneId: string, relay: { relayId: string; relayUrl: string }) {
      state.relayByControlPlane.set(controlPlaneId, relay);
    },
    setProbeTargets(targets: Array<{ relayId: string; relayUrl: string }>) {
      state.probeTargets = targets;
    },
    setUnreachable(unreachable: boolean) {
      state.unreachable = unreachable;
    },
    invalidateAllocation(controlPlaneId: string) {
      state.issued.delete(controlPlaneId);
    },
    setIgnoreRefresh(ignoreRefresh: boolean) {
      state.ignoreRefresh = ignoreRefresh;
    },
  };
}

/**
 * ws-compatible socket for the node client: each instance is linked to a peer
 * frame socket the Control Plane side of the test drives.
 */
export function fakeRelayWebSocket(options: { onConnection(peer: InMemoryFrameSocket, url: string): void; closeDelayMs?: number; }): typeof import("ws").default {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    readonly peer: InMemoryFrameSocket;
    readyState = 0;
    bufferedAmount = 0;
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    private readonly pendingInbound: Buffer[] = [];
    private readonly peerListeners = new Set<(raw: unknown, isBinary: boolean) => void>();
    private readonly peerCloseListeners = new Set<(code?: number, reason?: unknown) => void>();
    constructor(url: string) {
      this.url = url;
      this.peer = {
        readyState: 1,
        send: (data: string | Uint8Array) => this.deliverToClient(Buffer.from(data as any)),
        close: () => this.close(1006, "peer closed"),
        on: (event: string, listener: (...args: any[]) => void) => {
          if (event === "message") this.peerListeners.add(listener);
          if (event === "close") this.peerCloseListeners.add(listener);
        },
        off: (event: string, listener: (...args: any[]) => void) => {
          if (event === "message") this.peerListeners.delete(listener);
          if (event === "close") this.peerCloseListeners.delete(listener);
        },
        deliver: (raw: unknown, isBinary: boolean) => { for (const listener of [...this.peerListeners]) listener(raw, isBinary); },
        drop: () => { for (const listener of [...this.peerCloseListeners]) listener(1006, "dropped"); },
      };
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.emit("open");
        options.onConnection(this.peer, url);
      });
    }
    private deliverToClient(raw: Buffer) {
      const listeners = [...(this.listeners.get("message") ?? [])];
      if (!listeners.length) {
        // ws queues frames sent before a listener is attached; the encrypted
        // channel attaches right after the handshake, so ordering must survive.
        this.pendingInbound.push(raw);
        return;
      }
      for (const listener of listeners) listener(raw, true);
    }
    private emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
    on(event: string, listener: (...args: any[]) => void) {
      const current = this.listeners.get(event) ?? new Set();
      current.add(listener);
      this.listeners.set(event, current);
      if (event === "message") {
        for (const item of this.pendingInbound.splice(0)) listener(item, true);
      }
      return this;
    }
    once(event: string, listener: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        this.off(event, wrapper);
        listener(...args);
      };
      return this.on(event, wrapper);
    }
    off(event: string, listener: (...args: any[]) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    send(data: string | Buffer, options?: { binary?: boolean }) {
      if (this.readyState !== 1) throw new Error("socket is not open");
      const binary = Boolean(options?.binary) || typeof data !== "string";
      for (const listener of [...this.peerListeners]) listener(Buffer.from(data as any), binary);
    }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const finish = () => {
        this.peer.drop();
        this.emit("close", code, reason);
      };
      if (options.closeDelayMs && options.closeDelayMs > 0) {
        const timer = setTimeout(finish, options.closeDelayMs);
        timer.unref?.();
      } else {
        finish();
      }
    }
    terminate() {
      this.close(1006, "terminated");
    }
    ping() {}
  }
  return FakeWebSocket as unknown as typeof import("ws").default;
}

type AuxState = {
  accepted: boolean;
  streamId?: number;
  data?: Buffer;
  head?: any;
  ended?: boolean;
  error?: string;
  frames: Array<{ data: string | Buffer; binary: boolean }>;
  resolveAccept?(): void;
  rejectAccept?(error: Error): void;
};

/**
 * The Control Plane half of one relay channel, reduced to what the node side
 * needs to be proven end to end: attach, signed handshake, hello/identify,
 * tunnel requests, response streams and auxiliary channel multiplexing.
 */
export async function startCloudRelayControlPlanePeer(input: {
  socket: InMemoryFrameSocket;
  controlPlaneId: string;
  identity: { publicKey: string; sign(input: string): string };
  allocation: { allocationId: string; relayId: string; nodeHandle: string; accountId: string; bindingId: string; bindingRevision: number; nodePublicKeyFingerprint: string };
  pairing?: { keyId: string; secret: string };
  createPairing?: () => { keyId: string; secret: string };
  /** Capability already read off the wire by the caller (multi-Control-Plane tests peek to route the socket). */
  attachCapability?: any;
}) {
  // Relay attach handshake: the node sends its capability as a plain ws frame.
  const capability = input.attachCapability !== undefined ? input.attachCapability : await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay attach timed out")), 5_000);
    const onMessage = (raw: unknown) => {
      const value = JSON.parse(Buffer.from(raw as Buffer).toString("utf8"));
      if (value?.type !== "attach") return;
      clearTimeout(timer);
      input.socket.off("message", onMessage);
      resolve(value.capability);
    };
    input.socket.on("message", onMessage);
  });
  input.socket.send(JSON.stringify({ type: "attached", channelId: `channel_${input.allocation.allocationId}`, allocationId: input.allocation.allocationId }));
  const accepted = await acceptNodeRelayHandshake({
    socket: input.socket,
    identity: { controlPlaneId: input.controlPlaneId, publicKey: input.identity.publicKey, signNodeRelayHandshake: (signingInput) => input.identity.sign(signingInput) },
    expectation: {
      allocationId: input.allocation.allocationId,
      relayId: input.allocation.relayId,
      nodeHandle: input.allocation.nodeHandle,
      controlPlaneId: input.controlPlaneId,
      accountId: input.allocation.accountId,
      bindingId: input.allocation.bindingId,
      bindingRevision: input.allocation.bindingRevision,
      nodePublicKeyFingerprint: input.allocation.nodePublicKeyFingerprint,
    },
    ...(input.pairing ? { pairing: input.pairing } : {}),
    createPairing: input.createPairing ?? (() => ({ keyId: `key_${input.controlPlaneId}`, secret: crypto.randomBytes(32).toString("base64url") })),
  });
  const messages: any[] = [];
  const pendingResponses = new Map<string, (value: any) => void>();
  const pendingAux = new Map<string, AuxState>();
  const auxByStreamId = new Map<number, AuxState>();
  const streamIdByChannelId = new Map<string, number>();
  const send = (message: any) => session.send(message);
  const sendMain = (value: unknown) => session.sendData(NODE_RELAY_MAIN_STREAM_ID, JSON.stringify(value), false);
  const session = new EncryptedNodeRelayChannel({
    socket: input.socket,
    key: accepted.key,
    sendDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
    receiveDirection: NODE_RELAY_DIRECTION_NODE,
    onMessage(message) {
      if (message.type === "relay-ping") return send({ type: "relay-pong" });
      if (message.type === "channel-accept") {
        const aux = pendingAux.get(message.channelId);
        if (aux) {
          aux.accepted = true;
          aux.streamId = message.streamId;
          auxByStreamId.set(message.streamId, aux);
          streamIdByChannelId.set(message.channelId, message.streamId);
          aux.resolveAccept?.();
        }
        return;
      }
      if (message.type === "channel-reject") {
        const aux = pendingAux.get(message.channelId);
        if (aux) aux.rejectAccept?.(Object.assign(new Error(message.code), { code: message.code }));
        return;
      }
      if (message.type === "channel-open") {
        // The node dials auxiliary channels back; accept immediately.
        const aux = pendingAux.get(message.channelId) ?? { accepted: true, frames: [] };
        aux.accepted = true;
        aux.streamId = message.streamId;
        pendingAux.set(message.channelId, aux);
        auxByStreamId.set(message.streamId, aux);
        streamIdByChannelId.set(message.channelId, message.streamId);
        aux.resolveAccept?.();
        send({ type: "channel-accept", channelId: message.channelId, streamId: message.streamId });
        return;
      }
      if (message.type === "channel-close") {
        const aux = pendingAux.get(message.channelId);
        pendingAux.delete(message.channelId);
        if (aux?.streamId !== undefined) auxByStreamId.delete(aux.streamId);
        streamIdByChannelId.delete(message.channelId);
      }
    },
    onData(frame: NodeRelayDataFrame) {
      if (frame.streamId === NODE_RELAY_MAIN_STREAM_ID) {
        if (frame.binary) return;
        const value = JSON.parse(Buffer.from(frame.data).toString("utf8"));
        messages.push(value);
        if (value?.type === "node-agent.response" && typeof value.requestId === "string") pendingResponses.get(value.requestId)?.(value);
        return;
      }
      const aux = auxByStreamId.get(frame.streamId);
      if (!aux) return;
      if (frame.binary) {
        const bytes = Buffer.from(frame.data);
        aux.frames.push({ data: bytes, binary: true });
        aux.data = Buffer.concat([aux.data ?? Buffer.alloc(0), bytes]);
        return;
      }
      const text = Buffer.from(frame.data).toString("utf8");
      aux.frames.push({ data: text, binary: false });
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      if (value?.type === "node-agent.http.head") aux.head = value;
      if (value?.type === "node-agent.http.end") aux.ended = true;
      if (value?.type === "node-agent.http.error") aux.error = value.message;
    },
  });
  session.start();
  sendMain({
    type: "control-plane.hello",
    protocolVersion: "1",
    nodeId: "node_under_test",
    serverTime: new Date().toISOString(),
    capabilities: { reverseTunnel: "request-response", auxiliaryChannels: true, httpResponseStreaming: true, lifecycleCommands: true, instanceApiProxy: true },
  });
  let requestSequence = 0;
  return {
    session,
    capability,
    paired: accepted.paired,
    issuedPairing: accepted.issuedPairing,
    messages,
    async waitForMessage(predicate: (value: any) => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`control-plane peer did not observe ${predicate.toString()}`);
    },
    async request(route: string, init: Record<string, unknown> = {}, timeoutMs = 5_000) {
      const requestId = `request_${++requestSequence}`;
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`request ${route} timed out`)), timeoutMs);
        pendingResponses.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
      });
      sendMain({ type: "control-plane.request", requestId, route, init });
      return response;
    },
    async openHttpStream(streamId: string, route: string, init: Record<string, unknown> = {}, timeoutMs = 5_000) {
      const aux: AuxState = { accepted: false, frames: [] };
      pendingAux.set(streamId, aux);
      sendMain({ type: "control-plane.http.open", streamId, route, init });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (aux.head && aux.ended) return { head: aux.head, body: aux.data ?? Buffer.alloc(0), ended: aux.ended, error: aux.error };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { head: aux.head, body: aux.data ?? Buffer.alloc(0), ended: aux.ended, error: aux.error ?? "stream timed out" };
    },
    async openWebSocket(streamId: string, route: string, timeoutMs = 5_000) {
      const aux: AuxState = { accepted: false, frames: [] };
      pendingAux.set(streamId, aux);
      sendMain({ type: "control-plane.websocket.open", streamId, route });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const opened = messages.find((message) => message.type === "node-agent.websocket.open" && message.streamId === streamId);
        if (opened) {
          return {
            protocol: opened.protocol,
            frames: aux.frames,
            send(data: string | Buffer) {
              const numericStreamId = streamIdByChannelId.get(streamId);
              if (numericStreamId === undefined) throw new Error(`websocket ${streamId} has no relay stream id`);
              session.sendData(numericStreamId, data, typeof data !== "string");
            },
            async waitForText(predicate: (value: any) => boolean, waitMs = timeoutMs) {
              const until = Date.now() + waitMs;
              while (Date.now() < until) {
                for (const frame of aux.frames) {
                  if (frame.binary) continue;
                  let value: any;
                  try {
                    value = JSON.parse(String(frame.data));
                  } catch {
                    continue;
                  }
                  if (predicate(value)) return value;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              throw new Error(`control-plane peer did not observe a websocket frame matching ${predicate.toString()}: ${JSON.stringify(aux.frames.map((frame) => frame.binary ? `binary:${Buffer.from(frame.data as Buffer).length}` : String(frame.data).slice(0, 200)))}`);
            },
            close(code = 1000, reason = "test-close") {
              sendMain({ type: "control-plane.websocket.close", streamId, code, reason });
            },
          };
        }
        const failed = messages.find((message) => message.type === "node-agent.websocket.error" && message.streamId === streamId);
        if (failed) throw new Error(`websocket ${streamId} failed: ${failed.message}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`control-plane peer did not open websocket ${streamId}: main=${JSON.stringify(messages.map((message) => message.type))} aux=${JSON.stringify(aux.frames.map((frame) => frame.binary ? `binary:${Buffer.from(frame.data as Buffer).length}` : String(frame.data).slice(0, 200)))}`);
    },
    close(reason = "peer-closed") {
      session.close(reason);
    },
  };
}

export { ed25519Identity, nodeRelayFingerprint, OUTBOUND_CONNECTION_PROTOCOL_VERSION, RELAY_FRAMING_PROTOCOL_VERSION };
