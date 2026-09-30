export type AiSessionFinalReadyAction = "reset" | "wait" | "promote";

type AiSessionFinalReadyInput = {
  streaming: boolean;
  pacingFinal: boolean;
  activeAnimations: number;
};

/**
 * 决定流式 Markdown 视图当前的 final 渲染状态。
 *
 * 角色揭示动画由文字节点在内容变化后启动，其中也包括“切换到 final 解析”
 * 本身带来的内容变化。如果动画运行期间又退回非 final 渲染，解析结果会再次
 * 改变并触发新的动画，形成无限重渲染循环。因此动画只会推迟提升到 final，
 * 绝不能把已经就绪的 final 状态撤销。
 */
export function resolveFinalReadyAction(input: AiSessionFinalReadyInput): AiSessionFinalReadyAction {
  if (input.streaming || !input.pacingFinal) return "reset";
  if (input.activeAnimations > 0) return "wait";
  return "promote";
}
