import {
  EmbeddedBrowserAccessRequestViewSchema,
  EmbeddedBrowserAccessViewSchema,
  EmbeddedBrowserCreationContextSnapshotSchema,
  EmbeddedBrowserDefaultContextClaimResultSchema,
  type EmbeddedBrowserAccessView,
  type EmbeddedBrowserAccessRequestView,
  type EmbeddedBrowserCreationContextSnapshot,
  type EmbeddedBrowserDefaultContextClaimResult,
} from "@task-handoff/protocol/embedded-browser-control";
import { deleteApiData, getApiData, postApiData, putApiData } from "./client";

const instanceRoute = (instanceId: string, suffix: string) =>
  `controlled-instances/${encodeURIComponent(instanceId)}/browser-control${suffix}`;

export async function getBrowserCreationContext(
  instanceId: string,
  sourceRef?: string,
  options: { signal?: AbortSignal } = {},
): Promise<EmbeddedBrowserCreationContextSnapshot> {
  const query = new URLSearchParams();
  if (sourceRef?.trim()) query.set("sourceRef", sourceRef.trim());
  const suffix = `/creation-context${query.size ? `?${query.toString()}` : ""}`;
  const data = await getApiData<unknown>(instanceRoute(instanceId, suffix), options);
  return EmbeddedBrowserCreationContextSnapshotSchema.parse(data);
}

export async function claimBrowserCreationContext(
  instanceId: string,
  sourceRef: string,
  expectedRevision: number,
): Promise<EmbeddedBrowserDefaultContextClaimResult> {
  const data = await putApiData<unknown>(instanceRoute(instanceId, "/creation-context"), { sourceRef, expectedRevision });
  return EmbeddedBrowserDefaultContextClaimResultSchema.parse(data);
}

export async function revokeBrowserCreationContext(
  instanceId: string,
  sourceRef: string,
  expectedRevision: number,
): Promise<unknown> {
  return deleteApiData<unknown>(instanceRoute(instanceId, "/creation-context"), { sourceRef, expectedRevision });
}

export async function grantBrowserControlAccess(
  instanceId: string,
  request?: { requestRef?: string; expectedRevision?: number },
): Promise<EmbeddedBrowserAccessView> {
  const data = await postApiData<unknown>(instanceRoute(instanceId, "/access"), request ?? {});
  return EmbeddedBrowserAccessViewSchema.parse(data);
}

export async function getBrowserControlAccess(instanceId: string): Promise<EmbeddedBrowserAccessView> {
  const data = await getApiData<unknown>(instanceRoute(instanceId, "/access"));
  return EmbeddedBrowserAccessViewSchema.parse(data);
}

export async function revokeBrowserControlAccess(instanceId: string): Promise<{ revokedLeases: number }> {
  return deleteApiData<{ revokedLeases: number }>(instanceRoute(instanceId, "/access"));
}

export async function denyBrowserControlAccessRequest(
  instanceId: string,
  requestRef: string,
  expectedRevision?: number,
): Promise<EmbeddedBrowserAccessRequestView> {
  const data = await postApiData<unknown>(
    instanceRoute(instanceId, `/access-requests/${encodeURIComponent(requestRef)}/deny`),
    expectedRevision === undefined ? {} : { expectedRevision },
  );
  return EmbeddedBrowserAccessRequestViewSchema.parse(data);
}
