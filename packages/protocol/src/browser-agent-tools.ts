import { z } from "zod";

export const BROWSER_AGENT_TOOL_NAMES = ["browser_cdp_access"] as const;

export const BrowserAgentToolNameSchema = z.enum(BROWSER_AGENT_TOOL_NAMES);
export type BrowserAgentToolName = z.infer<typeof BrowserAgentToolNameSchema>;

export const BROWSER_CDP_ACCESS_DESCRIPTION = "返回内置浏览器的已鉴权 Chrome DevTools HTTP 基础端点（即 TaskHandoff 浏览器面板中的标签页）。成功时返回 status=granted，并包含 httpEndpoint、token 和 expiresAt。使用 Authorization: Bearer <token> 或 ?token=<token> 鉴权。GET <httpEndpoint>/json/version 可直接获取浏览器级 CDP WebSocket 地址，GET <httpEndpoint>/json/list 可获取页面目标及各自的 CDP WebSocket 地址。返回的地址已包含 token，在 expiresAt 之前，同一 token 可复用于获取连接和重连；如果浏览器访问被禁用或 AI Session 关闭，它会提前失效。如果浏览器访问未启用，调用会返回 status=pending 并附带 requestRef，或返回 status=denied、status=expired；请用户在审批中心批准后再次调用。";

export const BROWSER_AGENT_TOOL_DESCRIPTIONS: Record<BrowserAgentToolName, string> = {
  browser_cdp_access: BROWSER_CDP_ACCESS_DESCRIPTION,
};
