import type { z } from 'zod';
import { RelayTtySnapshotEnvelopeSchema, type OfficialMobileAccountClient as CloudMobileAccountClient } from '@task-handoff/cloud-contracts/mobile';
import type { MobileCloudRelayControlPlaneProfile } from './profile';
import { MobileControlPlaneTransportError, type MobileAppSessionTtyConnection, type MobileAppSessionTtyHandlers, type MobileControlPlaneEventConnection, type MobileControlPlaneEventHandlers, type MobileControlPlaneTransport } from './transport';

type RelayEnvelope = { type: string; id?: string; status?: number; body?: unknown; event?: any; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null };
export interface EncryptedRelayChannel { send(value: RelayEnvelope): void; close(code?: number, reason?: string): void; subscribe(listener: (value: RelayEnvelope) => void, onClose: (error?: unknown) => void): () => void; }
export type RelayChannelFactory = (input: { relayUrl: string; clientAttach: unknown; ticket: unknown; targetPublicKeyFingerprint: string; epoch: number }) => Promise<EncryptedRelayChannel>;

export class RelayControlPlaneTransport implements MobileControlPlaneTransport {
  readonly profile: MobileCloudRelayControlPlaneProfile;
  private channel?: Promise<EncryptedRelayChannel>;
  private channelValue?: EncryptedRelayChannel;
  private epoch = 0;
  private nextId = 0;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; schema: z.ZodType<any>; abort?: () => void }>();
  private readonly events = new Set<MobileControlPlaneEventHandlers>();
  private readonly tty = new Map<string, MobileAppSessionTtyHandlers>();

  constructor(profile: MobileCloudRelayControlPlaneProfile, private readonly account: CloudMobileAccountClient, private readonly openChannel: RelayChannelFactory) { this.profile = profile; }

  async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw transportError('RELAY_ROUTE_INVALID');
    const headers = new Headers(init.headers); if (headers.has('authorization')) throw transportError('RELAY_AUTH_HEADER_FORBIDDEN');
    const channel = await this.ensureChannel(); const id = `request_${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { channel.send({ type: 'cancel', id }); this.pending.delete(id); reject(transportError('RELAY_REQUEST_CANCELLED')); };
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, schema, abort: () => init.signal?.removeEventListener('abort', abort) });
      channel.send({ type: 'request', id, body: { path, method: init.method ?? 'GET', headers: Object.fromEntries(headers), body: init.body } });
    });
  }

  connectEvents(handlers: MobileControlPlaneEventHandlers): MobileControlPlaneEventConnection {
    this.events.add(handlers); void this.ensureChannel().then((channel) => { channel.send({ type: 'event-subscribe', body: { topics: handlers.topics } }); handlers.onOpen(); }).catch(handlers.onError);
    return { close: () => { this.events.delete(handlers); if (this.channelValue) this.channelValue.send({ type: 'event-subscribe', body: { topics: [...new Set([...this.events].flatMap((entry) => [...(entry.topics ?? [])]))] } }); } };
  }

  connectAppSessionTty(instanceId: string, sessionId: string, handlers: MobileAppSessionTtyHandlers): MobileAppSessionTtyConnection {
    const streamId = `tty_${++this.nextId}`; this.tty.set(streamId, handlers);
    void this.ensureChannel().then((channel) => channel.send({ type: 'tty-open', streamId, body: { instanceId, sessionId } })).catch(handlers.onError);
    return { sendInput: (data) => this.channelValue?.send({ type: 'tty-input', streamId, data }), resize: (cols, rows) => this.channelValue?.send({ type: 'tty-resize', streamId, body: { cols, rows } }), close: () => { this.channelValue?.send({ type: 'tty-close', streamId }); this.tty.delete(streamId); } };
  }

  async revalidate() { this.reset(transportError('RELAY_NETWORK_CHANGED', true)); await this.ensureChannel(); }

  private ensureChannel() {
    if (this.channel) return this.channel;
    this.channel = (async () => {
      const ticket = await this.account.issueAccessTicket({ controlPlaneId: this.profile.identity.controlPlaneId, trafficClasses: ['interactive', 'stream'] });
      if (ticket.targetPublicKeyFingerprint !== this.profile.identity.publicKeyFingerprint || ticket.bindingId !== this.profile.access.bindingId || ticket.bindingRevision !== this.profile.access.bindingRevision) throw transportError('RELAY_TARGET_IDENTITY_CHANGED');
      const allocation = await this.account.allocateRelay({ ticket, preferredRegion: undefined, trafficClass: 'interactive' });
      const channel = await this.openChannel({ relayUrl: allocation.relayUrl, clientAttach: allocation.clientAttach, ticket, targetPublicKeyFingerprint: this.profile.identity.publicKeyFingerprint, epoch: ++this.epoch });
      this.channelValue = channel;
      channel.subscribe((value) => this.receive(value), (error) => this.reset(error ?? transportError('RELAY_CHANNEL_CLOSED', true)));
      return channel;
    })().catch((error) => { this.channel = undefined; throw normalize(error); });
    return this.channel;
  }

  private receive(value: RelayEnvelope) {
    if (value.type === 'response' && value.id) { const pending = this.pending.get(value.id); if (!pending) return; this.pending.delete(value.id); pending.abort?.(); if ((value.status ?? 500) >= 400) pending.reject(new MobileControlPlaneTransportError('RELAY_CONTROL_PLANE_RESPONSE_FAILED', 'Control Plane request failed.', false, value.status)); else { const parsed = pending.schema.safeParse(value.body); if (parsed.success) pending.resolve(parsed.data); else pending.reject(transportError('RELAY_RESPONSE_SCHEMA_INVALID')); } return; }
    if (value.type === 'event' && value.event) { for (const handlers of this.events) handlers.onEvent(value.event); return; }
    if (value.streamId && this.tty.has(value.streamId)) { const handlers = this.tty.get(value.streamId)!; if (value.type === 'tty-opened') handlers.onOpen(); else if (value.type === 'tty-snapshot') { const snapshot = RelayTtySnapshotEnvelopeSchema.safeParse(value); if (!snapshot.success) handlers.onError(transportError('RELAY_TTY_SNAPSHOT_INVALID')); else handlers.onSnapshot(snapshot.data.data, snapshot.data.pendingEscape, snapshot.data.cols, snapshot.data.rows); } else if (value.type === 'tty-output') handlers.onOutput(String(value.data ?? '')); else if (value.type === 'tty-resize') { const body = value.body as any; handlers.onResize(body.cols, body.rows); } else if (value.type === 'tty-exit') handlers.onExit(value.code, value.signal); else if (value.type === 'tty-error') handlers.onError(transportError('RELAY_TTY_FAILED')); else if (value.type === 'tty-closed') { handlers.onClose(); this.tty.delete(value.streamId); } }
  }

  private reset(error: unknown) { this.channelValue?.close(4000, 'reset'); this.channelValue = undefined; this.channel = undefined; for (const pending of this.pending.values()) pending.reject(normalize(error)); this.pending.clear(); for (const handler of this.events) handler.onError(normalize(error)); for (const handler of this.tty.values()) handler.onError(normalize(error)); }
}

function normalize(error: unknown) { return error instanceof MobileControlPlaneTransportError ? error : transportError('RELAY_CONNECTION_FAILED', true); }
function transportError(code: string, retryable = false) { return new MobileControlPlaneTransportError(code, 'Cloud Relay connection is unavailable.', retryable); }
