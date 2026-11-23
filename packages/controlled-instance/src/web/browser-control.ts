import crypto from "node:crypto";
import { createEntityId } from "@task-handoff/protocol/control-plane";
import {
  EMBEDDED_BROWSER_ACCESS_REQUEST_TTL_MS,
  EMBEDDED_BROWSER_CDP_ACCESS_TTL_MS,
  EMBEDDED_BROWSER_CDP_PROFILE,
  EMBEDDED_BROWSER_CREATION_TTL_MS,
  EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE,
  EMBEDDED_BROWSER_MAX_SOURCES,
  EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK,
  EmbeddedBrowserAccessViewSchema,
  EmbeddedBrowserAccessRequestViewSchema,
  EmbeddedBrowserBrowserContextSchema,
  EmbeddedBrowserChannelCapabilitiesSchema,
  EmbeddedBrowserCreationCandidateSchema,
  EmbeddedBrowserCreationContextSnapshotSchema,
  EmbeddedBrowserCreationPanelSchema,
  EmbeddedBrowserCreationPendingSchema,
  EmbeddedBrowserCreationViewSchema,
  EmbeddedBrowserDefaultContextClaimResultSchema,
  EmbeddedBrowserLeaseSchema,
  EmbeddedBrowserPageListResponseSchema,
  EmbeddedBrowserPageSchema,
  EmbeddedBrowserPageHostCapabilitiesSchema,
  EmbeddedBrowserPageHostSchema,
  EmbeddedBrowserRegistryDeltaSchema,
  EmbeddedBrowserSourceDeltaSchema,
  EmbeddedBrowserSourceRegistrationRequestSchema,
  EmbeddedBrowserSourceSchema,
  EmbeddedBrowserSourceSnapshotSchema,
  EmbeddedBrowserTargetGetBrowserContextsResultSchema,
  EmbeddedBrowserTargetGetTargetsResultSchema,
  embeddedBrowserTargetInfoFromPage,
  type EmbeddedBrowserAccessView,
  type EmbeddedBrowserAccessRequestView,
  type EmbeddedBrowserChannelCapabilities,
  type EmbeddedBrowserCdpIdentity,
  type EmbeddedBrowserCreationCandidate,
  type EmbeddedBrowserCreationContextSnapshot,
  type EmbeddedBrowserCreationPanel,
  type EmbeddedBrowserCreationStatus,
  type EmbeddedBrowserCreationView,
  type EmbeddedBrowserDefaultContextClaimResult,
  type EmbeddedBrowserLease,
  type EmbeddedBrowserPage,
  type EmbeddedBrowserPageHost,
  type EmbeddedBrowserPageHostCapabilities,
  type EmbeddedBrowserRegistryDelta,
  type EmbeddedBrowserSource,
  type EmbeddedBrowserSourceDelta,
  type EmbeddedBrowserSourceSnapshot,
  type EmbeddedBrowserTargetGetBrowserContextsResult,
  type EmbeddedBrowserTargetInfo,
  type EmbeddedBrowserTargetGetTargetsResult,
} from "@task-handoff/protocol/embedded-browser-control";

const REGISTRY_HISTORY_LIMIT = 1_024;
const EVENT_LIMIT = 1_024;
const SOURCE_RECOVERY_WINDOW_MS = 60_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK;
const MAX_ACTIVE_CREATIONS = EMBEDDED_BROWSER_MAX_SOURCES;
const LEASE_TTL_MS = 30 * 60_000;

export type BrowserControlErrorCode =
  | "BROWSER_CONTROL_UNSUPPORTED"
  | "BROWSER_SOURCE_UNAVAILABLE"
  | "BROWSER_SOURCE_NOT_FOUND"
  | "BROWSER_AUTHORIZATION_REQUIRED"
  | "BROWSER_AUTHORIZATION_REVOKED"
  | "BROWSER_ACCESS_REQUEST_STALE"
  | "BROWSER_PAGE_HOST_UNAVAILABLE"
  | "BROWSER_TAB_NOT_FOUND"
  | "BROWSER_WINDOW_UNAVAILABLE"
  | "BROWSER_TARGET_BUSY"
  | "BROWSER_LEASE_STALE"
  | "BROWSER_OPERATION_UNSUPPORTED"
  | "BROWSER_CDP_ERROR"
  | "BROWSER_REQUEST_CONFLICT"
  | "BROWSER_TIMEOUT"
  | "BROWSER_CANCELLED"
  | "BROWSER_EXECUTION_UNKNOWN"
  | "BROWSER_SNAPSHOT_REQUIRED"
  | "BROWSER_LIMIT_EXCEEDED"
  | "BROWSER_RESULT_EXPIRED"
  | "BROWSER_CREATION_NOT_FOUND"
  | "BROWSER_CREATION_CONFLICT"
  | "BROWSER_CREATION_DECLINED"
  | "BROWSER_CREATION_EXPIRED"
  | "BROWSER_CREATION_NO_CANDIDATE"
  | "BROWSER_CREATION_CONTEXT_REQUIRED"
  | "BROWSER_CREATION_CONTEXT_UNAVAILABLE"
  | "BROWSER_CREATION_CONTEXT_NOT_SELECTED"
  | "BROWSER_CREATION_CONTEXT_NOT_OWNED"
  | "BROWSER_CREATION_CONTEXT_FORBIDDEN"
  | "BROWSER_DEFAULT_CONTEXT_CONFLICT"
  | "BROWSER_CHANNEL_STREAM_KIND_UNSUPPORTED"
  | "BROWSER_CHANNEL_PROTOCOL_ERROR";

export type BrowserControlErrorDetails = {
  creationRef?: string;
  expiresAt?: string;
  revision?: number;
  requestRef?: string;
  defaultBrowserContextId?: string;
};

export class BrowserControlError extends Error {
  readonly code: BrowserControlErrorCode | string;
  readonly statusCode: number;
  readonly details: BrowserControlErrorDetails;

  constructor(code: BrowserControlErrorCode | string, message: string, statusCode = 500, details: BrowserControlErrorDetails = {}) {
    super(message);
    this.name = "BrowserControlError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export type BrowserControlEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type BrowserAccessRequestState = "pending" | "approved" | "denied" | "expired" | "cancelled";

type AccessRequestRecord = {
  view: EmbeddedBrowserAccessRequestView;
  state: BrowserAccessRequestState;
};

export type BrowserAccessDecision = {
  status: "granted" | "pending" | "denied" | "expired";
  request: EmbeddedBrowserAccessRequestView;
};

export type BrowserSourceRegistration = {
  panelId: string;
  ownerRef: string;
  displayName: string;
  hostLabel?: string;
  publisherRef: string;
  rendererHostBinding?: string;
  pageHost: EmbeddedBrowserPageHost;
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilities;
  cdpIdentity?: EmbeddedBrowserCdpIdentity;
};

export type BrowserControlSourceBinding = {
  sourceRef: string;
  generation: number;
  pageHost: EmbeddedBrowserPageHost;
  pageHostCapabilities: EmbeddedBrowserPageHostCapabilities;
  state: string;
  sourceRevision: number;
  registryEpoch: string;
  registryRevision: number;
};

export type BrowserLeaseCommandTarget = {
  lease: EmbeddedBrowserLease;
  page: EmbeddedBrowserPage;
  rendererHostBinding?: string;
};

type BrowserSourceState = "pending" | "syncing" | "ready" | "disconnected" | "expired" | "revoked" | "closed";

type SnapshotAssembly = {
  snapshotRef: string;
  sourceRevision: number;
  registryEpoch: string;
  chunks: Array<EmbeddedBrowserPage[] | undefined>;
};

type SourceRecord = {
  sourceRef: string;
  generation: number;
  registration: BrowserSourceRegistration;
  state: BrowserSourceState;
  sourceRevision: number;
  pages: Map<string, EmbeddedBrowserPage>;
  snapshot?: SnapshotAssembly;
  disconnectedAt?: number;
};

type CreationRecord = {
  view: EmbeddedBrowserCreationView;
  requesterSessionRef: string;
  claimedSourceRef?: string;
  claimedGeneration?: number;
  claimedRendererHostBinding?: string;
  expiresAtMs: number;
};

type CreationContextRecord = {
  sourceRef: string;
  claimedAtMs: number;
};

export type BrowserCreationDispatchTarget = {
  sourceRef: string;
  generation: number;
  requesterSessionRef: string;
};

export type BrowserCreationDispatcher = (
  creation: EmbeddedBrowserCreationView,
  target: BrowserCreationDispatchTarget,
) => Promise<void>;

type LeaseRecord = {
  lease: EmbeddedBrowserLease;
  sessionRef: string;
  expiresAtMs: number;
};

type CdpAccessTokenRecord = {
  sessionRef: string;
  accessRevision: number;
  expiresAtMs: number;
};

type InstanceAccessState = { active: boolean; revision: number };

function nowMs() {
  return Date.now();
}

function rfc3339(ms: number) {
  return new Date(ms).toISOString();
}

function normalizedText(value: string, max: number, fallback: string) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function publicSource(source: SourceRecord): EmbeddedBrowserSource {
  return EmbeddedBrowserSourceSchema.parse({
    sourceRef: source.sourceRef,
    generation: source.generation,
    panelId: source.registration.panelId,
    displayName: source.registration.displayName,
    pageHost: source.registration.pageHost,
    pageHostCapabilities: source.registration.pageHostCapabilities,
    revision: source.sourceRevision,
  });
}

function parseCursor(cursor: string | undefined, registryEpoch: string) {
  if (!cursor?.trim()) return 0;
  const index = cursor.lastIndexOf(":");
  if (index < 0) throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser page cursor is invalid.", 409);
  const epoch = cursor.slice(0, index);
  if (epoch !== registryEpoch) throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser registry epoch changed.", 409);
  const offset = Number(cursor.slice(index + 1));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser page cursor is invalid.", 409);
  return offset;
}

function sourceCanCreate(source: SourceRecord): boolean {
  if (source.state !== "ready") return false;
  if (source.registration.pageHost === "renderer-webview") {
    return Boolean(source.registration.rendererHostBinding?.trim() && source.registration.hostLabel?.trim());
  }
  return source.registration.pageHostCapabilities.backgroundCreation;
}

function creationCandidate(source: SourceRecord): EmbeddedBrowserCreationCandidate | undefined {
  if (source.state !== "ready") return undefined;
  return EmbeddedBrowserCreationCandidateSchema.parse({
    sourceRef: source.sourceRef,
    panelLabel: source.registration.panelId,
    desktopLabel: source.registration.displayName,
    ...(source.registration.hostLabel ? { hostLabel: source.registration.hostLabel } : {}),
    pageHost: source.registration.pageHost,
    state: source.state,
    canCreate: sourceCanCreate(source),
  });
}

function creationPanel(
  source: SourceRecord,
  options: { isDefault: boolean; canClaim: boolean },
): EmbeddedBrowserCreationPanel {
  return EmbeddedBrowserCreationPanelSchema.parse({
    sourceRef: source.sourceRef,
    panelLabel: source.registration.displayName,
    ...(source.registration.hostLabel ? { hostLabel: source.registration.hostLabel } : {}),
    pageHost: source.registration.pageHost,
    canCreate: sourceCanCreate(source),
    isDefault: options.isDefault,
    canClaim: options.canClaim,
  });
}

function validateRegistration(registration: BrowserSourceRegistration) {
  const parsed = EmbeddedBrowserSourceRegistrationRequestSchema.parse({
    displayName: registration.displayName,
    ...(registration.hostLabel ? { hostLabel: registration.hostLabel } : {}),
    publisherRef: registration.publisherRef,
    ...(registration.rendererHostBinding ? { rendererHostBinding: registration.rendererHostBinding } : {}),
    pageHost: registration.pageHost,
    pageHostCapabilities: EmbeddedBrowserPageHostCapabilitiesSchema.parse(registration.pageHostCapabilities),
    ...(registration.cdpIdentity ? { cdpIdentity: registration.cdpIdentity } : {}),
  });
  if (!registration.panelId.trim() || !registration.ownerRef.trim()) {
    throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "Browser source identity is incomplete.", 403);
  }
  if (parsed.pageHost === "renderer-webview" && !parsed.rendererHostBinding) {
    throw new BrowserControlError("BROWSER_WINDOW_UNAVAILABLE", "A renderer-webview source requires a live renderer host binding.", 409);
  }
}

export class BrowserControlService {
  private registryEpoch = createEntityId("bep");
  private registryRevision = 0;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly sourceByPublisher = new Map<string, string>();
  private readonly creations = new Map<string, CreationRecord>();
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly tabLease = new Map<string, string>();
  private accessState: InstanceAccessState = { active: false, revision: 0 };
  private readonly accessRequests = new Map<string, AccessRequestRecord>();
  private pendingAccessRequestRef: string | undefined;
  private readonly accessWaiters = new Set<() => void>();
  private readonly cdpTokens = new Map<string, CdpAccessTokenRecord>();
  private readonly history: EmbeddedBrowserRegistryDelta[] = [];
  private readonly eventQueue: BrowserControlEvent[] = [];
  private readonly listeners = new Set<(event: BrowserControlEvent) => void>();
  private creationRevision = 0;
  private readonly creationWaiters = new Set<() => void>();
  private creationContext: CreationContextRecord | undefined;
  private creationContextRevision = 0;
  private creationDispatcher: BrowserCreationDispatcher | undefined;

  registryEpochValue() {
    return this.registryEpoch;
  }

  registryRevisionValue() {
    return this.registryRevision;
  }

  setCreationDispatcher(dispatcher: BrowserCreationDispatcher | undefined) {
    this.creationDispatcher = dispatcher;
  }

  defaultCreationContext(): { sourceRef: string; browserContextId: string; revision: number } | undefined {
    if (!this.creationContext) return undefined;
    return {
      sourceRef: this.creationContext.sourceRef,
      browserContextId: this.creationContext.sourceRef,
      revision: this.creationContextRevision,
    };
  }

  creationContextRevisionValue() {
    return this.creationContextRevision;
  }

  creationContextSnapshot(callerSourceRef?: string): EmbeddedBrowserCreationContextSnapshot {
    const now = nowMs();
    for (const creationRef of [...this.creations.keys()]) this.expireCreationIfNeeded(creationRef, now);
    const defaultSourceRef = this.creationContext?.sourceRef;
    const callerSource = callerSourceRef ? this.sources.get(callerSourceRef) : undefined;
    const panels = [...this.sources.values()]
      .filter((source) => source.state !== "expired" && (source.state !== "revoked" || source.sourceRef === defaultSourceRef))
      .map((source) => creationPanel(source, {
        isDefault: source.sourceRef === defaultSourceRef,
        canClaim: Boolean(
          callerSource
          && source.sourceRef === callerSource.sourceRef
          && source.state === "ready"
          && sourceCanCreate(source)
          && source.sourceRef !== defaultSourceRef,
        ),
      }))
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.sourceRef.localeCompare(right.sourceRef));
    const pending = [...this.creations.values()]
      .filter((creation) => creation.view.state === "pending")
      .sort((left, right) => left.view.expiresAt.localeCompare(right.view.expiresAt) || left.view.creationRef.localeCompare(right.view.creationRef))[0];
    return EmbeddedBrowserCreationContextSnapshotSchema.parse({
      revision: this.creationContextRevision,
      ...(defaultSourceRef
        ? { defaultContext: EmbeddedBrowserBrowserContextSchema.parse({ sourceRef: defaultSourceRef, browserContextId: defaultSourceRef }) }
        : {}),
      panels,
      ...(pending
        ? {
          pendingCreation: EmbeddedBrowserCreationPendingSchema.parse({
            creationRef: pending.view.creationRef,
            url: pending.view.requestedUrl,
            state: "pending",
            expiresAt: pending.view.expiresAt,
          }),
        }
        : {}),
    });
  }

  claimDefaultContext(input: {
    sourceRef: string;
    expectedRevision: number;
    panelId: string;
    ownerRef: string;
  }): EmbeddedBrowserDefaultContextClaimResult {
    const source = this.sources.get(input.sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_CREATION_CONTEXT_NOT_OWNED", "The requested browser source was not found.", 404);
    if (source.registration.panelId !== input.panelId || source.registration.ownerRef !== input.ownerRef) {
      throw new BrowserControlError("BROWSER_CREATION_CONTEXT_NOT_OWNED", "A panel can only claim its own browser source.", 403);
    }
    if (this.creationContextRevision !== input.expectedRevision) {
      throw new BrowserControlError("BROWSER_DEFAULT_CONTEXT_CONFLICT", "The default browser context revision is stale.", 409, {
        revision: this.creationContextRevision,
        ...(this.creationContext ? { defaultBrowserContextId: this.creationContext.sourceRef } : {}),
      });
    }
    if (source.state !== "ready" || !sourceCanCreate(source)) {
      throw new BrowserControlError("BROWSER_CREATION_CONTEXT_UNAVAILABLE", "The selected browser source cannot create pages.", 409, {
        revision: this.creationContextRevision,
        defaultBrowserContextId: this.creationContext?.sourceRef ?? source.sourceRef,
      });
    }
    const previous = this.creationContext?.sourceRef;
    if (previous !== source.sourceRef) {
      this.creationContext = { sourceRef: source.sourceRef, claimedAtMs: nowMs() };
      this.creationContextRevision += 1;
      this.recordCreationContextChanged(previous);
      this.dispatchPendingCreations();
    }
    return EmbeddedBrowserDefaultContextClaimResultSchema.parse({
      sourceRef: source.sourceRef,
      browserContextId: source.sourceRef,
      revision: this.creationContextRevision,
    });
  }

  clearDefaultContext(input: {
    sourceRef: string;
    expectedRevision: number;
    panelId: string;
    ownerRef: string;
  }) {
    const source = this.sources.get(input.sourceRef);
    if (!source || source.registration.panelId !== input.panelId || source.registration.ownerRef !== input.ownerRef) {
      throw new BrowserControlError("BROWSER_CREATION_CONTEXT_NOT_OWNED", "A panel can only revoke its own browser source.", 403);
    }
    if (!this.creationContext) return { cleared: false, revision: this.creationContextRevision };
    if (this.creationContextRevision !== input.expectedRevision) {
      throw new BrowserControlError("BROWSER_DEFAULT_CONTEXT_CONFLICT", "The default browser context revision is stale.", 409, {
        revision: this.creationContextRevision,
        defaultBrowserContextId: this.creationContext.sourceRef,
      });
    }
    if (this.creationContext.sourceRef !== input.sourceRef) {
      throw new BrowserControlError("BROWSER_DEFAULT_CONTEXT_CONFLICT", "The default browser context changed before it could be revoked.", 409, {
        revision: this.creationContextRevision,
        defaultBrowserContextId: this.creationContext.sourceRef,
      });
    }
    const previous = this.creationContext.sourceRef;
    this.creationContext = undefined;
    this.creationContextRevision += 1;
    this.recordCreationContextChanged(previous);
    return { cleared: true, revision: this.creationContextRevision };
  }

  browserContexts(): EmbeddedBrowserTargetGetBrowserContextsResult {
    const browserContextIds = [...this.sources.values()]
      .filter((source) => source.state === "ready")
      .map((source) => source.sourceRef)
      .sort();
    return EmbeddedBrowserTargetGetBrowserContextsResultSchema.parse({
      browserContextIds,
      ...(this.creationContext ? { defaultBrowserContextId: this.creationContext.sourceRef } : {}),
    });
  }

  targetInfos(attachedTabRefs: ReadonlySet<string> = new Set()): EmbeddedBrowserTargetGetTargetsResult {
    return EmbeddedBrowserTargetGetTargetsResultSchema.parse({
      targetInfos: this.allPages().map((page) => embeddedBrowserTargetInfoFromPage(page, attachedTabRefs.has(page.tabRef))),
    });
  }

  targetInfo(tabRef: string, attached = false): { targetInfo: EmbeddedBrowserTargetInfo } {
    return { targetInfo: embeddedBrowserTargetInfoFromPage(this.page(tabRef), attached) };
  }

  subscribe(listener: (event: BrowserControlEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishTransientEvent(type: string, payload: Record<string, unknown>) {
    this.pushEvent(type, payload);
  }

  takeEvents() {
    return this.eventQueue.splice(0, this.eventQueue.length);
  }

  registerSource(registration: BrowserSourceRegistration): EmbeddedBrowserSource {
    validateRegistration(registration);
    const now = nowMs();
    const publisherKey = sourcePublisherKey(registration);
    const existingRef = this.sourceByPublisher.get(publisherKey);
    let sourceRef: string;
    let reconnected = false;
    if (existingRef) {
      const existing = this.sources.get(existingRef);
      if (!existing) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
      if (existing.registration.panelId !== registration.panelId || existing.registration.ownerRef !== registration.ownerRef) {
        throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "Browser source belongs to another publisher.", 403);
      }
      existing.generation += 1;
      existing.registration = registration;
      existing.state = "pending";
      existing.snapshot = undefined;
      existing.disconnectedAt = undefined;
      sourceRef = existing.sourceRef;
      reconnected = true;
    } else {
      if (this.sources.size >= EMBEDDED_BROWSER_MAX_SOURCES) {
        throw new BrowserControlError("BROWSER_LIMIT_EXCEEDED", "The browser source limit has been reached.", 409);
      }
      sourceRef = createEntityId("bsr");
      const source: SourceRecord = {
        sourceRef,
        generation: 1,
        registration,
        state: "pending",
        sourceRevision: 0,
        pages: new Map(),
      };
      this.sources.set(sourceRef, source);
      this.sourceByPublisher.set(publisherKey, sourceRef);
    }
    if (reconnected) {
      // A transport reconnect starts a new generation. Retained page-pool pages
      // may only be shown unavailable until a new snapshot re-establishes identity.
      this.failActiveCreationsForSource(sourceRef);
      this.removeAllSourcePages(sourceRef, "source-reconnected");
      this.removeLeasesForSource(sourceRef, now);
    }
    const source = publicSource(this.sources.get(sourceRef)!);
    this.recordSourceEvent(sourceRef, source.pageHost, "pending");
    return source;
  }

  commitSnapshot(raw: EmbeddedBrowserSourceSnapshot) {
    const snapshot = EmbeddedBrowserSourceSnapshotSchema.parse(raw);
    const now = nowMs();
    this.validateSnapshot(snapshot);
    const source = this.sources.get(snapshot.sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    const index = snapshot.chunkIndex;
    if (!source.snapshot) {
      source.snapshot = {
        snapshotRef: snapshot.snapshotRef,
        sourceRevision: snapshot.sourceRevision,
        registryEpoch: snapshot.registryEpoch,
        chunks: new Array(snapshot.chunkCount),
      };
    }
    const assembly = source.snapshot;
    if (assembly.snapshotRef !== snapshot.snapshotRef
      || assembly.sourceRevision !== snapshot.sourceRevision
      || assembly.registryEpoch !== snapshot.registryEpoch
      || assembly.chunks.length !== snapshot.chunkCount) {
      throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Snapshot chunks do not belong to one snapshot transaction.", 409);
    }
    if (index >= assembly.chunks.length) {
      throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Snapshot chunk index is outside the snapshot manifest.", 409);
    }
    assembly.chunks[index] = snapshot.pages;
    if (!snapshot.complete || assembly.chunks.some((chunk) => chunk === undefined)) {
      source.state = "syncing";
      return;
    }
    const pages = new Map<string, EmbeddedBrowserPage>();
    for (const page of assembly.chunks.flatMap((chunk) => chunk ?? [])) {
      if (page.sourceRef !== snapshot.sourceRef || page.generation !== snapshot.generation) {
        throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Snapshot page does not belong to the declared source generation.", 409);
      }
      pages.set(page.tabRef, page);
    }
    if (pages.size > EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE) {
      throw new BrowserControlError("BROWSER_LIMIT_EXCEEDED", "The browser page limit has been reached.", 409);
    }
    const removed = [...source.pages.keys()].filter((tabRef) => !pages.has(tabRef));
    const upserts = [...pages.values()];
    source.pages = pages;
    source.sourceRevision = snapshot.sourceRevision;
    source.snapshot = undefined;
    source.state = "syncing";
    this.removeLeasesForTabs(removed, now);
    this.recordRegistryDelta(source.sourceRef, source.registration.pageHost, upserts, removed);
  }

  commitDelta(raw: EmbeddedBrowserSourceDelta) {
    const delta = EmbeddedBrowserSourceDeltaSchema.parse(raw);
    const now = nowMs();
    const source = this.sources.get(delta.sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    if (source.generation !== delta.generation) throw new BrowserControlError("BROWSER_LEASE_STALE", "Source generation is stale.", 409);
    if (source.state !== "syncing" && source.state !== "ready") {
      throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Browser source is not ready for deltas.", 409);
    }
    if (delta.baseRevision !== source.sourceRevision) {
      throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser source revision is not contiguous.", 409);
    }
    const nextPages = new Map(source.pages);
    for (const tabRef of delta.removes) nextPages.delete(tabRef);
    for (const page of delta.upserts) nextPages.set(page.tabRef, page);
    if (nextPages.size > EMBEDDED_BROWSER_MAX_PAGES_PER_SOURCE) {
      throw new BrowserControlError("BROWSER_LIMIT_EXCEEDED", "The browser page limit has been reached.", 409);
    }
    source.pages = nextPages;
    source.sourceRevision = delta.revision;
    this.removeLeasesForTabs(delta.removes, now);
    this.recordRegistryDelta(delta.sourceRef, source.registration.pageHost, delta.upserts, delta.removes);
    return delta.revision;
  }

  syncSourceIfCurrent(sourceRef: string, generation: number, registryEpoch: string, registryRevision: number) {
    if (this.registryEpoch !== registryEpoch || this.registryRevision !== registryRevision) return false;
    const source = this.sources.get(sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    if (source.generation !== generation) throw new BrowserControlError("BROWSER_LEASE_STALE", "Source generation is stale.", 409);
    if (source.state === "ready") return true;
    if (source.state !== "syncing") {
      throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Browser source is not waiting for sync confirmation.", 409);
    }
    source.state = "ready";
    this.recordSourceEvent(sourceRef, source.registration.pageHost, "ready");
    return true;
  }

  sourceBinding(sourceRef: string, generation: number): BrowserControlSourceBinding {
    const source = this.sources.get(sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    if (source.generation !== generation) throw new BrowserControlError("BROWSER_LEASE_STALE", "Source generation is stale.", 409);
    return {
      sourceRef: source.sourceRef,
      generation: source.generation,
      pageHost: source.registration.pageHost,
      pageHostCapabilities: source.registration.pageHostCapabilities,
      state: source.state,
      sourceRevision: source.sourceRevision,
      registryEpoch: this.registryEpoch,
      registryRevision: this.registryRevision,
    };
  }

  sourceGeneration(sourceRef: string) {
    return this.sources.get(sourceRef)?.generation;
  }

  disconnectSource(sourceRef: string, generation: number) {
    const source = this.sources.get(sourceRef);
    if (!source || source.generation !== generation) return;
    const now = nowMs();
    source.snapshot = undefined;
    if (source.registration.pageHost === "renderer-webview") {
      source.state = "closed";
    } else {
      source.state = "disconnected";
      source.disconnectedAt = now;
    }
    this.removeLeasesForSource(sourceRef, now);
    this.failActiveCreationsForSource(sourceRef);
    if (source.registration.pageHost === "renderer-webview") this.removeAllSourcePages(sourceRef, "renderer-host-closed");
    else this.markSourcePagesUnavailable(sourceRef);
    this.recordSourceEvent(sourceRef, source.registration.pageHost, source.state);
  }

  revokeSource(sourceRef: string, reason: string) {
    const source = this.sources.get(sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    source.state = "revoked";
    source.snapshot = undefined;
    this.removeLeasesForSource(sourceRef, nowMs());
    this.failActiveCreationsForSource(sourceRef);
    this.removeAllSourcePages(sourceRef, reason);
    this.recordSourceEvent(sourceRef, source.registration.pageHost, "revoked");
  }

  prune(now = nowMs()) {
    let expired = 0;
    for (const source of this.sources.values()) {
      if (source.state !== "disconnected") continue;
      if (source.disconnectedAt === undefined || now - source.disconnectedAt < SOURCE_RECOVERY_WINDOW_MS) continue;
      source.state = "expired";
      source.snapshot = undefined;
      this.removeLeasesForSource(source.sourceRef, now);
      this.failActiveCreationsForSource(source.sourceRef);
      this.removeAllSourcePages(source.sourceRef, "source-expired");
      this.recordSourceEvent(source.sourceRef, source.registration.pageHost, "expired");
      expired += 1;
    }
    expired += this.pruneCreations(now);
    this.removeExpiredLeases(now);
    return expired;
  }

  access(): EmbeddedBrowserAccessView {
    const pendingRequest = this.expireAccessRequestIfNeeded(nowMs());
    return EmbeddedBrowserAccessViewSchema.parse({
      active: this.accessState.active,
      revision: this.accessState.revision,
      ...(pendingRequest ? { pendingRequest } : {}),
    });
  }

  requestInstanceAccess(sessionRef: string): EmbeddedBrowserAccessRequestView | undefined {
    const now = nowMs();
    this.expireAccessRequestIfNeeded(now);
    if (this.accessState.active) return undefined;
    if (this.pendingAccessRequestRef) {
      const pending = this.accessRequests.get(this.pendingAccessRequestRef);
      if (pending?.state === "pending") return pending.view;
    }
    const view = EmbeddedBrowserAccessRequestViewSchema.parse({
      requestRef: createEntityId("breq"),
      requesterSessionRef: sessionRef,
      revision: 0,
      createdAt: rfc3339(now),
      expiresAt: rfc3339(now + EMBEDDED_BROWSER_ACCESS_REQUEST_TTL_MS),
    });
    this.accessRequests.set(view.requestRef, { view, state: "pending" });
    this.pendingAccessRequestRef = view.requestRef;
    this.trimAccessRequests();
    this.recordAccessRequestEvent(view, "pending");
    return view;
  }

  grantInstanceAccess(options: { requestRef?: string; expectedRevision?: number } = {}) {
    const now = nowMs();
    this.expireAccessRequestIfNeeded(now);
    const pendingRef = this.pendingAccessRequestRef;
    if (options.requestRef) {
      const record = this.accessRequests.get(options.requestRef);
      if (record?.state !== "pending" || pendingRef !== options.requestRef) {
        throw new BrowserControlError("BROWSER_ACCESS_REQUEST_STALE", "The browser access request is no longer pending.", 409, {
          ...(pendingRef ? { requestRef: pendingRef } : {}),
        });
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== record.view.revision) {
        throw new BrowserControlError("BROWSER_ACCESS_REQUEST_STALE", "The browser access request changed before it was approved.", 409, {
          requestRef: options.requestRef,
        });
      }
    }
    let changed = false;
    if (!this.accessState.active) {
      this.accessState = { active: true, revision: this.accessState.revision + 1 };
      changed = true;
    }
    if (pendingRef) {
      const record = this.accessRequests.get(pendingRef);
      if (record?.state === "pending") {
        record.state = "approved";
        record.view = EmbeddedBrowserAccessRequestViewSchema.parse({ ...record.view, revision: record.view.revision + 1 });
        this.recordAccessRequestEvent(record.view, "approved");
      }
      this.pendingAccessRequestRef = undefined;
    }
    const view = this.access();
    if (changed) this.pushEvent("browser.access.changed", { active: view.active, revision: view.revision });
    this.notifyAccessWaiters();
    return view;
  }

  denyInstanceAccessRequest(requestRef: string, expectedRevision?: number) {
    const now = nowMs();
    this.expireAccessRequestIfNeeded(now);
    const record = this.accessRequests.get(requestRef);
    if (record?.state !== "pending" || this.pendingAccessRequestRef !== requestRef) {
      throw new BrowserControlError("BROWSER_ACCESS_REQUEST_STALE", "The browser access request is no longer pending.", 409);
    }
    if (expectedRevision !== undefined && expectedRevision !== record.view.revision) {
      throw new BrowserControlError("BROWSER_ACCESS_REQUEST_STALE", "The browser access request changed before it was denied.", 409, {
        requestRef,
      });
    }
    record.state = "denied";
    record.view = EmbeddedBrowserAccessRequestViewSchema.parse({ ...record.view, revision: record.view.revision + 1 });
    this.pendingAccessRequestRef = undefined;
    this.recordAccessRequestEvent(record.view, "denied");
    this.notifyAccessWaiters();
    return record.view;
  }

  async waitForAccessDecision(requestRef: string, timeoutMs: number): Promise<BrowserAccessDecision> {
    const deadline = nowMs() + Math.max(0, timeoutMs);
    while (true) {
      if (this.accessState.active) {
        const record = this.accessRequests.get(requestRef);
        return { status: "granted", request: record?.view ?? this.pendingOrSyntheticRequest(requestRef) };
      }
      const record = this.accessRequests.get(requestRef);
      if (!record) {
        return {
          status: "expired",
          request: EmbeddedBrowserAccessRequestViewSchema.parse({
            requestRef,
            requesterSessionRef: "",
            revision: 0,
            createdAt: rfc3339(Math.max(0, deadline - EMBEDDED_BROWSER_ACCESS_REQUEST_TTL_MS)),
            expiresAt: rfc3339(deadline),
          }),
        };
      }
      if (record.state === "denied") return { status: "denied", request: record.view };
      if (record.state === "expired" || record.state === "cancelled") return { status: "expired", request: record.view };
      if (record.state === "approved") {
        const latest = this.accessRequests.get(requestRef) ?? record;
        return { status: this.accessState.active ? "granted" : "expired", request: latest.view };
      }
      const remaining = deadline - nowMs();
      if (remaining <= 0) return { status: "pending", request: record.view };
      await this.waitForAccessChange(remaining);
    }
  }

  issueCdpToken(sessionRef: string) {
    const now = nowMs();
    if (!this.accessState.active) {
      throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "Agent browser access is not enabled for this controlled instance.", 403);
    }
    for (const [token, record] of this.cdpTokens) if (record.expiresAtMs <= now) this.cdpTokens.delete(token);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAtMs = now + EMBEDDED_BROWSER_CDP_ACCESS_TTL_MS;
    this.cdpTokens.set(token, { sessionRef, accessRevision: this.accessState.revision, expiresAtMs });
    return { token, expiresAt: rfc3339(expiresAtMs) };
  }

  validateCdpToken(token: string) {
    const now = nowMs();
    for (const [value, record] of this.cdpTokens) if (record.expiresAtMs <= now) this.cdpTokens.delete(value);
    if (!this.accessState.active) return undefined;
    const record = this.cdpTokens.get(token);
    return record?.accessRevision === this.accessState.revision ? record.sessionRef : undefined;
  }

  revokeInstanceAccess() {
    const pendingRef = this.pendingAccessRequestRef;
    this.accessState = { active: false, revision: this.accessState.revision + 1 };
    if (pendingRef) {
      const record = this.accessRequests.get(pendingRef);
      if (record?.state === "pending") {
        record.state = "cancelled";
        record.view = EmbeddedBrowserAccessRequestViewSchema.parse({ ...record.view, revision: record.view.revision + 1 });
        this.recordAccessRequestEvent(record.view, "cancelled");
      }
      this.pendingAccessRequestRef = undefined;
    }
    this.cdpTokens.clear();
    const leases = [...this.leases.keys()];
    for (const leaseRef of leases) this.removeLease(leaseRef);
    if (this.creationContext) {
      const previous = this.creationContext.sourceRef;
      this.creationContext = undefined;
      this.creationContextRevision += 1;
      this.recordCreationContextChanged(previous);
    }
    this.failAllActiveCreations();
    this.pushEvent("browser.access.changed", { active: false, revision: this.accessState.revision });
    this.notifyAccessWaiters();
    return leases.length;
  }

  cleanupSession(sessionRef: string) {
    const now = nowMs();
    for (const [token, record] of this.cdpTokens) if (record.sessionRef === sessionRef) this.cdpTokens.delete(token);
    const leases = [...this.leases.entries()].filter(([, record]) => record.sessionRef === sessionRef).map(([leaseRef]) => leaseRef);
    for (const leaseRef of leases) this.removeLease(leaseRef);
    this.removeExpiredLeases(now);
    return leases.length;
  }

  sessionHasCdpTokens(sessionRef: string) {
    const now = nowMs();
    return [...this.cdpTokens.values()].some((record) => record.sessionRef === sessionRef && record.expiresAtMs > now);
  }

  listSources() {
    return [...this.sources.values()].filter((source) => source.state === "ready").map(publicSource);
  }

  sourceOwner(sourceRef: string) {
    const source = this.sources.get(sourceRef);
    return source ? { panelId: source.registration.panelId, ownerRef: source.registration.ownerRef } : undefined;
  }

  listPages(cursor?: string, limit?: number) {
    const pages = this.allPages();
    const offset = parseCursor(cursor, this.registryEpoch);
    const boundedLimit = Math.min(Math.max(limit || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const items = pages.slice(offset, offset + boundedLimit);
    return EmbeddedBrowserPageListResponseSchema.parse({
      registryEpoch: this.registryEpoch,
      registryRevision: this.registryRevision,
      items,
      ...(pages.length > offset + items.length ? { cursor: `${this.registryEpoch}:${offset + boundedLimit}` } : {}),
    });
  }

  allPages() {
    return [...this.sources.values()]
      .filter((source) => source.state === "ready")
      .flatMap((source) => [...source.pages.values()])
      .sort((left, right) => left.tabRef.localeCompare(right.tabRef));
  }

  browserCdpIdentity(sessionRef?: string): EmbeddedBrowserCdpIdentity | undefined {
    if (sessionRef) {
      this.removeExpiredLeases(nowMs());
      for (const record of this.leases.values()) {
        if (record.sessionRef !== sessionRef) continue;
        const source = this.sources.get(record.lease.sourceRef);
        if (source?.state === "ready" && source.registration.cdpIdentity) {
          return source.registration.cdpIdentity;
        }
      }
    }
    for (const source of this.sources.values()) {
      if (source.state === "ready" && source.registration.cdpIdentity) {
        return source.registration.cdpIdentity;
      }
    }
    return undefined;
  }

  page(tabRef: string) {
    for (const source of this.sources.values()) {
      if (source.state !== "ready") continue;
      const page = source.pages.get(tabRef);
      if (page) return page;
    }
    throw new BrowserControlError("BROWSER_TAB_NOT_FOUND", "Browser tab was not found.", 404);
  }

  registryDeltaSince(registryEpoch: string, afterRevision: number): EmbeddedBrowserRegistryDelta {
    if (registryEpoch !== this.registryEpoch) throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser registry epoch changed.", 409);
    if (afterRevision > this.registryRevision) throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser registry revision is ahead of the instance.", 409);
    if (afterRevision === this.registryRevision) {
      return EmbeddedBrowserRegistryDeltaSchema.parse({ registryEpoch, baseRevision: afterRevision, revision: afterRevision, upserts: [], removes: [] });
    }
    const relevant = this.history.filter((delta) => delta.revision > afterRevision);
    if (!relevant.length || relevant[0]!.baseRevision !== afterRevision) {
      throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser registry delta history is unavailable.", 409);
    }
    const upserts = new Map<string, EmbeddedBrowserPage>();
    const removes = new Set<string>();
    let revision = afterRevision;
    for (const delta of relevant) {
      if (delta.baseRevision !== revision) break;
      if (upserts.size + delta.upserts.length > MAX_PAGE_LIMIT) break;
      revision = delta.revision;
      for (const page of delta.upserts) {
        removes.delete(page.tabRef);
        upserts.set(page.tabRef, page);
      }
      for (const tabRef of delta.removes) {
        upserts.delete(tabRef);
        removes.add(tabRef);
      }
    }
    return EmbeddedBrowserRegistryDeltaSchema.parse({
      registryEpoch,
      baseRevision: afterRevision,
      revision,
      upserts: [...upserts.values()],
      removes: [...removes],
    });
  }

  requestCreation(sessionRef: string, url: string, title?: string, options: { browserContextId?: string } = {}) {
    const now = nowMs();
    this.pruneCreations(now);
    const active = [...this.creations.values()].filter((creation) => ["pending", "claimed", "creating"].includes(creation.view.state)).length;
    if (active >= MAX_ACTIVE_CREATIONS) throw new BrowserControlError("BROWSER_LIMIT_EXCEEDED", "Too many browser creation requests are active.", 409);

    let dispatchSourceRef: string | undefined;
    const defaultSourceRef = this.creationContext?.sourceRef;
    if (defaultSourceRef) {
      if (options.browserContextId && options.browserContextId !== defaultSourceRef) {
        throw new BrowserControlError("BROWSER_CREATION_CONTEXT_NOT_SELECTED", "The requested browser context is not the default creation context.", 409, {
          revision: this.creationContextRevision,
          defaultBrowserContextId: defaultSourceRef,
        });
      }
      const defaultSource = this.sources.get(defaultSourceRef);
      if (!defaultSource || !sourceCanCreate(defaultSource)) {
        throw new BrowserControlError("BROWSER_CREATION_CONTEXT_UNAVAILABLE", "The default browser creation source is offline or cannot create pages.", 409, {
          revision: this.creationContextRevision,
          defaultBrowserContextId: defaultSourceRef,
        });
      }
      dispatchSourceRef = defaultSourceRef;
    } else {
      const candidates = this.creationCandidates();
      if (options.browserContextId) {
        if (candidates.length !== 1 || candidates[0]!.sourceRef !== options.browserContextId) {
          throw new BrowserControlError("BROWSER_CREATION_CONTEXT_NOT_SELECTED", "No default browser creation context is selected.", 409, {
            revision: this.creationContextRevision,
          });
        }
        this.bindDefaultSource(candidates[0]!.sourceRef);
        dispatchSourceRef = candidates[0]!.sourceRef;
      } else if (candidates.length === 1) {
        this.bindDefaultSource(candidates[0]!.sourceRef);
        dispatchSourceRef = candidates[0]!.sourceRef;
      } else if (candidates.length === 0) {
        throw new BrowserControlError("BROWSER_CREATION_NO_CANDIDATE", "No desktop source can create a browser page.", 409);
      }
    }

    const candidates = this.creationCandidates();
    const creationRef = createEntityId("bcr");
    const view = EmbeddedBrowserCreationViewSchema.parse({
      creationRef,
      requestedUrl: normalizedText(url, 4_096, "about:blank"),
      ...(title?.trim() ? { title: title.trim().slice(0, 512) } : {}),
      state: "pending",
      expiresAt: rfc3339(now + EMBEDDED_BROWSER_CREATION_TTL_MS),
      candidates,
      revision: 1,
    });
    this.creations.set(creationRef, {
      view,
      requesterSessionRef: sessionRef,
      expiresAtMs: now + EMBEDDED_BROWSER_CREATION_TTL_MS,
    });
    this.recordCreationEvent(view);
    if (dispatchSourceRef) this.launchCreation(creationRef, dispatchSourceRef);
    return this.creations.get(creationRef)!.view;
  }

  getCreation(sessionRef: string, creationRef: string) {
    const now = nowMs();
    this.expireCreationIfNeeded(creationRef, now);
    const creation = this.creations.get(creationRef);
    if (!creation || creation.requesterSessionRef !== sessionRef) {
      throw new BrowserControlError("BROWSER_CREATION_NOT_FOUND", "Browser creation request was not found.", 404);
    }
    return creation.view;
  }

  async waitForCreation(sessionRef: string, creationRef: string, timeoutMs: number) {
    const deadline = nowMs() + Math.max(0, timeoutMs);
    for (;;) {
      const view = this.getCreation(sessionRef, creationRef);
      if (["ready", "failed", "declined", "expired"].includes(view.state)) return view;
      const remaining = deadline - nowMs();
      if (remaining <= 0) return view;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.creationWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, remaining);
        timer.unref?.();
        this.creationWaiters.add(finish);
      });
    }
  }

  completeCreation(sourceRef: string, creationRef: string, tabRef: string) {
    const creation = this.creations.get(creationRef);
    if (!creation) throw new BrowserControlError("BROWSER_CREATION_NOT_FOUND", "Browser creation request was not found.", 404);
    const pageExists = this.sources.get(sourceRef)?.pages.has(tabRef) === true;
    if (!pageExists) throw new BrowserControlError("BROWSER_TAB_NOT_FOUND", "Browser tab was not registered by the source.", 409);
    if (creation.view.state === "ready" && creation.view.tabRef === tabRef) return creation.view;
    if (creation.claimedSourceRef !== sourceRef || !["claimed", "creating"].includes(creation.view.state)) {
      throw new BrowserControlError("BROWSER_CREATION_CONFLICT", "Browser creation request was not claimed by this source.", 409);
    }
    creation.view = EmbeddedBrowserCreationViewSchema.parse({ ...creation.view, state: "ready", tabRef, revision: creation.view.revision + 1 });
    this.recordCreationEvent(creation.view);
    return creation.view;
  }

  failCreation(sourceRef: string, creationRef: string, _reason: string) {
    const creation = this.creations.get(creationRef);
    if (!creation) throw new BrowserControlError("BROWSER_CREATION_NOT_FOUND", "Browser creation request was not found.", 404);
    if (creation.claimedSourceRef !== sourceRef) throw new BrowserControlError("BROWSER_CREATION_CONFLICT", "Browser creation request was not claimed by this source.", 409);
    if (["failed", "expired", "declined", "ready"].includes(creation.view.state)) return creation.view;
    creation.view = EmbeddedBrowserCreationViewSchema.parse({ ...creation.view, state: "failed", revision: creation.view.revision + 1 });
    this.recordCreationEvent(creation.view);
    return creation.view;
  }

  failCreationIfActive(sourceRef: string, creationRef: string, reason: string) {
    const creation = this.creations.get(creationRef);
    if (!creation || creation.claimedSourceRef !== sourceRef || !["claimed", "creating"].includes(creation.view.state)) return undefined;
    return this.failCreation(sourceRef, creationRef, reason);
  }

  attachTab(sessionRef: string, tabRef: string, ttlMs = LEASE_TTL_MS) {
    const now = nowMs();
    if (!this.accessState.active) throw new BrowserControlError("BROWSER_AUTHORIZATION_REQUIRED", "Agent browser access is not enabled for this controlled instance.", 403);
    this.removeExpiredLeases(now);
    const located = this.locatePage(tabRef);
    if (!located) throw new BrowserControlError("BROWSER_TAB_NOT_FOUND", "Browser tab was not found.", 404);
    const existingLeaseRef = this.tabLease.get(tabRef);
    if (existingLeaseRef) {
      const existing = this.leases.get(existingLeaseRef);
      if (existing) {
        if (existing.sessionRef !== sessionRef) throw new BrowserControlError("BROWSER_TARGET_BUSY", "Browser tab is controlled by another AI Session.", 409);
        return existing.lease;
      }
    }
    const leaseRef = createEntityId("blr");
    const lease = EmbeddedBrowserLeaseSchema.parse({
      leaseRef,
      tabRef,
      sourceRef: located.source.sourceRef,
      generation: located.source.generation,
      expiresAt: rfc3339(now + ttlMs),
    });
    this.leases.set(leaseRef, { lease, sessionRef, expiresAtMs: now + ttlMs });
    this.tabLease.set(tabRef, leaseRef);
    this.recordLeaseEvent(lease, "attached");
    return lease;
  }

  leaseCommandTarget(sessionRef: string, leaseRef: string): BrowserLeaseCommandTarget {
    const now = nowMs();
    this.removeExpiredLeases(now);
    const record = this.leases.get(leaseRef);
    if (!record || record.sessionRef !== sessionRef) throw new BrowserControlError("BROWSER_LEASE_STALE", "Browser lease is stale.", 404);
    const located = this.locatePage(record.lease.tabRef);
    if (!located) throw new BrowserControlError("BROWSER_TAB_NOT_FOUND", "Browser tab was not found.", 404);
    if (located.source.sourceRef !== record.lease.sourceRef || located.source.generation !== record.lease.generation) {
      throw new BrowserControlError("BROWSER_LEASE_STALE", "Browser page generation changed after attach.", 409);
    }
    return {
      lease: record.lease,
      page: located.page,
      ...(located.source.registration.rendererHostBinding ? { rendererHostBinding: located.source.registration.rendererHostBinding } : {}),
    };
  }

  detachLease(sessionRef: string, leaseRef: string) {
    const record = this.leases.get(leaseRef);
    if (!record || record.sessionRef !== sessionRef) return false;
    return this.removeLease(leaseRef);
  }

  leaseRefsForSession(sessionRef: string) {
    this.removeExpiredLeases(nowMs());
    return [...this.leases.entries()].filter(([, record]) => record.sessionRef === sessionRef).map(([leaseRef]) => leaseRef);
  }

  leaseForSessionTab(sessionRef: string, tabRef: string) {
    this.removeExpiredLeases(nowMs());
    for (const record of this.leases.values()) {
      if (record.sessionRef === sessionRef && record.lease.tabRef === tabRef) return record.lease;
    }
    return undefined;
  }

  leaseTargetsAll() {
    this.removeExpiredLeases(nowMs());
    return [...this.leases.entries()].map(([leaseRef, record]) => ({ sessionRef: record.sessionRef, leaseRef }));
  }

  leaseSession(leaseRef: string, tabRef: string, sourceRef: string, generation: number) {
    const record = this.leases.get(leaseRef);
    if (!record || record.lease.tabRef !== tabRef || record.lease.sourceRef !== sourceRef || record.lease.generation !== generation) return undefined;
    return record.sessionRef;
  }

  invalidateLease(leaseRef: string) {
    return this.removeLease(leaseRef);
  }

  attachedTabRefsForSession(sessionRef: string) {
    this.removeExpiredLeases(nowMs());
    return new Set(
      [...this.leases.values()]
        .filter((record) => record.sessionRef === sessionRef)
        .map((record) => record.lease.tabRef),
    );
  }

  invalidateLeasesForTab(tabRef: string) {
    const leaseRefs = [...this.leases.entries()]
      .filter(([, record]) => record.lease.tabRef === tabRef)
      .map(([leaseRef]) => leaseRef);
    for (const leaseRef of leaseRefs) this.removeLease(leaseRef);
    return leaseRefs;
  }

  creationCandidates() {
    return [...this.sources.values()]
      .filter((source) => source.state === "ready")
      .map(creationCandidate)
      .filter((candidate): candidate is EmbeddedBrowserCreationCandidate => Boolean(candidate?.canCreate))
      .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  }

  isPageHostReady(pageHost: EmbeddedBrowserPageHost) {
    return [...this.sources.values()].some((source) => source.state === "ready" && source.registration.pageHost === pageHost);
  }

  pageProfile() {
    return EMBEDDED_BROWSER_CDP_PROFILE;
  }

  capabilities(): EmbeddedBrowserChannelCapabilities {
    return EmbeddedBrowserChannelCapabilitiesSchema.parse({
      supported: true,
      transports: ["reverse-websocket"],
      streamKinds: ["control"],
      drivers: ["electron-page-cdp"],
      pageHosts: ["renderer-webview", "main-page-pool"],
      targetCdp: true,
    });
  }

  private validateSnapshot(snapshot: EmbeddedBrowserSourceSnapshot) {
    if (snapshot.registryEpoch !== this.registryEpoch) throw new BrowserControlError("BROWSER_SNAPSHOT_REQUIRED", "Browser registry epoch changed.", 409);
    const source = this.sources.get(snapshot.sourceRef);
    if (!source) throw new BrowserControlError("BROWSER_SOURCE_NOT_FOUND", "Browser source was not found.", 404);
    if (source.generation !== snapshot.generation) throw new BrowserControlError("BROWSER_LEASE_STALE", "Source generation is stale.", 409);
    if (!["pending", "syncing", "ready"].includes(source.state)) {
      throw new BrowserControlError("BROWSER_SOURCE_UNAVAILABLE", "Browser source is not accepting snapshots.", 409);
    }
    if (snapshot.chunkCount === 0 || snapshot.pages.length > EMBEDDED_BROWSER_SNAPSHOT_MAX_PAGES_PER_CHUNK) {
      throw new BrowserControlError("BROWSER_LIMIT_EXCEEDED", "Browser snapshot chunk exceeds the limit.", 409);
    }
  }

  private locatePage(tabRef: string) {
    for (const source of this.sources.values()) {
      if (source.state !== "ready") continue;
      const page = source.pages.get(tabRef);
      if (page) return { source, page };
    }
    return undefined;
  }

  private recordRegistryDelta(sourceRef: string, pageHost: EmbeddedBrowserPageHost, upserts: EmbeddedBrowserPage[], removes: string[]) {
    if (!upserts.length && !removes.length) {
      this.pushEvent("browser.registry.changed", {
        sourceRef,
        pageHost,
        registryEpoch: this.registryEpoch,
        registryRevision: this.registryRevision,
      });
      return;
    }
    const baseRevision = this.registryRevision;
    this.registryRevision += 1;
    const delta = EmbeddedBrowserRegistryDeltaSchema.parse({
      registryEpoch: this.registryEpoch,
      baseRevision,
      revision: this.registryRevision,
      upserts,
      removes,
    });
    this.history.push(delta);
    while (this.history.length > REGISTRY_HISTORY_LIMIT) this.history.shift();
    this.pushEvent("browser.registry.changed", {
      sourceRef,
      pageHost,
      registryEpoch: this.registryEpoch,
      registryRevision: this.registryRevision,
    });
  }

  private recordSourceEvent(sourceRef: string, pageHost: EmbeddedBrowserPageHost, state: string) {
    this.pushEvent("browser.source.changed", {
      sourceRef,
      pageHost,
      state,
      registryEpoch: this.registryEpoch,
      registryRevision: this.registryRevision,
    });
  }

  private bindDefaultSource(sourceRef: string) {
    if (this.creationContext?.sourceRef === sourceRef) return;
    const source = this.sources.get(sourceRef);
    if (!source || source.state !== "ready" || !sourceCanCreate(source)) {
      throw new BrowserControlError("BROWSER_CREATION_CONTEXT_UNAVAILABLE", "The browser source cannot create pages.", 409, {
        revision: this.creationContextRevision,
      });
    }
    const previous = this.creationContext?.sourceRef;
    this.creationContext = { sourceRef, claimedAtMs: nowMs() };
    this.creationContextRevision += 1;
    this.recordCreationContextChanged(previous);
    this.dispatchPendingCreations();
  }

  private dispatchPendingCreations() {
    const sourceRef = this.creationContext?.sourceRef;
    if (!sourceRef) return;
    for (const [creationRef, creation] of [...this.creations]) {
      if (creation.view.state !== "pending") continue;
      this.launchCreation(creationRef, sourceRef);
    }
  }

  private launchCreation(creationRef: string, sourceRef: string) {
    const creation = this.creations.get(creationRef);
    if (!creation || creation.view.state !== "pending") return;
    const source = this.sources.get(sourceRef);
    if (!source || source.state !== "ready" || !sourceCanCreate(source)) return;
    const dispatcher = this.creationDispatcher;
    if (!dispatcher) return;
    creation.claimedSourceRef = sourceRef;
    creation.claimedGeneration = source.generation;
    creation.claimedRendererHostBinding = source.registration.rendererHostBinding;
    creation.view = EmbeddedBrowserCreationViewSchema.parse({
      ...creation.view,
      state: "creating",
      revision: creation.view.revision + 1,
    });
    this.recordCreationEvent(creation.view);
    void dispatcher(creation.view, {
      sourceRef,
      generation: source.generation,
      requesterSessionRef: creation.requesterSessionRef,
    }).catch((error) => {
      try { this.failCreation(sourceRef, creationRef, error instanceof Error ? error.message : String(error)); } catch { /* Creation may already be settled. */ }
    });
  }

  private pruneCreations(now: number) {
    let expired = 0;
    for (const creationRef of [...this.creations.keys()]) {
      if (this.expireCreationIfNeeded(creationRef, now)) expired += 1;
    }
    for (const [creationRef, creation] of [...this.creations]) {
      if (["ready", "failed", "declined", "expired"].includes(creation.view.state) && creation.expiresAtMs + 10 * 60_000 < now) {
        this.creations.delete(creationRef);
      }
    }
    return expired;
  }

  private failAllActiveCreations() {
    for (const creation of [...this.creations.values()]) {
      if (!["pending", "claimed", "creating"].includes(creation.view.state)) continue;
      creation.view = EmbeddedBrowserCreationViewSchema.parse({
        ...creation.view,
        state: "failed",
        revision: creation.view.revision + 1,
      });
      this.recordCreationEvent(creation.view);
    }
  }

  private recordCreationContextChanged(previousSourceRef?: string) {
    this.pushEvent("browser.creation-context.changed", {
      revision: this.creationContextRevision,
      ...(this.creationContext ? { defaultBrowserContextId: this.creationContext.sourceRef } : {}),
      ...(previousSourceRef ? { previousBrowserContextId: previousSourceRef } : {}),
    });
  }

  private recordCreationEvent(view: EmbeddedBrowserCreationView) {
    const creation = this.creations.get(view.creationRef);
    this.creationRevision += 1;
    this.pushEvent("browser.creation.changed", {
      creationRef: view.creationRef,
      state: view.state,
      revision: view.revision,
      ...(view.tabRef ? { tabRef: view.tabRef } : {}),
      creationRevision: this.creationRevision,
      requesterSessionRef: creation?.requesterSessionRef ?? "",
      requestedUrl: view.requestedUrl,
      ...(view.title ? { title: view.title } : {}),
      expiresAt: view.expiresAt,
      candidates: view.candidates,
    });
    for (const waiter of [...this.creationWaiters]) waiter();
  }

  private recordLeaseEvent(lease: EmbeddedBrowserLease, state: string) {
    this.pushEvent("browser.lease.changed", { leaseRef: lease.leaseRef, tabRef: lease.tabRef, state });
  }

  private recordAccessRequestEvent(view: EmbeddedBrowserAccessRequestView, state: BrowserAccessRequestState) {
    this.pushEvent("browser.access.request.changed", {
      requestRef: view.requestRef,
      state,
      revision: view.revision,
    });
  }

  private expireAccessRequestIfNeeded(now: number): EmbeddedBrowserAccessRequestView | undefined {
    const pendingRef = this.pendingAccessRequestRef;
    if (!pendingRef) return undefined;
    const record = this.accessRequests.get(pendingRef);
    if (!record || record.state !== "pending") {
      this.pendingAccessRequestRef = undefined;
      return undefined;
    }
    if (Date.parse(record.view.expiresAt) > now) return record.view;
    record.state = "expired";
    record.view = EmbeddedBrowserAccessRequestViewSchema.parse({ ...record.view, revision: record.view.revision + 1 });
    this.pendingAccessRequestRef = undefined;
    this.recordAccessRequestEvent(record.view, "expired");
    this.notifyAccessWaiters();
    return undefined;
  }

  private trimAccessRequests() {
    const resolved = [...this.accessRequests.entries()].filter(([requestRef, record]) => record.state !== "pending" && requestRef !== this.pendingAccessRequestRef);
    for (const [requestRef] of resolved.slice(0, Math.max(0, resolved.length - 8))) this.accessRequests.delete(requestRef);
  }

  private pendingOrSyntheticRequest(requestRef: string): EmbeddedBrowserAccessRequestView {
    return this.accessRequests.get(requestRef)?.view ?? EmbeddedBrowserAccessRequestViewSchema.parse({
      requestRef,
      requesterSessionRef: "",
      revision: 0,
      createdAt: rfc3339(nowMs()),
      expiresAt: rfc3339(nowMs()),
    });
  }

  private notifyAccessWaiters() {
    for (const waiter of [...this.accessWaiters]) waiter();
    this.accessWaiters.clear();
  }

  private waitForAccessChange(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.accessWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.accessWaiters.add(done);
    });
  }

  private pushEvent(type: string, payload: Record<string, unknown>) {
    const event = { type, payload };
    this.eventQueue.push(event);
    while (this.eventQueue.length > EVENT_LIMIT) this.eventQueue.shift();
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* A subscriber must not break the state transition. */ }
    }
  }

  private removeAllSourcePages(sourceRef: string, reason: string) {
    const source = this.sources.get(sourceRef);
    if (!source) return;
    const removes = [...source.pages.keys()];
    source.pages.clear();
    if (!removes.length) return;
    this.removeLeasesForTabs(removes, nowMs());
    this.recordRegistryDelta(sourceRef, source.registration.pageHost, [], removes);
    this.recordSourceEvent(sourceRef, source.registration.pageHost, reason);
  }

  private markSourcePagesUnavailable(sourceRef: string) {
    const source = this.sources.get(sourceRef);
    if (!source) return;
    const upserts: EmbeddedBrowserPage[] = [];
    for (const [tabRef, page] of source.pages) {
      if (page.state === "unavailable") continue;
      const updated = EmbeddedBrowserPageSchema.parse({ ...page, state: "unavailable", revision: page.revision + 1 });
      source.pages.set(tabRef, updated);
      upserts.push(updated);
    }
    if (upserts.length) this.recordRegistryDelta(sourceRef, source.registration.pageHost, upserts, []);
  }

  private removeLeasesForSource(sourceRef: string, now: number) {
    const leaseRefs = [...this.leases.entries()].filter(([, record]) => record.lease.sourceRef === sourceRef).map(([leaseRef]) => leaseRef);
    for (const leaseRef of leaseRefs) this.removeLease(leaseRef);
    this.removeExpiredLeases(now);
  }

  private failActiveCreationsForSource(sourceRef: string) {
    for (const [creationRef, creation] of [...this.creations]) {
      if (creation.claimedSourceRef !== sourceRef || !["claimed", "creating"].includes(creation.view.state)) continue;
      creation.view = EmbeddedBrowserCreationViewSchema.parse({ ...creation.view, state: "failed", revision: creation.view.revision + 1 });
      this.recordCreationEvent(creation.view);
    }
  }

  private removeLeasesForTabs(tabRefs: string[], now: number) {
    for (const tabRef of tabRefs) {
      const leaseRef = this.tabLease.get(tabRef);
      if (leaseRef) this.removeLease(leaseRef);
    }
    this.removeExpiredLeases(now);
  }

  private removeLease(leaseRef: string) {
    const record = this.leases.get(leaseRef);
    if (!record) return false;
    this.leases.delete(leaseRef);
    if (this.tabLease.get(record.lease.tabRef) === leaseRef) this.tabLease.delete(record.lease.tabRef);
    this.recordLeaseEvent(record.lease, "detached");
    return true;
  }

  private removeExpiredLeases(now: number) {
    for (const [leaseRef, record] of [...this.leases]) {
      if (record.expiresAtMs <= now) this.removeLease(leaseRef);
    }
  }

  private expireCreationIfNeeded(creationRef: string, now: number) {
    const creation = this.creations.get(creationRef);
    if (!creation || !["pending", "claimed", "creating"].includes(creation.view.state) || creation.expiresAtMs > now) return false;
    creation.view = EmbeddedBrowserCreationViewSchema.parse({ ...creation.view, state: "expired", revision: creation.view.revision + 1 });
    this.recordCreationEvent(creation.view);
    return true;
  }
}

function sourcePublisherKey(registration: BrowserSourceRegistration) {
  return `${registration.panelId}\0${registration.ownerRef}\0${registration.publisherRef}`;
}
