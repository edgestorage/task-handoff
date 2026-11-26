import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
  directInstancePrivateModelCatalog,
  instancePrivateModelCatalogBaseUrl,
  modelNameEntryIdentity,
  type InstancePrivateModelCatalog,
} from "@task-handoff/core/core/instance-private-model-catalog";
import type { AiSessionModelSelection } from "@task-handoff/protocol/ai-sessions";
import { acpAgentProtocols, acpManagedProviderKey, isAcpAgentId, type AcpModelProtocol } from "@task-handoff/ai-session-runtime/acp-model";

export type AcpLaunchConfig = {
  env: Record<string, string>;
  args: string[];
  cleanupDir?: string;
  persistSessionHome?: (providerSessionId: string) => void;
};

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const COMMAND_CODE_LOCAL_AUTH = "task-handoff-local-only";

function commandCodeApi(protocol: AcpModelProtocol) {
  return protocol === "openai-chat-completions" ? "openai-completions" : protocol;
}

function dshApi(protocol: AcpModelProtocol) {
  return protocol === "openai-chat-completions" ? "openai-completions"
    : protocol === "google-generative-ai" ? "google-generative-ai"
      : protocol;
}

function dshBaseUrl(protocol: AcpModelProtocol, baseUrl: string) {
  if (protocol !== "google-generative-ai" || /\/v1beta\/?$/.test(baseUrl)) return baseUrl;
  // pi-ai's Google client treats baseURL as already versioned and appends the
  // model operation directly. Relay routes end at /v1, so add the Google API
  // segment that the relay adapter expects after its route prefix.
  return `${baseUrl.replace(/\/+$/, "")}/v1beta`;
}

function credentialFor(catalog: InstancePrivateModelCatalog, entityId: string, instanceCredential: string) {
  if (catalog.protocolVersion === INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION) return instanceCredential;
  return directInstancePrivateModelCatalog(catalog)?.entities.find((entity) => entity.id === entityId)?.key || instanceCredential;
}

function credentialEnvName(index: number) {
  return `TASK_HANDOFF_ACP_MODEL_KEY_${index}`;
}

function compatibleEntities(catalog: InstancePrivateModelCatalog, agent: string) {
  return catalog.entities.flatMap((entity) => {
    for (const protocol of acpAgentProtocols(agent)) {
      if (!entity.protocols.includes(protocol)) continue;
      const baseUrl = instancePrivateModelCatalogBaseUrl(catalog, entity.id, protocol);
      if (baseUrl) return [{ entity, protocol, baseUrl }];
    }
    return [];
  });
}

function writePrivateFile(directory: string, relativePath: string, content: string) {
  const filePath = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function sessionHomeKey(providerSessionId: string) {
  return createHash("sha256").update(providerSessionId).digest("hex").slice(0, 32);
}

function commandCodeSessionHome(root: string, dataDir: string) {
  const source = path.join(root, ".commandcode");
  const retained = path.join(dataDir, "acp-session-homes", "commandcode");
  return {
    restore(providerSessionId: string | undefined) {
      if (!providerSessionId) return;
      const snapshot = path.join(retained, sessionHomeKey(providerSessionId));
      if (!fs.existsSync(snapshot)) return;
      fs.mkdirSync(source, { recursive: true, mode: 0o700 });
      fs.cpSync(snapshot, source, { recursive: true, force: true });
    },
    persist(providerSessionId: string) {
      if (!fs.existsSync(source)) return;
      fs.mkdirSync(retained, { recursive: true, mode: 0o700 });
      fs.chmodSync(retained, 0o700);
      const target = path.join(retained, sessionHomeKey(providerSessionId));
      const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.cpSync(source, staging, { recursive: true });
      fs.chmodSync(staging, 0o700);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
    },
  };
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function writeCommandCodeConfig(root: string, catalog: InstancePrivateModelCatalog, credential: string) {
  const providers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  let index = 0;
  for (const { entity, protocol, baseUrl } of compatibleEntities(catalog, "commandcode")) {
    const envName = credentialEnvName(index++);
    env[envName] = credentialFor(catalog, entity.id, credential);
    providers[acpManagedProviderKey(entity.id)] = {
      name: entity.id,
      api: commandCodeApi(protocol),
      baseURL: baseUrl,
      apiKey: `$${envName}`,
      models: Object.fromEntries(entity.modelNames.map((entry) => [modelNameEntryIdentity(entry), {
        name: entry.name,
        reasoningEfforts: REASONING_EFFORTS,
      }])),
    };
  }
  if (!Object.keys(providers).length) return { env: {} };
  writePrivateFile(root, path.join(".commandcode", "providers.json"), `${json({ provider: providers })}\n`);
  return { env };
}

function writeDshPatch(root: string, catalog: InstancePrivateModelCatalog, credential: string) {
  const lines = ["- id: llm-pi-ai", "  config:", "    providers:"];
  const env: Record<string, string> = {};
  let index = 0;
  for (const { entity, protocol, baseUrl } of compatibleEntities(catalog, "dsh")) {
    const providerKey = acpManagedProviderKey(entity.id);
    const envName = credentialEnvName(index++);
    env[envName] = credentialFor(catalog, entity.id, credential);
    lines.push(
      `      ${yamlString(providerKey)}:`,
      `        displayName: ${yamlString(entity.id)}`,
      `        apiKeyEnv: ${yamlString(envName)}`,
      `        api: ${yamlString(dshApi(protocol))}`,
      `        baseURL: ${yamlString(dshBaseUrl(protocol, baseUrl))}`,
      "        models:",
    );
    for (const entry of entity.modelNames) {
      lines.push(
        `          - id: ${yamlString(modelNameEntryIdentity(entry))}`,
        `            name: ${yamlString(entry.name)}`,
        "            reasoningEfforts:",
        '              "off":',
        '              minimal: "minimal"',
        '              low: "low"',
        '              medium: "medium"',
        '              high: "high"',
      );
      if (protocol !== "google-generative-ai") {
        lines.push('              xhigh: "xhigh"', '              max: "max"');
      }
    }
  }
  if (!Object.keys(env).length) return { env: {}, args: [], cleanupDir: undefined };
  const patch = writePrivateFile(root, "acp-model.patch.yml", `${lines.join("\n")}\n`);
  return { env, args: ["--patch", patch] };
}

function geminiBaseUrl(catalog: InstancePrivateModelCatalog, entityId: string, protocol: AcpModelProtocol) {
  const baseUrl = instancePrivateModelCatalogBaseUrl(catalog, entityId, protocol);
  if (!baseUrl) return undefined;
  // Gemini CLI appends /v1beta. Direct Google endpoints commonly include it,
  // while the node relay route must keep its /v1 route segment so the appended
  // /v1beta becomes the Google operation path behind that route.
  return baseUrl.replace(/\/v1beta\/?$/, "").replace(/\/+$/, "");
}

/**
 * Build the Agent-private launch surface for one ACP session. TaskHandoff model
 * entities are injected into each Agent's own configuration boundary; the
 * model selection itself is applied over ACP after session/new or session/load.
 */
export function prepareAcpLaunchConfig(input: {
  agent: string;
  catalog?: InstancePrivateModelCatalog;
  instanceCredential?: string;
  modelSelection?: AiSessionModelSelection;
  dataDir: string;
  providerSessionId?: string;
  cwd?: string;
}): AcpLaunchConfig {
  if (!isAcpAgentId(input.agent)) return { env: {}, args: [] };
  const entities = input.catalog ? compatibleEntities(input.catalog, input.agent) : [];
  // Gemini needs the workspace trust entry even when no TaskHandoff model is
  // configured, because its privileged approval modes reject untrusted cwd.
  if (!entities.length && input.agent !== "gemini") return { env: {}, args: [] };
  const root = fs.mkdtempSync(path.join(input.dataDir, "acp-session-"));
  fs.chmodSync(root, 0o700);
  const credential = input.instanceCredential || "";
  const commandCodeHome = input.agent === "commandcode" ? commandCodeSessionHome(root, input.dataDir) : undefined;
  try {
    if (input.agent === "gemini") {
      const env: Record<string, string> = {};
      if (input.cwd) {
        // Gemini 0.71.1 throws when autoEdit/yolo is selected in an untrusted
        // folder. Keep trust scoped to this session's workspace rather than a
        // process-global trust flag.
        env.GEMINI_CLI_TRUSTED_FOLDERS_PATH = writePrivateFile(
          root,
          "trustedFolders.json",
          json({ [path.resolve(input.cwd)]: "TRUST_FOLDER" }),
        );
      }
      if (!entities.length) return { env, args: [], cleanupDir: root };
      const selected = input.modelSelection
        ? entities.find(({ entity }) => entity.id === input.modelSelection?.modelEntityId)
        : undefined;
      const target = selected || entities[0];
      const baseUrl = geminiBaseUrl(input.catalog!, target.entity.id, target.protocol);
      if (!baseUrl) throw Object.assign(new Error("The selected Gemini model has no relay route."), { code: "AI_SESSION_MODEL_TARGET_UNAVAILABLE", statusCode: 409 });
      const model = (input.modelSelection?.modelUpstreamName || input.modelSelection?.modelName
        || modelNameEntryIdentity(target.entity.modelNames[0]));
      return {
        env: {
          ...env,
          GOOGLE_GEMINI_BASE_URL: baseUrl,
          GEMINI_API_KEY: credentialFor(input.catalog!, target.entity.id, credential),
          GOOGLE_API_KEY: credentialFor(input.catalog!, target.entity.id, credential),
          GOOGLE_GENAI_USE_VERTEXAI: "false",
          GEMINI_MODEL: model,
        },
        args: [],
        cleanupDir: root,
      };
    }
    if (input.agent === "commandcode") {
      commandCodeHome!.restore(input.providerSessionId);
      const config = writeCommandCodeConfig(root, input.catalog!, credential);
      return {
        env: {
          ...config.env,
          HOME: root,
          // Command Code requires an auth token before session/new even when
          // every model is a private BYOK provider. Local-only mode prevents
          // Command Code traffic, and the fixed value never leaves the process
          // as a usable cloud credential.
          COMMAND_CODE_API_KEY: COMMAND_CODE_LOCAL_AUTH,
          CMD_LOCAL_ONLY: "1",
        },
        args: [],
        cleanupDir: root,
        persistSessionHome: commandCodeHome!.persist,
      };
    }
    const config = writeDshPatch(root, input.catalog!, credential);
    return { env: { ...config.env, DSH_HOME: root }, args: config.args, cleanupDir: root };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
