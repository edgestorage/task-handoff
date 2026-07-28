import type { MessageShape } from "../en-US/index.ts";
import type { common as englishCommon } from "../en-US/common.ts";

export const common = {
  productName: "TaskHandoff",
  products: {
    codex: "Codex",
    claude: "Claude",
  },
  imageCapabilities: {
    browser: "浏览器",
    terminal: "终端",
    "gui-terminal": "桌面终端",
    "vscode-web": "VS Code",
    codex: "Codex",
    claude: "Claude",
  },
  actions: {
    add: "添加",
    back: "返回",
    cancel: "取消",
    close: "关闭",
    confirm: "确认",
    copy: "复制",
    create: "创建",
    delete: "删除",
    edit: "编辑",
    minimize: "最小化",
    maximize: "最大化",
    open: "打开",
    refresh: "刷新",
    refreshing: "正在刷新",
    retry: "重试",
    save: "保存",
    search: "搜索",
    update: "更新",
  },
  status: {
    enabled: "已启用",
    disabled: "已禁用",
    running: "运行中",
    stopped: "已停止",
    off: "关闭",
    unknown: "未知",
    unknownValue: "未知（{value}）",
  },
  language: {
    label: "语言",
    system: "跟随系统",
    enUS: "English",
    zhCN: "简体中文",
  },
  appAccess: {
    loading: "正在加载会话...", vncSession: "VNC 会话", appSession: "应用会话", noDirectView: "此应用会话没有可直接访问的视图。",
    connecting: "正在连接", unavailable: "不可用", linkExpires: "链接于 {time} 过期", connected: "已连接",
  },
} as const satisfies MessageShape<typeof englishCommon>;
