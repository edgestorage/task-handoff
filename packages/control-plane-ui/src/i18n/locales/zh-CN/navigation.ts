import type { MessageShape } from "../en-US/index.ts";
import type { navigation as englishNavigation } from "../en-US/navigation.ts";

export const navigation = {
  home: "首页",
  board: "看板",
  ai: "AI",
  settings: "设置",
  user: "用户",
  userMenu: "用户菜单",
  signedInAs: "当前登录",
  instances: "实例",
  nodes: "节点",
  workbenchView: "工作台视图",
  windowControls: "窗口控制",
  controlPlane: "控制面板",
} as const satisfies MessageShape<typeof englishNavigation>;
