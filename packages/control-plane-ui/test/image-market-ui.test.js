import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_IMAGE_COVER_URL, resolveImageCover } from "../src/apps/control-plane/imageCover.ts";
import { resolveImageDescription } from "../src/apps/control-plane/shared/imageDescription.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("image covers resolve to a bundled safe default", () => {
  assert.equal(resolveImageCover(), DEFAULT_IMAGE_COVER_URL);
  assert.equal(resolveImageCover({ kind: "builtin", key: "default-image-cover" }), DEFAULT_IMAGE_COVER_URL);
  assert.equal(resolveImageCover({ kind: "builtin", key: "future-cover" }), DEFAULT_IMAGE_COVER_URL);
  assert.equal(resolveImageCover({ kind: "remote", url: "https://cdn.example/cover.png" }), "https://cdn.example/cover.png");
  assert.equal(fs.existsSync(path.join(__dirname, "../public", DEFAULT_IMAGE_COVER_URL)), true);
});

test("image descriptions resolve from the active locale with an English fallback", () => {
  const image = {
    description: "English description",
    localizedDescriptions: { "zh-CN": "中文说明", ja: "日本語の説明" },
  };
  assert.equal(resolveImageDescription(image, "zh-CN"), "中文说明");
  assert.equal(resolveImageDescription(image, "zh_CN"), "中文说明");
  assert.equal(resolveImageDescription(image, "ja-JP"), "日本語の説明");
  assert.equal(resolveImageDescription(image, "en-US"), "English description");
});

test("instance and settings surfaces preserve Market and Custom ownership", () => {
  const runtime = fs.readFileSync(path.join(__dirname, "../src/apps/control-plane/new-instance/RuntimeStep.vue"), "utf8");
  assert.match(runtime, /marketImages/);
  assert.match(runtime, /customImages/);
  assert.match(runtime, /availableTags/);
  assert.match(runtime, /ImageArtwork compact/);
  assert.match(runtime, /image-picker-trigger/);
  assert.match(runtime, /image-picker-option/);
  assert.match(runtime, /type="search"/);
  assert.match(runtime, /<ScrollArea class="image-picker-list">/);
  assert.match(runtime, /components\/ui\/scroll-area/);
  assert.match(runtime, /filteredImageGroups/);
  assert.match(runtime, /localizedImageDescription/);
  assert.match(runtime, /image\.description/);
  assert.match(runtime, /image\.reference/);
  assert.match(runtime, /image\.capabilities\.slice\(0, 3\)/);
  assert.match(runtime, /noImagesFound/);
  assert.match(runtime, /PopoverContent\s+class="image-picker-popover"/);
  assert.match(runtime, /padding: '4px'/);
  assert.match(runtime, /:collision-padding="12"/);
  assert.match(runtime, /--reka-popover-content-available-height/);
  assert.doesNotMatch(runtime, /max-height: min\(390px, 52vh\)/);
  assert.doesNotMatch(runtime, /\.image-picker-list\s*\{[^}]*overflow-y: auto/s);
  assert.match(runtime, /\.image-picker-options\s*\{[^}]*gap: 2px/s);
  assert.doesNotMatch(runtime, /ControlPlaneSelect v-model="runtimeDraft\.imageId"/);
  assert.doesNotMatch(runtime, /localSizeBytes/);
  assert.doesNotMatch(runtime, /downloadSizeBytes/);

  const settings = fs.readFileSync(path.join(__dirname, "../src/apps/control-plane/settings/SettingsModal.vue"), "utf8");
  assert.match(settings, /marketCatalog\.data/);
  assert.match(settings, /<ImageArtwork compact class="market-image-artwork"/);
  assert.match(settings, /imageRegistry\.official/);
  assert.match(settings, /image\.capabilities\.slice\(0, 3\)/);
  assert.match(settings, /\.market-image-card\s*\{[^}]*grid-template-columns: 40px minmax\(0, 1fr\)/s);
  assert.match(settings, /\.market-image-card\s*\{[^}]*min-height: 112px/s);
  assert.match(settings, /@media \(max-width: 1080px\)[^{]*\{[^}]*\.market-image-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(settings, /\.registered-image-artwork\s*\{[^}]*width: 36px/s);
  assert.doesNotMatch(settings, /grid-template-rows: 92px/);
  assert.match(settings, /removeImageProfile\(image\)/);
  assert.doesNotMatch(settings, /removeImageProfile\(market/);

  const artwork = fs.readFileSync(path.join(__dirname, "../src/apps/control-plane/shared/ImageArtwork.vue"), "utf8");
  assert.match(artwork, /<Box/);
  assert.doesNotMatch(artwork, /<Bot|<Monitor/);
  assert.doesNotMatch(artwork, /image-artwork-wordmark/);
  assert.match(artwork, /coverFailed = true/);

  const project = fs.readFileSync(path.join(__dirname, "../src/apps/control-plane/settings/useProjectSettings.ts"), "utf8");
  assert.match(project, /defaultImageSelection/);
  assert.doesNotMatch(project, /defaultImageId/);

  const nodeFolders = fs.readFileSync(path.join(__dirname, "../src/apps/control-plane/settings/useNodeResourceSettings.ts"), "utf8");
  assert.doesNotMatch(nodeFolders, /defaultImageSelection/);
  assert.doesNotMatch(nodeFolders, /nodeFolderImageOptions/);

  const nodeDetail = fs.readFileSync(path.join(__dirname, "../src/apps/control-plane/settings/NodeDetailPanel.vue"), "utf8");
  assert.doesNotMatch(nodeDetail, /nodeFolderDefaultImageId|nodeFolderImageOptions/);
  assert.match(nodeDetail, /renameNodeLocalFolder/);
});
