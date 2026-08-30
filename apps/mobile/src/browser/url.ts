export function normalizeBrowserAddress(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw browserAddressError();
  if (trimmed === 'about:blank') return trimmed;
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:(?!\d)/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw browserAddressError(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw browserAddressError();
  return url.toString();
}

export const browserLoopbackAlias = '127-0-0-1.internal';

function loopbackAlias(hostname: string) {
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match || match.slice(1).some((part) => Number(part) > 255)) return undefined;
  return `127-${match[1]}-${match[2]}-${match[3]}.internal`;
}

/** URL used inside WKWebView so iOS does not classify the destination as loopback. */
export function toBrowserTransportAddress(input: string) {
  const url = new URL(input);
  url.hostname = loopbackAlias(url.hostname) || (url.hostname === 'localhost' || url.hostname === '::1' ? browserLoopbackAlias : url.hostname);
  return url.toString();
}

export function fromBrowserTransportAddress(input: string) {
  const url = new URL(input);
  const match = /^127-(\d{1,3})-(\d{1,3})-(\d{1,3})\.internal$/.exec(url.hostname);
  if (match && match.slice(1).every((part) => Number(part) <= 255)) url.hostname = `127.${match[1]}.${match[2]}.${match[3]}`;
  return url.toString();
}

function browserAddressError() {
  return Object.assign(new Error('Enter a valid HTTP or HTTPS address.'), { code: 'BROWSER_ADDRESS_INVALID' });
}
