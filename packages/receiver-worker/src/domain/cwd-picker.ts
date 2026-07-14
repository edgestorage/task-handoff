import fs from "node:fs";
import path from "node:path";

export type CwdPickerAction = {
  token: string;
  action: "up" | "confirm" | "cancel" | "open" | "prev" | "next";
  index?: number;
};

type CwdPickerSetResult = {
  ok: boolean;
  message: string;
};

export type CwdPicker = {
  conversationId: number;
  cwd: string;
  entries: string[];
  page: number;
};

const CWD_PICKER_PAGE_SIZE = 12;

function renderCwdPicker(store: Map<string, CwdPicker>, token: string) {
  const picker = store.get(token);
  if (!picker) {
    return undefined;
  }
  let allEntries: string[] = [];
  try {
    allEntries = fs
      .readdirSync(picker.cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    allEntries = [];
  }
  const totalPages = Math.max(1, Math.ceil(allEntries.length / CWD_PICKER_PAGE_SIZE));
  picker.page = Math.min(Math.max(0, picker.page || 0), totalPages - 1);
  const start = picker.page * CWD_PICKER_PAGE_SIZE;
  const entries = allEntries.slice(start, start + CWD_PICKER_PAGE_SIZE);
  picker.entries = entries;
  const rows = entries.map((name, index) => [
    { text: `[dir] ${name}`, callback_data: `task_handoff:cwd:${token}:open:${index}` },
  ]);
  if (totalPages > 1) {
    rows.push([
      { text: "上一页", callback_data: `task_handoff:cwd:${token}:prev` },
      { text: `第 ${picker.page + 1}/${totalPages} 页`, callback_data: `task_handoff:cwd:${token}:next` },
      { text: "下一页", callback_data: `task_handoff:cwd:${token}:next` },
    ]);
  }
  rows.push([
    { text: "上一层", callback_data: `task_handoff:cwd:${token}:up` },
    { text: "确认", callback_data: `task_handoff:cwd:${token}:confirm` },
    { text: "取消", callback_data: `task_handoff:cwd:${token}:cancel` },
  ]);
  return {
    text: [
      `设置 c${picker.conversationId} 工作目录`,
      "",
      picker.cwd,
      "",
      allEntries.length > 0
        ? `选择目录或确认当前目录。${totalPages > 1 ? `第 ${picker.page + 1}/${totalPages} 页，共 ${allEntries.length} 个目录。` : ""}`
        : "当前目录没有可进入的子目录。",
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows },
  };
}

function createCwdPicker(store: Map<string, CwdPicker>, conversationId: number, currentCwd = process.cwd(), cwdValue = "") {
  const cwd = path.resolve(process.cwd(), String(cwdValue || currentCwd));
  const token = Math.random().toString(36).slice(2, 10);
  store.set(token, { conversationId, cwd, entries: [], page: 0 });
  return { token, ...renderCwdPicker(store, token) };
}

function handleCwdPickerAction(
  store: Map<string, CwdPicker>,
  { token, action, index }: CwdPickerAction,
  setConversationCwd: (conversationId: number, cwd: string) => CwdPickerSetResult,
) {
  const picker = store.get(token);
  if (!picker) {
    return false;
  }
  if (action === "cancel") {
    store.delete(token);
    return { clear: true, message: "cancelled" };
  }
  if (action === "confirm") {
    store.delete(token);
    const result = setConversationCwd(picker.conversationId, picker.cwd);
    return {
      clear: true,
      message: result.ok ? "saved" : "failed",
      text: result.ok ? `已设置 c${picker.conversationId} 工作目录：${picker.cwd}` : result.message,
      replyMarkup: undefined,
    };
  }
  if (action === "up") {
    picker.cwd = path.dirname(picker.cwd);
    picker.page = 0;
  } else if (action === "prev") {
    picker.page = Math.max(0, (picker.page || 0) - 1);
  } else if (action === "next") {
    picker.page = (picker.page || 0) + 1;
  } else if (action === "open") {
    const name = picker.entries?.[index as number];
    if (!name) {
      return { ...renderCwdPicker(store, token), message: "directory not found" };
    }
    picker.cwd = path.join(picker.cwd, name);
    picker.page = 0;
  }
  return { ...renderCwdPicker(store, token), message: "updated" };
}

export { CWD_PICKER_PAGE_SIZE, createCwdPicker, handleCwdPickerAction, renderCwdPicker };
