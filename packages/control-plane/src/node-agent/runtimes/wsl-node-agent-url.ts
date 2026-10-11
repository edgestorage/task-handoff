/**
 * 实例回连 Node Agent 的地址（openspec change add-wsl-runtime，Phase 5 / D16）。
 *
 * WSL2 distro 位于独立网络命名空间，`127.0.0.1` 指向 distro 自身；宿主 Node Agent 需经
 * 宿主网关（NAT 模式下默认网关即 Windows 宿主）或显式配置的地址访问。这里把「host[:port]」
 * 或完整 URL 归一为 origin，端口缺省用 Node Agent 监听端口。
 */
export function normalizeNodeAgentUrl(value: string, defaultPort: number) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("A node agent URL is required.");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    return url.origin;
  }
  const match = /^([^:/]+)(?::(\d+))?$/.exec(trimmed);
  if (!match) throw new Error(`Node agent address ${value} is not a valid host[:port] or URL.`);
  const port = match[2] ? Number(match[2]) : defaultPort;
  return `http://${match[1]}:${port}`;
}
