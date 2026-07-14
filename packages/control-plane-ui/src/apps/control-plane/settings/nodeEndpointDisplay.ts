const IPC_ENDPOINT_PREFIX = "ipc://";

export function nodeEndpointDisplay(endpoint?: string) {
  if (!endpoint?.startsWith(IPC_ENDPOINT_PREFIX)) {
    return endpoint || "";
  }

  try {
    return `${IPC_ENDPOINT_PREFIX}${decodeURIComponent(endpoint.slice(IPC_ENDPOINT_PREFIX.length))}`;
  } catch {
    return endpoint;
  }
}
