import * as Linking from 'expo-linking';

const ALLOWED_SYSTEM_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

export async function openSystemLink(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!ALLOWED_SYSTEM_SCHEMES.has(url.protocol)) {
    const error = new Error(`Unsupported external link scheme: ${url.protocol}`);
    Object.assign(error, { code: 'MOBILE_LINK_SCHEME_UNSUPPORTED' });
    throw error;
  }
  if (!(await Linking.canOpenURL(url.toString()))) {
    const error = new Error('No system handler is available for this link.');
    Object.assign(error, { code: 'MOBILE_LINK_UNAVAILABLE' });
    throw error;
  }
  await Linking.openURL(url.toString());
}
