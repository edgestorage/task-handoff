function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Desktop instance directory is missing ${field}.`);
  return value.trim();
}

function responseDataArray(payload, resource) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error(`Desktop ${resource} directory returned an invalid response.`);
  }
  return payload.data;
}

async function requestDirectory(fetch, url, resource, fallbackUrl) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  // Compatibility for Control Plane versions that predate the directory
  // projection and reject the otherwise additive query with HTTP 400.
  if (response.status === 400 && fallbackUrl) {
    return requestDirectory(fetch, fallbackUrl, resource);
  }
  if (!response.ok) throw new Error(`Desktop ${resource} directory request failed with HTTP ${response.status}.`);
  return responseDataArray(await response.json(), resource);
}

async function loadDesktopInstanceDirectory({ endpoint, fetch }) {
  if (!endpoint) throw new Error("Desktop Control Plane endpoint is unavailable.");
  if (typeof fetch !== "function") throw new Error("Desktop instance directory requires a fetch implementation.");
  const baseUrl = endpoint.replace(/\/$/, "");
  const [nodeRecords, instanceRecords] = await Promise.all([
    requestDirectory(fetch, `${baseUrl}/api/nodes?projection=directory`, "node", `${baseUrl}/api/nodes`),
    requestDirectory(fetch, `${baseUrl}/api/instance-board?projection=directory`, "instance", `${baseUrl}/api/instance-board`),
  ]);
  const nodes = nodeRecords.map((record) => ({
    id: requiredString(record?.id, "node.id"),
    name: requiredString(record?.name, "node.name"),
  }));
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  const instances = instanceRecords.map((record) => ({
    id: requiredString(record?.id, "instance.id"),
    name: requiredString(record?.name, "instance.name"),
    nodeId: requiredString(record?.nodeId, "instance.nodeId"),
  }));
  const instancesByNode = new Map();
  for (const instance of instances) {
    const entries = instancesByNode.get(instance.nodeId) || [];
    entries.push({ id: instance.id, name: instance.name });
    instancesByNode.set(instance.nodeId, entries);
  }
  const orderedNodeIds = [
    ...nodes.map((node) => node.id).filter((nodeId) => instancesByNode.has(nodeId)),
    ...[...instancesByNode.keys()].filter((nodeId) => !nodeNames.has(nodeId)).sort(),
  ];
  return orderedNodeIds.map((nodeId) => ({
    nodeId,
    nodeName: nodeNames.get(nodeId) || nodeId,
    instances: instancesByNode.get(nodeId).sort((left, right) => left.name.localeCompare(right.name)),
  }));
}

module.exports = { loadDesktopInstanceDirectory };
