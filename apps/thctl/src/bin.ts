import { runCli } from "./program.ts";

// 打包入口开启后台更新检查：每次调用按节流窗口刷新状态，提示在下一次调用输出。
void runCli(process.argv, { updateCheck: { enabled: true } }).then((code) => {
  process.exitCode = code;
});
