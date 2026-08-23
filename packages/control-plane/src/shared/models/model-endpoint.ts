export type ModelEndpointApp = "codex" | "claude" | "opencode";

export type DiscoveredModel = {
  id: string;
  ownedBy?: string;
};

export type ModelDiscoveryResult = {
  models: DiscoveredModel[];
  latencyMs: number;
};

export type ModelTestResult = {
  success: true;
  latencyMs: number;
};

type FetchImpl = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 1_000_000;

export async function discoverModels(fetchImpl: FetchImpl, input: { endpoint: string; key: string }): Promise<ModelDiscoveryResult> {
  const candidates = modelListCandidates(input.endpoint);
  const startedAt = Date.now();
  let lastStatus: number | undefined;
  for (const url of candidates) {
    const response = await endpointFetch(fetchImpl, url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.key}`,
      },
    });
    if (response.status === 404 || response.status === 405) {
      lastStatus = response.status;
      continue;
    }
    if (!response.ok) throw upstreamError("MODEL_DISCOVERY_FAILED", response.status);
    const payload = await readJsonObject(response, "MODEL_DISCOVERY_RESPONSE_INVALID");
    const rawModels = Array.isArray(payload.data) ? payload.data : undefined;
    if (!rawModels) throw endpointError("MODEL_DISCOVERY_RESPONSE_INVALID", "The model endpoint returned an invalid model list.", 502);
    const models = rawModels
      .flatMap((entry): DiscoveredModel[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        if (!id) return [];
        const ownedBy = typeof record.owned_by === "string" ? record.owned_by.trim() : "";
        return [{ id, ...(ownedBy ? { ownedBy } : {}) }];
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    return { models: uniqueModels(models), latencyMs: Date.now() - startedAt };
  }
  throw endpointError(
    "MODEL_DISCOVERY_UNSUPPORTED",
    "No compatible model-list endpoint was found for this endpoint.",
    502,
    lastStatus,
  );
}

export async function testModelEndpoint(fetchImpl: FetchImpl, input: {
  endpoint: string;
  key: string;
  model: string;
  app: ModelEndpointApp;
}): Promise<ModelTestResult> {
  const startedAt = Date.now();
  const response = input.app === "codex" || input.app === "opencode"
    ? await endpointFetch(fetchImpl, appendEndpointPath(input.endpoint, "responses"), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: input.model, input: "Reply with OK.", max_output_tokens: 32, stream: false }),
    })
    : await endpointFetch(fetchImpl, appendAnthropicMessagesPath(input.endpoint), {
      method: "POST",
      headers: {
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": input.key,
      },
      body: JSON.stringify({ model: input.model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] }),
    });
  if (!response.ok) throw upstreamError("MODEL_TEST_FAILED", response.status);
  const payload = await readJsonObject(response, "MODEL_TEST_RESPONSE_INVALID");
  if (payload.error) {
    throw endpointError("MODEL_TEST_RESPONSE_INVALID", "The model endpoint returned an error payload.", 502);
  }
  return { success: true, latencyMs: Date.now() - startedAt };
}

export function modelListCandidates(endpoint: string) {
  const base = parseEndpoint(endpoint);
  const result: string[] = [];
  const lastSegment = base.pathname.split("/").filter(Boolean).at(-1) || "";
  pushUnique(result, appendEndpointPath(base.toString(), /^v\d+$/.test(lastSegment) ? "models" : "v1/models"));
  pushUnique(result, new URL("/v1/models", base.origin).toString());
  pushUnique(result, new URL("/models", base.origin).toString());
  return result;
}

export function appendEndpointPath(endpoint: string, suffix: string) {
  const url = parseEndpoint(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function appendAnthropicMessagesPath(endpoint: string) {
  const url = parseEndpoint(endpoint);
  const lastSegment = url.pathname.split("/").filter(Boolean).at(-1) || "";
  return appendEndpointPath(url.toString(), /^v\d+$/.test(lastSegment) ? "messages" : "v1/messages");
}

function parseEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw endpointError("MODEL_ENDPOINT_INVALID", "The model endpoint must be a valid HTTP or HTTPS URL.", 400);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw endpointError("MODEL_ENDPOINT_INVALID", "The model endpoint must be an HTTP or HTTPS URL without embedded credentials.", 400);
  }
  return url;
}

async function endpointFetch(fetchImpl: FetchImpl, url: string, init: RequestInit) {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timeout = error && typeof error === "object" && "name" in error && error.name === "TimeoutError";
    throw endpointError(
      timeout ? "MODEL_ENDPOINT_TIMEOUT" : "MODEL_ENDPOINT_UNREACHABLE",
      timeout ? "The model endpoint timed out." : "The model endpoint could not be reached.",
      timeout ? 504 : 502,
    );
  }
}

async function readJsonObject(response: Response, code: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw endpointError(code, "The model endpoint response was too large.", 502);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw endpointError(code, "The model endpoint returned invalid JSON.", 502);
  }
}

function upstreamError(code: string, upstreamStatus: number) {
  const message = upstreamStatus === 401 || upstreamStatus === 403
    ? "The model endpoint rejected the API key."
    : "The model endpoint rejected the request.";
  return endpointError(code, message, 502, upstreamStatus);
}

function endpointError(code: string, message: string, statusCode: number, upstreamStatus?: number) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    ...(upstreamStatus ? { details: { upstreamStatus } } : {}),
  });
}

function pushUnique(items: string[], value: string) {
  if (!items.includes(value)) items.push(value);
}

function uniqueModels(models: DiscoveredModel[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}
