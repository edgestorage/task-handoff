/**
 * 本地信任会话：authentication disabled 的桌面控制面板在 loopback 上为同机 CLI
 * 签发可审计的 CLI 会话。信任边界是"同机 + 进程身份"，因此唯一允许的来源地址是 loopback。
 */
export const LOCAL_TRUST_OPERATOR_DISPLAY_NAME = "Local Operator";

/** 只接受 socket 层地址；转发头不参与判断，避免代理伪造来源。 */
export function isLoopbackRemoteAddress(address: string | undefined) {
  if (typeof address !== "string" || !address) return false;
  const value = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (value === "::1") return true;
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) && octets[0] === "127";
}
