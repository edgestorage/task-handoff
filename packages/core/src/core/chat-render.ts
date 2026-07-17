import telegramifyMarkdown from "telegramify-markdown";

function telegramMarkdownEscape(value: unknown) {
  return telegramifyMarkdown(String(value), "escape").replace(/\n+$/, "");
}

function renderTelegramProgressText(text: unknown) {
  const [heading, ...lines] = String(text).split("\n");
  return [`*${telegramMarkdownEscape(heading)}*`, ...lines.map(telegramMarkdownEscape)].join("\n");
}

function renderBoundedTelegramProgressText(text: unknown, maxLength = 4000) {
  const source = String(text);
  const rendered = renderTelegramProgressText(source);
  if (rendered.length <= maxLength) return rendered;

  const [heading, ...lines] = source.split("\n");
  const body = lines.join("\n");
  const marker = "...\n";
  let boundedHeading = heading;
  while (renderTelegramProgressText(`${boundedHeading}\n${marker}`).length > maxLength && boundedHeading.length > 0) {
    boundedHeading = boundedHeading.slice(0, Math.floor(boundedHeading.length * 0.8));
  }
  let low = 0;
  let high = body.length;
  let bestLength = 0;
  let best = renderTelegramProgressText(`${boundedHeading}\n${marker}`);
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = renderTelegramProgressText(`${boundedHeading}\n${marker}${body.slice(-length)}`);
    if (candidate.length <= maxLength) {
      best = candidate;
      bestLength = length;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  const tail = body.slice(-bestLength);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < 200) {
    best = renderTelegramProgressText(`${boundedHeading}\n${marker}${tail.slice(firstNewline + 1)}`);
  }
  return best;
}

function telegramMarkdownV2ToLegacy(value: unknown) {
  return String(value).replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
}

export {
  renderBoundedTelegramProgressText,
  renderTelegramProgressText,
  telegramMarkdownEscape,
  telegramMarkdownV2ToLegacy,
};
