import type { MessageShape } from "../en-US/index.ts";
import type { cliAuthorize as englishCliAuthorize } from "../en-US/cliAuthorize.ts";

export const cliAuthorize = {
  kicker: "命令行访问",
  title: "授权命令行登录",
  description: "一个命令行客户端正在请求访问此控制面板。批准后会为该客户端创建一个独立的 CLI 会话，浏览器会话不会交给客户端。",
  client: "客户端",
  platform: "平台",
  version: "版本",
  requestedAt: "请求时间",
  expiresAt: "过期时间",
  approve: "批准",
  deny: "拒绝",
  approvedTitle: "已批准登录",
  approvedDevice: "请回到终端继续完成登录。",
  approvedBrowser: "请回到终端继续完成登录。",
  deniedTitle: "已拒绝登录",
  deniedDescription: "命令行客户端未获得访问权限。",
  manualTitle: "输入设备码",
  manualDescription: "请输入终端上显示的设备码以继续。",
  userCodePlaceholder: "XXXX-XXXX",
  continue: "继续",
  statusApproved: "该请求已批准，再次点击批准即可继续登录。",
  statusDenied: "该请求已被拒绝。",
  statusExpired: "该请求已过期，请在终端重新发起登录。",
  statusConsumed: "该请求已用于登录。",
  platforms: {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  },
} as const satisfies MessageShape<typeof englishCliAuthorize>;
