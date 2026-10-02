import { z } from "zod";
import {
  CustomImageProfileSchema,
  FederatedModelRegistrySchema,
  MarketCatalogSnapshotSchema,
  MarketCatalogStatusSchema,
  ModelMergeResultSchema,
  ModelMutationResultSchema,
  ProjectSchema,
  PublicModelConfigSchema,
  SelectableImageSchema,
} from "@task-handoff/protocol/control-plane";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();
const DeletedSchema = z.object({ deleted: z.boolean() }).strict();
const ProjectListSchema = z.array(ProjectSchema);
const ImageListSchema = z.array(CustomImageProfileSchema);
const SelectableImageListSchema = z.array(SelectableImageSchema);
const DiscoveredModelSchema = z.object({ id: z.string().trim().min(1), ownedBy: z.string().optional() }).passthrough();
const ModelDiscoveryResultSchema = z.object({ models: z.array(DiscoveredModelSchema), latencyMs: z.number() }).passthrough();
const ModelTestResultSchema = z.object({ success: z.literal(true), latencyMs: z.number() }).passthrough();
// Both `GET /api/market/catalog` and `POST /api/market/refresh` return the
// catalog snapshot together with its refresh status; the status describes the
// catalog, it is not part of the catalog document itself.
const MarketCatalogResponseSchema = z.object({
  catalog: MarketCatalogSnapshotSchema,
  status: MarketCatalogStatusSchema,
}).strict();
// Node model writes return the public record; referenceCount is present on some
// node-agent versions only, so keep it optional for N-1 reads.
const NodeModelPublicRecordSchema = PublicModelConfigSchema.extend({ referenceCount: z.number().int().min(0).optional() }).passthrough();

export function createControlPlaneCatalogApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const modelPath = (id: string) => `/api/models/${encodeURIComponent(id)}`;
  const nodeModelPath = (nodeId: string, modelId?: string) => (
    `/api/nodes/${encodeURIComponent(nodeId)}/models${modelId === undefined ? "" : `/${encodeURIComponent(modelId)}`}`
  );
  return {
    listProjects(signal?: AbortSignal) {
      return requestData("/api/projects", ProjectListSchema, { signal });
    },
    getProject(projectId: string, signal?: AbortSignal) {
      return requestData(`/api/projects/${encodeURIComponent(projectId)}`, ProjectSchema, { signal });
    },
    createProject(input: unknown) {
      return requestData("/api/projects", ProjectSchema, jsonRequest("POST", input));
    },
    updateProject(projectId: string, input: unknown) {
      return requestData(`/api/projects/${encodeURIComponent(projectId)}`, ProjectSchema, jsonRequest("PATCH", input));
    },
    removeProject(projectId: string) {
      return requestData(`/api/projects/${encodeURIComponent(projectId)}`, DeletedSchema, jsonRequest("DELETE"));
    },
    listModels(options: { progressive?: boolean; signal?: AbortSignal } = {}) {
      const query = options.progressive ? "?progressive=true" : "";
      return requestData(`/api/models${query}`, FederatedModelRegistrySchema, { signal: options.signal });
    },
    getModel(modelId: string, signal?: AbortSignal) {
      return requestData(modelPath(modelId), PublicModelConfigSchema, { signal });
    },
    createModel(input: unknown) {
      return requestData("/api/models", PublicModelConfigSchema, jsonRequest("POST", input));
    },
    copyModel(modelId: string, input: unknown) {
      return requestData(`${modelPath(modelId)}/copy`, PublicModelConfigSchema, jsonRequest("POST", input));
    },
    discoverModels(input: unknown) {
      return requestData("/api/models/discover", ModelDiscoveryResultSchema, jsonRequest("POST", input));
    },
    testModel(input: unknown) {
      return requestData("/api/models/test", ModelTestResultSchema, jsonRequest("POST", input));
    },
    reorderModels(ids: readonly string[]) {
      return requestData("/api/models/reorder", z.array(PublicModelConfigSchema), jsonRequest("POST", { ids: [...ids] }));
    },
    updateModel(modelId: string, input: unknown) {
      return requestData(modelPath(modelId), ModelMutationResultSchema, jsonRequest("PATCH", input));
    },
    syncModel(modelId: string) {
      return requestData(`${modelPath(modelId)}/sync`, ModelMutationResultSchema, jsonRequest("POST", {}));
    },
    mergeModel(modelId: string, input: unknown) {
      return requestData(`${modelPath(modelId)}/merge`, ModelMergeResultSchema, jsonRequest("POST", input));
    },
    removeModel(modelId: string) {
      return requestData(modelPath(modelId), DeletedSchema, jsonRequest("DELETE"));
    },
    createModelOnNode(nodeId: string, input: unknown) {
      return requestData(nodeModelPath(nodeId), NodeModelPublicRecordSchema, jsonRequest("POST", input));
    },
    discoverModelsOnNode(nodeId: string, input: unknown) {
      return requestData(`${nodeModelPath(nodeId)}/discover`, ModelDiscoveryResultSchema, jsonRequest("POST", input));
    },
    testModelOnNode(nodeId: string, input: unknown) {
      return requestData(`${nodeModelPath(nodeId)}/test`, ModelTestResultSchema, jsonRequest("POST", input));
    },
    updateModelOnNode(nodeId: string, modelId: string, input: unknown) {
      return requestData(nodeModelPath(nodeId, modelId), NodeModelPublicRecordSchema, jsonRequest("PATCH", input));
    },
    removeModelOnNode(nodeId: string, modelId: string) {
      return requestData(nodeModelPath(nodeId, modelId), DeletedSchema, jsonRequest("DELETE"));
    },
    marketCatalog(signal?: AbortSignal) {
      return requestData("/api/market/catalog", MarketCatalogResponseSchema, { signal });
    },
    refreshMarketCatalog() {
      return requestData("/api/market/refresh", MarketCatalogResponseSchema, jsonRequest("POST", {}));
    },
    imageOptions(signal?: AbortSignal) {
      return requestData("/api/image-options", SelectableImageListSchema, { signal });
    },
    listImages(signal?: AbortSignal) {
      return requestData("/api/images", ImageListSchema, { signal });
    },
    getImage(imageId: string, signal?: AbortSignal) {
      return requestData(`/api/images/${encodeURIComponent(imageId)}`, CustomImageProfileSchema, { signal });
    },
    createImage(input: unknown) {
      return requestData("/api/images", CustomImageProfileSchema, jsonRequest("POST", input));
    },
    updateImage(imageId: string, input: unknown) {
      return requestData(`/api/images/${encodeURIComponent(imageId)}`, CustomImageProfileSchema, jsonRequest("PATCH", input));
    },
    removeImage(imageId: string) {
      return requestData(`/api/images/${encodeURIComponent(imageId)}`, DeletedSchema, jsonRequest("DELETE"));
    },
  };
}

export type ControlPlaneCatalogApi = ReturnType<typeof createControlPlaneCatalogApi>;
