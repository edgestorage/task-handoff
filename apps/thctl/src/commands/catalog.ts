import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import { readRequestBody, repeatableOption, requireArgument, requireOption } from "./support.ts";

const PROJECT_COLUMNS = [
  { key: "id", header: "project" },
  { key: "name", header: "name", width: 24 },
  { key: "defaultNodeId", header: "node" },
  { key: "updatedAt", header: "updated" },
];

const IMAGE_COLUMNS = [
  { key: "id", header: "image" },
  { key: "name", header: "name", width: 24 },
  { key: "reference", header: "reference", width: 40 },
  { key: "pullPolicy", header: "pull" },
];

const MODEL_COLUMNS = [
  { key: "id", header: "model" },
  { key: "name", header: "name", width: 24 },
  { key: "model", header: "model id", width: 30 },
  { key: "app", header: "app" },
  { key: "enabled", header: "enabled" },
];

const NODE_MODEL_COLUMNS = [
  { key: "id", header: "model" },
  { key: "name", header: "name", width: 24 },
  { key: "model", header: "model id", width: 30 },
  { key: "referenceCount", header: "refs" },
];

function rows(value: readonly unknown[]) {
  return value as readonly Record<string, unknown>[];
}

export async function projectList(context: CliContext) {
  const connection = await openConnection(context);
  const projects = await connection.client.catalog.listProjects(context.signal);
  if (context.output.json) return { data: projects };
  return { data: rows(projects), columns: PROJECT_COLUMNS, message: projects.length ? undefined : "No projects matched." };
}

export async function projectShow(context: CliContext, invocation: CliInvocation) {
  const projectId = requireArgument(invocation, "projectId");
  const connection = await openConnection(context);
  const project = await connection.client.catalog.getProject(projectId, context.signal);
  if (context.output.json) return { data: project };
  return { data: project, columns: PROJECT_COLUMNS };
}

export async function projectCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Project create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "project create",
    () => ({ method: "POST", path: "/api/projects", body }),
    () => connection.client.catalog.createProject(body),
  );
  if (!result) return;
  return { data: result, columns: PROJECT_COLUMNS, message: `Project \`${result.id}\` created.` };
}

export async function projectUpdate(context: CliContext, invocation: CliInvocation) {
  const projectId = requireArgument(invocation, "projectId");
  const body = readRequestBody(invocation, "Project update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "project update",
    () => ({ method: "PATCH", path: `/api/projects/${encodeURIComponent(projectId)}`, body }),
    () => connection.client.catalog.updateProject(projectId, body),
  );
  if (!result) return;
  return { data: result, columns: PROJECT_COLUMNS, message: `Project \`${projectId}\` updated.` };
}

export async function projectRemove(context: CliContext, invocation: CliInvocation) {
  const projectId = requireArgument(invocation, "projectId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "project remove",
    () => ({ method: "DELETE", path: `/api/projects/${encodeURIComponent(projectId)}` }),
    () => connection.client.catalog.removeProject(projectId),
  );
  if (!result) return;
  return { data: result, message: `Project \`${projectId}\` removed.` };
}

export async function imageList(context: CliContext) {
  const connection = await openConnection(context);
  const images = await connection.client.catalog.listImages(context.signal);
  if (context.output.json) return { data: images };
  return { data: rows(images), columns: IMAGE_COLUMNS, message: images.length ? undefined : "No images matched." };
}

export async function imageShow(context: CliContext, invocation: CliInvocation) {
  const imageId = requireArgument(invocation, "imageId");
  const connection = await openConnection(context);
  const image = await connection.client.catalog.getImage(imageId, context.signal);
  if (context.output.json) return { data: image };
  return { data: image, columns: IMAGE_COLUMNS };
}

export async function imageOptions(context: CliContext) {
  const connection = await openConnection(context);
  const options = await connection.client.catalog.imageOptions(context.signal);
  if (context.output.json) return { data: options };
  return { data: rows(options), columns: [{ key: "id", header: "image" }, { key: "name", header: "name", width: 24 }, { key: "reference", header: "reference", width: 40 }] };
}

export async function imageCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Image create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "image create",
    () => ({ method: "POST", path: "/api/images", body }),
    () => connection.client.catalog.createImage(body),
  );
  if (!result) return;
  return { data: result, columns: IMAGE_COLUMNS, message: `Image \`${result.id}\` created.` };
}

export async function imageUpdate(context: CliContext, invocation: CliInvocation) {
  const imageId = requireArgument(invocation, "imageId");
  const body = readRequestBody(invocation, "Image update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "image update",
    () => ({ method: "PATCH", path: `/api/images/${encodeURIComponent(imageId)}`, body }),
    () => connection.client.catalog.updateImage(imageId, body),
  );
  if (!result) return;
  return { data: result, columns: IMAGE_COLUMNS, message: `Image \`${imageId}\` updated.` };
}

export async function imageRemove(context: CliContext, invocation: CliInvocation) {
  const imageId = requireArgument(invocation, "imageId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "image remove",
    () => ({ method: "DELETE", path: `/api/images/${encodeURIComponent(imageId)}` }),
    () => connection.client.catalog.removeImage(imageId),
  );
  if (!result) return;
  return { data: result, message: `Image \`${imageId}\` removed.` };
}

export async function marketCatalog(context: CliContext) {
  const connection = await openConnection(context);
  const catalog = await connection.client.catalog.marketCatalog(context.signal);
  if (context.output.json) return { data: catalog };
  return { data: catalog, columns: [{ key: "image.id", header: "image" }, { key: "image.name", header: "name", width: 30 }, { key: "status", header: "status" }] };
}

export async function marketRefresh(context: CliContext) {
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "market refresh",
    () => ({ method: "POST", path: "/api/market/refresh" }),
    () => connection.client.catalog.refreshMarketCatalog(),
  );
  if (!result) return;
  return { data: result, message: `Market catalog refreshed (${result.catalog.items?.length ?? 0} images).` };
}

export async function modelCreate(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Model create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model create",
    () => ({ method: "POST", path: "/api/models", body }),
    () => connection.client.catalog.createModel(body),
  );
  if (!result) return;
  return { data: result, message: `Model \`${result.id}\` created.` };
}

export async function modelCopy(context: CliContext, invocation: CliInvocation) {
  const modelId = requireArgument(invocation, "modelId");
  const body = readRequestBody(invocation, "Model copy request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model copy",
    () => ({ method: "POST", path: `/api/models/${encodeURIComponent(modelId)}/copy`, body }),
    () => connection.client.catalog.copyModel(modelId, body),
  );
  if (!result) return;
  return { data: result, message: `Model \`${result.id}\` copied from \`${modelId}\`.` };
}

export async function modelDiscover(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Model discovery request");
  const connection = await openConnection(context);
  const result = await connection.client.catalog.discoverModels(body);
  if (context.output.json) return { data: result };
  return { data: rows(result.models), columns: [{ key: "id", header: "model" }, { key: "ownedBy", header: "owned by" }], message: result.models.length ? undefined : "No models discovered." };
}

export async function modelTest(context: CliContext, invocation: CliInvocation) {
  const body = readRequestBody(invocation, "Model test request");
  const connection = await openConnection(context);
  const result = await connection.client.catalog.testModel(body);
  if (context.output.json) return { data: result };
  return { data: result, message: `Model test succeeded in ${result.latencyMs}ms.` };
}

export async function modelReorder(context: CliContext, invocation: CliInvocation) {
  const ids = repeatableOption(invocation, "id");
  if (!ids.length) throw requireOption(invocation, "id");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model reorder",
    () => ({ method: "POST", path: "/api/models/reorder", body: { ids } }),
    () => connection.client.catalog.reorderModels(ids),
  );
  if (!result) return;
  return { data: rows(result), columns: MODEL_COLUMNS, message: `${result.length} models reordered.` };
}

export async function modelUpdate(context: CliContext, invocation: CliInvocation) {
  const modelId = requireArgument(invocation, "modelId");
  const body = readRequestBody(invocation, "Model update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model update",
    () => ({ method: "PATCH", path: `/api/models/${encodeURIComponent(modelId)}`, body }),
    () => connection.client.catalog.updateModel(modelId, body),
  );
  if (!result) return;
  return { data: result, message: `Model \`${modelId}\` updated.` };
}

export async function modelSync(context: CliContext, invocation: CliInvocation) {
  const modelId = requireArgument(invocation, "modelId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model sync",
    () => ({ method: "POST", path: `/api/models/${encodeURIComponent(modelId)}/sync` }),
    () => connection.client.catalog.syncModel(modelId),
  );
  if (!result) return;
  return { data: result, message: `Model \`${modelId}\` synced.` };
}

export async function modelMerge(context: CliContext, invocation: CliInvocation) {
  const modelId = requireArgument(invocation, "modelId");
  const body = readRequestBody(invocation, "Model merge request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model merge",
    () => ({ method: "POST", path: `/api/models/${encodeURIComponent(modelId)}/merge`, body }),
    () => connection.client.catalog.mergeModel(modelId, body),
  );
  if (!result) return;
  return { data: result, message: `Model \`${modelId}\` merged.` };
}

export async function modelRemove(context: CliContext, invocation: CliInvocation) {
  const modelId = requireArgument(invocation, "modelId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model remove",
    () => ({ method: "DELETE", path: `/api/models/${encodeURIComponent(modelId)}` }),
    () => connection.client.catalog.removeModel(modelId),
  );
  if (!result) return;
  return { data: result, message: `Model \`${modelId}\` removed.` };
}

/** 节点级模型清单从权威联邦注册表按 location 推导，避免为可推导信息新增路由。 */
export async function modelNodeList(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const connection = await openConnection(context);
  const registry = await connection.client.catalog.listModels({ signal: context.signal });
  const isNodeLocation = (location: { type: string; nodeId?: string }) => location.type === "node" && location.nodeId === nodeId;
  const entries = registry.models.filter((entry) => entry.locations.some(isNodeLocation));
  const rows = entries.map((entry) => ({
    id: entry.id,
    name: entry.model.name,
    model: entry.model.model,
    referenceCount: entry.locations.filter(isNodeLocation).length,
  }));
  if (context.output.json) return { data: entries };
  return { data: rows, columns: NODE_MODEL_COLUMNS, message: rows.length ? undefined : `No node-scoped models for \`${nodeId}\`.` };
}

export async function modelNodeCreate(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const body = readRequestBody(invocation, "Node model create request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model node create",
    () => ({ method: "POST", path: `/api/nodes/${encodeURIComponent(nodeId)}/models`, body }),
    () => connection.client.catalog.createModelOnNode(nodeId, body),
  );
  if (!result) return;
  return { data: result, message: `Model deployed to node \`${nodeId}\`.` };
}

export async function modelNodeDiscover(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const body = readRequestBody(invocation, "Node model discovery request");
  const connection = await openConnection(context);
  const result = await connection.client.catalog.discoverModelsOnNode(nodeId, body);
  if (context.output.json) return { data: result };
  return { data: rows(result.models), columns: [{ key: "id", header: "model" }, { key: "ownedBy", header: "owned by" }], message: result.models.length ? undefined : "No models discovered." };
}

export async function modelNodeTest(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const body = readRequestBody(invocation, "Node model test request");
  const connection = await openConnection(context);
  const result = await connection.client.catalog.testModelOnNode(nodeId, body);
  if (context.output.json) return { data: result };
  return { data: result, message: `Node \`${nodeId}\` model test succeeded in ${result.latencyMs}ms.` };
}

export async function modelNodeUpdate(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const modelId = requireArgument(invocation, "modelId");
  const body = readRequestBody(invocation, "Node model update request");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model node update",
    () => ({ method: "PATCH", path: `/api/nodes/${encodeURIComponent(nodeId)}/models/${encodeURIComponent(modelId)}`, body }),
    () => connection.client.catalog.updateModelOnNode(nodeId, modelId, body),
  );
  if (!result) return;
  return { data: result, message: `Node \`${nodeId}\` model \`${modelId}\` updated.` };
}

export async function modelNodeRemove(context: CliContext, invocation: CliInvocation) {
  const nodeId = requireArgument(invocation, "nodeId");
  const modelId = requireArgument(invocation, "modelId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "model node remove",
    () => ({ method: "DELETE", path: `/api/nodes/${encodeURIComponent(nodeId)}/models/${encodeURIComponent(modelId)}` }),
    () => connection.client.catalog.removeModelOnNode(nodeId, modelId),
  );
  if (!result) return;
  return { data: result, message: `Node \`${nodeId}\` model \`${modelId}\` removed.` };
}
