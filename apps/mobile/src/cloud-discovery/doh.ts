import { decodeDnsTxtValue } from './format';

export type CloudFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type CloudFetch = (input: string, init?: RequestInit) => Promise<CloudFetchResponse>;

type TxtProvider = {
  name: string;
  url(record: string): string;
};

const TXT_PROVIDERS: readonly TxtProvider[] = Object.freeze([
  {
    name: 'alidns',
    url: (record) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(record)}&type=TXT`,
  },
  {
    name: 'cloudflare',
    url: (record) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(record)}&type=TXT`,
  },
]);

export async function queryCloudDiscoveryTxt(
  record: string,
  options: { fetchImpl: CloudFetch; timeoutMs?: number },
) {
  const failures: string[] = [];
  for (const provider of TXT_PROVIDERS) {
    try {
      const response = await fetchWithTimeout(provider.url(record), {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs ?? 1_200,
        init: {
          headers: { accept: 'application/dns-json' },
          credentials: 'omit',
          redirect: 'error',
        },
      });
      if (!response.ok) {
        failures.push(`${provider.name}:http-${response.status}`);
        continue;
      }
      const value = extractTxtAnswer(await response.json());
      if (value) return value;
      failures.push(`${provider.name}:no-txt`);
    } catch (error) {
      failures.push(`${provider.name}:${(error as { name?: string })?.name ?? 'error'}`);
    }
  }
  throw Object.assign(new Error('Cloud discovery TXT lookup failed.'), {
    code: 'CLOUD_DISCOVERY_LOOKUP_FAILED',
    failures,
  });
}

function extractTxtAnswer(body: unknown) {
  if (!body || typeof body !== 'object') return undefined;
  const answer = (body as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer)) return undefined;
  for (const entry of answer) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { type?: unknown; data?: unknown };
    if (Number(record.type) !== 16 || typeof record.data !== 'string') continue;
    const value = decodeDnsTxtValue(record.data).trim();
    if (value.startsWith('v1 ')) return value;
  }
  return undefined;
}

async function fetchWithTimeout(input: string, options: {
  fetchImpl: CloudFetch;
  timeoutMs: number;
  init: RequestInit;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await options.fetchImpl(input, { ...options.init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
