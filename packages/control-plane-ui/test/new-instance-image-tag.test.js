import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { defaultImageTag, resolveImageTag, selectableImageTags } from "../src/apps/control-plane/new-instance/imageTagSelection.ts";

const runtimeStep = fs.readFileSync(new URL("../src/apps/control-plane/new-instance/RuntimeStep.vue", import.meta.url), "utf8");
const newInstanceModal = fs.readFileSync(new URL("../src/apps/control-plane/NewInstanceModal.vue", import.meta.url), "utf8");

function marketImage(tags, defaultTag) {
  return {
    id: "market_taskhandoff_codex",
    origin: "market",
    tag: defaultTag,
    availableTags: tags.map((tag) => (typeof tag === "string" ? { name: tag, status: "active" } : tag)),
  };
}

test("market images default to latest and fall back to their catalog tag", () => {
  assert.equal(defaultImageTag(marketImage(["v0.0.31", "latest"], "v0.0.31")), "latest");
  assert.equal(defaultImageTag(marketImage(["v0.0.31", "v0.0.30"], "v0.0.30")), "v0.0.30");
  assert.equal(defaultImageTag(marketImage([{ name: "latest", status: "yanked" }, "v0.0.31"], "v0.0.31")), "v0.0.31");
  assert.equal(defaultImageTag(undefined), "");
});

test("custom images expose no selectable tags and no default tag", () => {
  const custom = { id: "img_custom", origin: "custom", tag: "v1", availableTags: [{ name: "v1", status: "active" }] };
  assert.deepEqual(selectableImageTags(custom), []);
  assert.equal(defaultImageTag(custom), "");
  assert.equal(resolveImageTag(custom, "v1"), "");
});

test("resolving keeps a selectable choice and restores the default otherwise", () => {
  const image = marketImage(["latest", "v0.0.31", { name: "v0.0.30", status: "yanked" }], "latest");
  assert.equal(resolveImageTag(image, "v0.0.31"), "v0.0.31");
  assert.equal(resolveImageTag(image, ""), "latest");
  assert.equal(resolveImageTag(image, "v0.0.30"), "latest");
  assert.equal(resolveImageTag(image, "v9.9.9"), "latest");
});

test("runtime step restores the default image tag when switching back to the image environment", () => {
  assert.match(runtimeStep, /const selectableTags = computed\(\(\) => selectableImageTags\(selectedImage\.value\)\)/);
  const switchSource = runtimeStep.slice(
    runtimeStep.indexOf("const selectEnvironmentSource ="),
    runtimeStep.indexOf("const installGuidance ="),
  );
  assert.match(switchSource, /props\.runtimeDraft\.imageId \|\|= props\.images\[0\]\?\.id \|\| ""/);
  assert.match(switchSource, /props\.runtimeDraft\.imageTag = resolveImageTag\(selectedImage\.value, props\.runtimeDraft\.imageTag\)/);
});

test("new instance keeps the draft tag aligned with the selected image", () => {
  assert.match(newInstanceModal, /const selectedImageOption = computed\(\(\) => \(imageOptions\.data\.value \|\| \[\]\)\.find\(\(image\) => image\.id === runtimeDraft\.imageId\)\)/);
  assert.match(newInstanceModal, /runtimeDraft\.imageTag = resolveImageTag\(imageItems\.find\(\(image\) => image\.id === runtimeDraft\.imageId\), runtimeDraft\.imageTag\)/);
  assert.match(newInstanceModal, /runtimeDraft\.imageTag = defaultImageTag\(\(imageOptions\.data\.value \|\| \[\]\)\.find\(\(image\) => image\.id === imageId\)\)/);
  assert.match(newInstanceModal, /runtimeDraft\.imageTag = resolveImageTag\(selectedImageOption\.value, runtimeDraft\.imageTag\)/);
});
