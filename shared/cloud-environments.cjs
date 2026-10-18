// Single source of truth for the cloud service domains that this build trusts.
//
// The Control Plane imports this module directly, the mobile build configuration
// bakes the selected environment into the Expo `extra` manifest, and the mobile
// runtime only reads the baked values. Registered environments declare their Relay
// hosts explicitly so a test environment may serve the service and the Relay from
// different domains.
const CLOUD_ENVIRONMENTS = Object.freeze({
  production: Object.freeze({
    id: "production",
    serviceOrigin: "https://cloud.thandoff.com",
    relayHosts: Object.freeze([
      "relay.thandoff.com",
      "relay.th.xpbox.cn",
      "relay.aaasu.com",
    ]),
    allowInsecureRelay: false,
  }),
  staging: Object.freeze({
    id: "staging",
    serviceOrigin: "https://th.aaasu.com",
    relayHosts: Object.freeze(["relay.aaasu.com"]),
    allowInsecureRelay: false,
  }),
});

const CLOUD_DISCOVERY = Object.freeze({
  production: Object.freeze({
    record: "_cloud.thandoff.com",
    fallbackOrigin: "https://cloud.thandoff.com",
    allowedHostSuffixes: Object.freeze(["thandoff.com"]),
  }),
  staging: Object.freeze({
    record: "_cloud.aaasu.com",
    fallbackOrigin: "https://th.aaasu.com",
    allowedHostSuffixes: Object.freeze(["aaasu.com"]),
  }),
});

const DEFAULT_CLOUD_ENVIRONMENT = "production";

function resolveCloudEnvironment(name, fallback = DEFAULT_CLOUD_ENVIRONMENT) {
  const requested = typeof name === "string" && name.trim() ? name.trim() : fallback;
  const environment = Object.prototype.hasOwnProperty.call(CLOUD_ENVIRONMENTS, requested)
    ? CLOUD_ENVIRONMENTS[requested]
    : undefined;
  if (!environment) throw Object.assign(new Error(`Unknown cloud environment: ${requested}`), { code: "UNKNOWN_CLOUD_ENVIRONMENT" });
  return environment;
}

/**
 * Registered environments keep their declared Relay hosts. Any other origin is an
 * ad-hoc test cloud: it may only reach a Relay served from its own host, and plain
 * `ws://` stays available there so local HTTP stacks keep working.
 */
function cloudEnvironmentForServiceOrigin(serviceOrigin) {
  const parsed = new URL(String(serviceOrigin));
  const origin = parsed.origin;
  for (const environment of Object.values(CLOUD_ENVIRONMENTS)) {
    if (environment.serviceOrigin === origin) return environment;
  }
  return Object.freeze({
    id: "custom",
    serviceOrigin: origin,
    relayHosts: Object.freeze([parsed.hostname]),
    allowInsecureRelay: parsed.protocol === "http:",
  });
}

function isTrustedCloudServiceOrigin(environment, value) {
  try {
    return new URL(String(value)).origin === environment.serviceOrigin;
  } catch {
    return false;
  }
}

function isTrustedCloudRelayUrl(environment, value) {
  let url;
  try {
    url = value instanceof URL ? value : new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== "wss:" && !(environment.allowInsecureRelay === true && url.protocol === "ws:")) return false;
  return environment.relayHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

module.exports = {
  CLOUD_ENVIRONMENTS,
  CLOUD_DISCOVERY,
  DEFAULT_CLOUD_ENVIRONMENT,
  resolveCloudEnvironment,
  cloudEnvironmentForServiceOrigin,
  isTrustedCloudServiceOrigin,
  isTrustedCloudRelayUrl,
};
