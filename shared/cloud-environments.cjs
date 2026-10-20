// Cloud domains have no built-in production values. Deployments and release builds
// provide the canonical origin, Coordinator suffixes and Relay suffixes explicitly.
// Mobile builds bake them into the Expo `extra` manifest, while Control Plane and
// Node Agent runtime bundles inline them. Packaged desktop builds materialize the
// same values for their child processes; unbundled development runs read the
// environment directly.
//
// Coordinator and Relay authorization both use main-domain suffixes. Discovery
// endpoints are Coordinator origins, so they reuse the Coordinator suffix list.

const BUILT_CLOUD_ENVIRONMENT = require("./cloud-environment-build.cjs");

const CLOUD_ENVIRONMENT_VARIABLES = Object.freeze({
  environment: "TASK_HANDOFF_CLOUD_ENV",
  serviceOrigin: "TASK_HANDOFF_CLOUD_SERVICE_ORIGIN",
  serviceOrigins: "TASK_HANDOFF_CLOUD_SERVICE_ORIGINS",
  coordinatorHostSuffixes: "TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES",
  relayHostSuffixes: "TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES",
  allowInsecureRelay: "TASK_HANDOFF_CLOUD_ALLOW_INSECURE_RELAY",
  discoveryRecord: "TASK_HANDOFF_CLOUD_DISCOVERY_RECORD",
  discoveryFallbackOrigin: "TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN",
});

const LOCAL_CLOUD_ENVIRONMENT = Object.freeze({
  id: "local",
  serviceOrigin: "http://127.0.0.1",
  coordinatorHostSuffixes: Object.freeze(["127.0.0.1"]),
  relayHostSuffixes: Object.freeze(["127.0.0.1"]),
  allowInsecureRelay: true,
});

function resolveCloudEnvironment(name, fallback, environment = process.env) {
  environment = builtCloudEnvironment() || environment;
  const requested = nonEmptyString(name)
    ?? configuredString(environment, CLOUD_ENVIRONMENT_VARIABLES.environment)
    ?? nonEmptyString(fallback);
  const serviceOrigin = configuredOrigin(environment, CLOUD_ENVIRONMENT_VARIABLES.serviceOrigin);
  const coordinatorHostSuffixes = configuredHostSuffixes(environment, CLOUD_ENVIRONMENT_VARIABLES.coordinatorHostSuffixes);
  const relayHostSuffixes = configuredHostSuffixes(environment, CLOUD_ENVIRONMENT_VARIABLES.relayHostSuffixes);
  if (!requested && !serviceOrigin && !coordinatorHostSuffixes && !relayHostSuffixes) return LOCAL_CLOUD_ENVIRONMENT;
  requireCloudSetting(serviceOrigin, CLOUD_ENVIRONMENT_VARIABLES.serviceOrigin);
  requireCloudSetting(coordinatorHostSuffixes, CLOUD_ENVIRONMENT_VARIABLES.coordinatorHostSuffixes);
  requireCloudSetting(relayHostSuffixes, CLOUD_ENVIRONMENT_VARIABLES.relayHostSuffixes);
  return Object.freeze({
    id: requested ?? "custom",
    serviceOrigin,
    coordinatorHostSuffixes,
    relayHostSuffixes,
    allowInsecureRelay: configuredBoolean(environment, CLOUD_ENVIRONMENT_VARIABLES.allowInsecureRelay) ?? false,
  });
}

function resolveCloudDiscovery(environmentOrName, environment = process.env) {
  environment = builtCloudEnvironment() || environment;
  const resolvedEnvironment = typeof environmentOrName === "string"
    ? resolveCloudEnvironment(environmentOrName, undefined, environment)
    : environmentOrName ?? resolveCloudEnvironment(undefined, undefined, environment);
  const record = configuredString(environment, CLOUD_ENVIRONMENT_VARIABLES.discoveryRecord);
  if (!record) return undefined;
  const fallbackOrigin = configuredOrigin(environment, CLOUD_ENVIRONMENT_VARIABLES.discoveryFallbackOrigin)
    ?? resolvedEnvironment.serviceOrigin;
  if (!isTrustedCloudServiceOrigin(resolvedEnvironment, fallbackOrigin)) {
    throw cloudEnvironmentError(`${CLOUD_ENVIRONMENT_VARIABLES.discoveryFallbackOrigin} is not trusted by the selected cloud environment.`, "INVALID_CLOUD_ENVIRONMENT");
  }
  return Object.freeze({
    record,
    fallbackOrigin,
    allowedHostSuffixes: resolvedEnvironment.coordinatorHostSuffixes,
  });
}

/**
 * Returns the cloud settings supplied by one environment mapping. An empty
 * mapping means the build selected no cloud; a partial or invalid mapping is a
 * build error rather than a silently local deployment.
 */
function configuredCloudEnvironmentVariables(environment = process.env) {
  const built = builtCloudEnvironment();
  if (built) return built;
  const configured = {};
  for (const name of Object.values(CLOUD_ENVIRONMENT_VARIABLES)) {
    const value = nonEmptyString(environment?.[name]);
    if (value) configured[name] = value;
  }
  if (!Object.keys(configured).length) return Object.freeze({});

  const hasCoreSettings = [
    CLOUD_ENVIRONMENT_VARIABLES.environment,
    CLOUD_ENVIRONMENT_VARIABLES.serviceOrigin,
    CLOUD_ENVIRONMENT_VARIABLES.coordinatorHostSuffixes,
    CLOUD_ENVIRONMENT_VARIABLES.relayHostSuffixes,
  ].some((name) => configured[name]);
  if (!hasCoreSettings) {
    throw cloudEnvironmentError(`${CLOUD_ENVIRONMENT_VARIABLES.serviceOrigin} is required when cloud settings are configured.`, "MISSING_CLOUD_ENVIRONMENT");
  }

  const resolved = resolveCloudEnvironment(undefined, undefined, configured);
  if (configured[CLOUD_ENVIRONMENT_VARIABLES.discoveryRecord]) {
    resolveCloudDiscovery(resolved, configured);
  } else if (configured[CLOUD_ENVIRONMENT_VARIABLES.discoveryFallbackOrigin]) {
    throw cloudEnvironmentError(`${CLOUD_ENVIRONMENT_VARIABLES.discoveryRecord} is required when ${CLOUD_ENVIRONMENT_VARIABLES.discoveryFallbackOrigin} is configured.`, "MISSING_CLOUD_ENVIRONMENT");
  }
  return Object.freeze(configured);
}

/**
 * Configured environments use their explicit suffixes. Any other origin is an
 * ad-hoc test cloud: it may only reach a Relay served from its own host, and plain
 * `ws://` stays available there so local HTTP stacks keep working.
 */
function cloudEnvironmentForServiceOrigin(serviceOrigin, environment = process.env) {
  environment = builtCloudEnvironment() || environment;
  const parsed = new URL(String(serviceOrigin));
  const origin = parsed.origin;
  const configuredServiceOrigin = configuredOrigin(environment, CLOUD_ENVIRONMENT_VARIABLES.serviceOrigin);
  const configuredCoordinatorSuffixes = configuredHostSuffixes(environment, CLOUD_ENVIRONMENT_VARIABLES.coordinatorHostSuffixes);
  const configuredRelaySuffixes = configuredHostSuffixes(environment, CLOUD_ENVIRONMENT_VARIABLES.relayHostSuffixes);
  if (configuredServiceOrigin && configuredCoordinatorSuffixes && configuredRelaySuffixes) {
    const selected = resolveCloudEnvironment(undefined, undefined, environment);
    if (isTrustedCloudServiceOrigin(selected, origin)) return selected;
  }

  return Object.freeze({
    id: configuredString(environment, CLOUD_ENVIRONMENT_VARIABLES.environment) ?? "custom",
    serviceOrigin: origin,
    coordinatorHostSuffixes: configuredCoordinatorSuffixes ?? Object.freeze([parsed.hostname]),
    relayHostSuffixes: configuredRelaySuffixes ?? Object.freeze([parsed.hostname]),
    allowInsecureRelay: configuredBoolean(environment, CLOUD_ENVIRONMENT_VARIABLES.allowInsecureRelay) ?? parsed.protocol === "http:",
  });
}

function isTrustedCloudServiceOrigin(environment, value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.origin === environment.serviceOrigin) return true;
  return url.protocol === "https:" && hostMatchesAnySuffix(url.hostname, environment.coordinatorHostSuffixes);
}

function isTrustedCloudRelayUrl(environment, value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== "wss:" && !(environment.allowInsecureRelay === true && url.protocol === "ws:")) return false;
  return hostMatchesAnySuffix(url.hostname, environment.relayHostSuffixes);
}

function configuredString(environment, name) {
  return nonEmptyString(environment?.[name]);
}

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function configuredOrigin(environment, name) {
  const value = configuredString(environment, name);
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw cloudEnvironmentError(`${name} must be a valid URL.`, "INVALID_CLOUD_ENVIRONMENT");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw cloudEnvironmentError(`${name} must use HTTP or HTTPS.`, "INVALID_CLOUD_ENVIRONMENT");
  }
  return url.origin;
}

function requireCloudSetting(value, name) {
  if (!value) throw cloudEnvironmentError(`${name} is required.`, "MISSING_CLOUD_ENVIRONMENT");
}

function configuredHostSuffixes(environment, name) {
  const value = configuredString(environment, name);
  if (!value) return undefined;
  let values;
  if (value.startsWith("[")) {
    try {
      values = JSON.parse(value);
    } catch {
      throw cloudEnvironmentError(`${name} must be a JSON array or a comma-separated host list.`, "INVALID_CLOUD_ENVIRONMENT");
    }
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string")) {
      throw cloudEnvironmentError(`${name} must contain only host strings.`, "INVALID_CLOUD_ENVIRONMENT");
    }
  } else {
    values = value.split(/[,\s]+/);
  }
  const suffixes = [...new Set(values.map(normalizeHostSuffix).filter(Boolean))];
  if (!suffixes.length) throw cloudEnvironmentError(`${name} must contain at least one host.`, "INVALID_CLOUD_ENVIRONMENT");
  return Object.freeze(suffixes);
}

function configuredBoolean(environment, name) {
  const value = configuredString(environment, name)?.toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw cloudEnvironmentError(`${name} must be a boolean value.`, "INVALID_CLOUD_ENVIRONMENT");
}

function normalizeHostSuffix(value) {
  const host = String(value).trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host.includes("..") || host.startsWith("-") || host.endsWith("-")) {
    throw cloudEnvironmentError(`Invalid cloud host suffix: ${value}`, "INVALID_CLOUD_ENVIRONMENT");
  }
  return host;
}

function hostMatchesAnySuffix(hostname, suffixes) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  return Array.isArray(suffixes) && suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function cloudEnvironmentError(message, code) {
  return Object.assign(new Error(message), { code });
}

function builtCloudEnvironment() {
  return BUILT_CLOUD_ENVIRONMENT && Object.keys(BUILT_CLOUD_ENVIRONMENT).length
    ? BUILT_CLOUD_ENVIRONMENT
    : undefined;
}

module.exports = {
  CLOUD_ENVIRONMENT_VARIABLES,
  configuredCloudEnvironmentVariables,
  resolveCloudEnvironment,
  resolveCloudDiscovery,
  cloudEnvironmentForServiceOrigin,
  isTrustedCloudServiceOrigin,
  isTrustedCloudRelayUrl,
};
