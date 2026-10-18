export const CLOUD_DISCOVERY_VERSION = 'v1' as const;
export const MAX_CLOUD_DISCOVERY_ENDPOINTS = 5;

export type CloudDiscoveryConfig = {
  record: string;
  fallbackOrigin: string;
  allowedHostSuffixes: readonly string[];
};

export type ParsedCloudDiscoveryRecord = {
  version: typeof CLOUD_DISCOVERY_VERSION;
  origins: readonly string[];
};

export class CloudDiscoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CloudDiscoveryError';
  }
}

export function decodeDnsTxtValue(value: string) {
  const input = value.trim();
  if (!input.includes('"')) return input;
  const chunks: string[] = [];
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(input))) chunks.push(unescapeDnsTxt(match[1]));
  return chunks.length ? chunks.join('') : input.replace(/^"|"$/g, '');
}

export function hostMatchesSuffix(hostname: string, suffix: string) {
  const normalized = suffix.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function parseCloudDiscoveryRecord(raw: string, config: Pick<CloudDiscoveryConfig, 'allowedHostSuffixes'>): ParsedCloudDiscoveryRecord {
  const text = decodeDnsTxtValue(raw).trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new CloudDiscoveryError('CLOUD_DISCOVERY_RECORD_EMPTY', 'The cloud discovery record is empty.');

  const [version, ...hosts] = tokens;
  if (version !== CLOUD_DISCOVERY_VERSION) {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_VERSION_UNSUPPORTED', `Unsupported cloud discovery version: ${version}`);
  }
  if (hosts.length > MAX_CLOUD_DISCOVERY_ENDPOINTS) {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_TOO_MANY_ENDPOINTS', 'The cloud discovery record contains too many endpoints.');
  }

  const origins = [...new Set(hosts.map((host) => originForHost(host, config)))];
  if (!origins.length) throw new CloudDiscoveryError('CLOUD_DISCOVERY_RECORD_EMPTY', 'The cloud discovery record contains no endpoints.');
  return Object.freeze({ version: CLOUD_DISCOVERY_VERSION, origins: Object.freeze(origins) });
}

function originForHost(host: string, config: Pick<CloudDiscoveryConfig, 'allowedHostSuffixes'>) {
  if (!/^[a-z0-9.-]+$/i.test(host) || !host.includes('.')) {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_HOST_INVALID', `Invalid cloud discovery host: ${host}`);
  }
  let url: URL;
  try {
    url = new URL(`https://${host}`);
  } catch {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_HOST_INVALID', `Invalid cloud discovery host: ${host}`);
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_HOST_INVALID', `Invalid cloud discovery host: ${host}`);
  }
  const hostname = url.hostname.replace(/\.$/, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_HOST_INVALID', `IP addresses are not allowed in cloud discovery: ${host}`);
  }
  if (!config.allowedHostSuffixes.some((suffix) => hostMatchesSuffix(hostname, suffix))) {
    throw new CloudDiscoveryError('CLOUD_DISCOVERY_HOST_UNTRUSTED', `Untrusted cloud discovery host: ${host}`);
  }
  return `https://${hostname}`;
}

function unescapeDnsTxt(value: string) {
  return value
    .replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\\(.)/g, '$1');
}
