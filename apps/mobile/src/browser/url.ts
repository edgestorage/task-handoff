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

function browserAddressError() {
  return Object.assign(new Error('Enter a valid HTTP or HTTPS address.'), { code: 'BROWSER_ADDRESS_INVALID' });
}
