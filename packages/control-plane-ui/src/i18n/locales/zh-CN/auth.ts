import type { MessageShape } from "../en-US/index.ts";
import type { auth as englishAuth } from "../en-US/auth.ts";

export const auth = {
  controlPlane: "控制面板",
  loading: "加载中",
  createAdmin: "创建管理员",
  signIn: "登录",
  bootstrapDescription: "为此 Web 控制面板设置首位管理员。",
  signInDescription: "使用控制面板账户继续。",
  username: "用户名",
  password: "密码",
  working: "处理中",
  signOut: "退出登录",
  signingOut: "正在退出",
} as const satisfies MessageShape<typeof englishAuth>;
