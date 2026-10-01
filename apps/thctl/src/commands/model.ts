import { ThctlError } from "../errors.ts";
import { openConnection, type CliContext, type CliInvocation } from "../runtime.ts";
import { requireArgument } from "./support.ts";

const MODEL_COLUMNS = [
  { key: "id", header: "model" },
  { key: "model.name", header: "name", width: 24 },
  { key: "model.model", header: "model id", width: 30 },
  { key: "model.app", header: "app" },
  { key: "model.protocols", header: "protocols", width: 20 },
  { key: "model.enabled", header: "enabled" },
  { key: "locations", header: "locations", width: 30 },
];

export async function modelList(context: CliContext) {
  const connection = await openConnection(context);
  const registry = await connection.client.resources.models(context.signal);
  if (context.output.json) return { data: registry };
  const rows = registry.models.map((entry) => ({
    ...entry,
    model: { ...entry.model, protocols: entry.model.protocols.join(",") },
    locations: entry.locations.map((location) => `${location.type}${location.nodeId ? `:${location.nodeId}` : ""}${location.enabled ? "" : "(disabled)"}`).join(","),
  }));
  return { data: rows, columns: MODEL_COLUMNS, message: rows.length ? undefined : "No models matched." };
}

export async function modelShow(context: CliContext, invocation: CliInvocation) {
  const modelId = requireArgument(invocation, "modelId");
  const connection = await openConnection(context);
  const registry = await connection.client.resources.models(context.signal);
  const entry = registry.models.find((candidate) => candidate.id === modelId || candidate.model.id === modelId);
  if (!entry) {
    throw new ThctlError("CLI_MODEL_NOT_FOUND", `No model \`${modelId}\` is visible in the public registry.`, 7, { modelId });
  }
  if (context.output.json) return { data: entry };
  return { data: { ...entry, model: { ...entry.model, protocols: entry.model.protocols.join(",") } }, columns: MODEL_COLUMNS };
}
