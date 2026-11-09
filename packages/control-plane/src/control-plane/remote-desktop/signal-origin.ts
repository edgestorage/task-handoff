import { isRemoteDesktopLocalNetworkAddress } from "@task-handoff/protocol/remote-desktop";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Non-local signaling must be WSS unless the deployment explicitly opts into
 * private-LAN HTTP. Origin equality and a private client address are required. */
export function remoteDesktopSignalOriginAllowed(input: {
  requestProtocol: string;
  host?: string;
  origin?: string;
  remoteAddress?: string;
  publicBaseUrl?: string;
  allowInsecurePrivateNetwork: boolean;
}) {
  if (!input.host?.trim()) return false;
  try {
    const expected = new URL(input.publicBaseUrl?.trim() || `${input.requestProtocol}://${input.host}`);
    const actual = new URL(`${input.requestProtocol}://${input.host}`);
    const local = loopbackHosts.has(actual.hostname)
      && loopbackAddresses.has(input.remoteAddress ?? "")
      && input.origin === actual.origin;
    const privateHttp = input.allowInsecurePrivateNetwork
      && input.requestProtocol === "http"
      && actual.protocol === "http:"
      && expected.protocol === "http:"
      && actual.origin === expected.origin
      && isRemoteDesktopLocalNetworkAddress(actual.hostname)
      && isRemoteDesktopLocalNetworkAddress(expected.hostname)
      && isRemoteDesktopLocalNetworkAddress(input.remoteAddress ?? "")
      && input.origin === expected.origin;
    const secure = expected.protocol === "https:" && input.requestProtocol === "https";
    return local || (input.origin === expected.origin && (privateHttp || secure));
  } catch {
    return false;
  }
}
