/** Converts an allocated Relay websocket origin into its unauthenticated probe URL. */
export function relayEndpointProbeUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/probe";
  url.search = "";
  url.hash = "";
  return url;
}
