const { buildInstanceMenuItems } = require("./desktop-tray.cjs");

function createDesktopDockMenu(options) {
  if (!options.dock) return { destroy() {}, update() {} };
  const language = String(options.locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  let destroyed = false;

  function update(snapshot = { groups: [], state: "loading" }) {
    if (destroyed) return;
    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const items = groups.length > 0
      ? buildInstanceMenuItems(groups, options.onOpenInstance)
      : [{
          label: snapshot.state === "loading"
            ? (language === "zh" ? "正在加载实例…" : "Loading instances…")
            : snapshot.state === "error"
              ? (language === "zh" ? "实例加载失败" : "Failed to load instances")
              : (language === "zh" ? "暂无实例" : "No instances"),
          enabled: false,
        }];
    options.dock.setMenu(options.Menu.buildFromTemplate(items));
  }

  update();
  return {
    destroy() {
      destroyed = true;
      options.dock.setMenu(options.Menu.buildFromTemplate([]));
    },
    update,
  };
}

module.exports = { createDesktopDockMenu };
