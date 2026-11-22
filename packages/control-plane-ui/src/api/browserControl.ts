import {
  EmbeddedBrowserCreationApprovalListResponseSchema,
  EmbeddedBrowserCreationViewSchema,
  EmbeddedBrowserAccessViewSchema,
  type EmbeddedBrowserCreationApprovalListResponse,
  type EmbeddedBrowserCreationView,
  type EmbeddedBrowserAccessView,
} from "@task-handoff/protocol/embedded-browser-control";
import { deleteApiData, getApiData, postApiData } from "./client";

const instanceRoute = (instanceId: string, suffix: string) =>
  `controlled-instances/${encodeURIComponent(instanceId)}/browser-control${suffix}`;

export async function listBrowserCreationApprovals(
  instanceId: string,
  options: { signal?: AbortSignal } = {},
): Promise<EmbeddedBrowserCreationApprovalListResponse> {
  const data = await getApiData<unknown>(instanceRoute(instanceId, "/creation-requests"), options);
  return EmbeddedBrowserCreationApprovalListResponseSchema.parse(data);
}

export async function claimBrowserCreation(
  instanceId: string,
  sourceRef: string,
  creationRef: string,
  expectedRevision: number,
): Promise<EmbeddedBrowserCreationView> {
  const data = await postApiData<unknown>(
    instanceRoute(instanceId, `/sources/${encodeURIComponent(sourceRef)}/creation-requests/${encodeURIComponent(creationRef)}/claim`),
    { sourceRef, expectedRevision },
  );
  return EmbeddedBrowserCreationViewSchema.parse(data);
}

export async function declineBrowserCreation(
  instanceId: string,
  sourceRef: string,
  creationRef: string,
  expectedRevision: number,
): Promise<EmbeddedBrowserCreationView> {
  const data = await postApiData<unknown>(
    instanceRoute(instanceId, `/sources/${encodeURIComponent(sourceRef)}/creation-requests/${encodeURIComponent(creationRef)}/decline`),
    { sourceRef, expectedRevision },
  );
  return EmbeddedBrowserCreationViewSchema.parse(data);
}

export async function grantBrowserControlAccess(instanceId: string): Promise<EmbeddedBrowserAccessView> {
  const data = await postApiData<unknown>(instanceRoute(instanceId, "/access"), {});
  return EmbeddedBrowserAccessViewSchema.parse(data);
}

export async function getBrowserControlAccess(instanceId: string): Promise<EmbeddedBrowserAccessView> {
  const data = await getApiData<unknown>(instanceRoute(instanceId, "/access"));
  return EmbeddedBrowserAccessViewSchema.parse(data);
}

export async function revokeBrowserControlAccess(instanceId: string): Promise<{ revokedLeases: number }> {
  return deleteApiData<{ revokedLeases: number }>(instanceRoute(instanceId, "/access"));
}
