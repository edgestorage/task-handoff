const CONTEXT_MENU_LABELS = Object.freeze({
  zh: Object.freeze({ inspectElement: "检查元素", developerTools: "开发者工具" }),
  en: Object.freeze({ inspectElement: "Inspect Element", developerTools: "Developer Tools" }),
});

function embeddedBrowserContextMenuLabels(locale) {
  const language = String(locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  return CONTEXT_MENU_LABELS[language];
}

function openEmbeddedBrowserDevTools(guest, params) {
  if (!guest || guest.isDestroyed?.() || typeof guest.openDevTools !== "function") return;
  guest.openDevTools({ mode: "detach", activate: true });
  if (Number.isFinite(params?.x) && Number.isFinite(params?.y) && typeof guest.inspectElement === "function") {
    guest.inspectElement(params.x, params.y);
  }
}

function buildEmbeddedBrowserContextMenuTemplate({ guest, locale, params } = {}) {
  const labels = embeddedBrowserContextMenuLabels(locale);
  const canInspect = Number.isFinite(params?.x) && Number.isFinite(params?.y) && Boolean(guest);
  return [
    ...(canInspect ? [{ label: labels.inspectElement, click: () => openEmbeddedBrowserDevTools(guest, params) }] : []),
    ...(canInspect ? [{ type: "separator" }] : []),
    { label: labels.developerTools, click: () => openEmbeddedBrowserDevTools(guest) },
  ];
}

module.exports = {
  buildEmbeddedBrowserContextMenuTemplate,
  embeddedBrowserContextMenuLabels,
  openEmbeddedBrowserDevTools,
};
