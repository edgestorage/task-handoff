const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export type MobileMarkdownLinkTarget =
  | { kind: 'web'; url: string }
  | { kind: 'file'; path: string };

export function safeMarkdownLink(raw: string) {
  try {
    const url = new URL(raw);
    return EXTERNAL_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function markdownFileLinkPath(raw: string) {
  const value = raw.trim();
  if (!value) return undefined;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLocaleLowerCase();
  if (scheme === 'file') {
    try {
      const url = new URL(value);
      const path = url.hostname ? `//${url.hostname}${url.pathname}` : url.pathname;
      const decoded = decodeURIComponent(path).replace(/^\/([a-z]:[\\/])/i, '$1');
      return decoded || undefined;
    } catch {
      return undefined;
    }
  }
  if (scheme) return undefined;
  const path = value.split(/[?#]/, 1)[0]?.trim();
  return path || undefined;
}

export function mobileMarkdownLinkTarget(raw: string): MobileMarkdownLinkTarget | undefined {
  const url = safeMarkdownLink(raw);
  if (url) return { kind: 'web', url };
  const path = markdownFileLinkPath(raw);
  return path ? { kind: 'file', path } : undefined;
}
