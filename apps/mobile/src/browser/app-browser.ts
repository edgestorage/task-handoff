import * as WebBrowser from 'expo-web-browser';

export function openAppBrowser(url: string) {
  return WebBrowser.openBrowserAsync(url, {
    enableBarCollapsing: true,
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    showTitle: true,
  });
}
