/**
 * Binary download is optional on the transport contract. Transports that cannot
 * stream a non-JSON response raise this stable error so consumers can normalize
 * it to their own capability error instead of falling back to a direct fetch.
 */
export function binaryUnsupported(): Error {
  const error = new Error("This client transport cannot download binary responses.");
  Object.assign(error, { code: "CLIENT_BINARY_UNSUPPORTED" });
  return error;
}
