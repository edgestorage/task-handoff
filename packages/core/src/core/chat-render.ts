import telegramifyMarkdown from "telegramify-markdown";

function telegramMarkdownEscape(value: unknown) {
  return telegramifyMarkdown(String(value), "escape").replace(/\n+$/, "");
}

function renderTelegramProgressText(text: unknown) {
  const [heading, ...lines] = String(text).split("\n");
  return [`*${telegramMarkdownEscape(heading)}*`, ...lines.map(telegramMarkdownEscape)].join("\n");
}

function telegramMarkdownV2ToLegacy(value: unknown) {
  return String(value).replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
}

export {
  renderTelegramProgressText,
  telegramMarkdownEscape,
  telegramMarkdownV2ToLegacy,
};
