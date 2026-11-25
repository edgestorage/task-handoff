import { NodeStateProjectionEventSchema } from '@task-handoff/protocol/control-plane';
import { safeParseResponse } from '@task-handoff/protocol/response-validation';
import type { MobileControlPlaneEvent } from './transport';

export function readNodeStateProjection(event: MobileControlPlaneEvent) {
  if (event.type !== 'node.connection.updated' && event.type !== 'node.proxy-state.updated') return undefined;
  const parsed = safeParseResponse(NodeStateProjectionEventSchema, event.payload);
  if (parsed.success && event.scope?.nodeId === parsed.data.nodeId) return parsed.data;
  return undefined;
}
