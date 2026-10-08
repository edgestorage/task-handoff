import type { MessageShape } from "../en-US/index.ts";
import type { auth as englishAuth } from "../en-US/auth.ts";

export const auth = {
  controlPlane: "控制面板",
  brandTagline: "面向本地与远程 AI 工作空间的统一控制面板。",
  linkWebsite: "官网",
  linkDocs: "文档",
  linkGithub: "GitHub",
  loading: "加载中",
  createAdmin: "创建管理员",
  signIn: "登录",
  bootstrapDescription: "为此 Web 控制面板设置首位管理员。",
  signInDescription: "使用控制面板账户继续。",
  username: "用户名",
  password: "密码",
  changeTemporaryPassword: "修改临时密码",
  changeTemporaryPasswordDescription: "请设置新密码后再继续使用控制面板。",
  currentPassword: "临时密码",
  newPassword: "新密码",
  confirmPassword: "确认密码",
  changePassword: "修改密码",
  passwordLength: "新密码至少需要 8 个字符。",
  passwordMismatch: "两次输入的密码不一致。",
  working: "处理中",
  signOut: "退出登录",
  signingOut: "正在退出",
} as const satisfies MessageShape<typeof englishAuth>;
