import { z } from "zod";

export const BROWSER_AGENT_TOOL_NAMES = ["browser_cdp_access"] as const;

export const BrowserAgentToolNameSchema = z.enum(BROWSER_AGENT_TOOL_NAMES);
export type BrowserAgentToolName = z.infer<typeof BrowserAgentToolNameSchema>;
