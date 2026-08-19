import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/api/client.ts";
import { translateApiError } from "../src/i18n/apiError.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;

test("known ApiError codes use localized messages instead of the server message", () => {
  const error = new ApiError("server diagnostic must not be classified", "AUTH_LOGIN_FAILED", 401);
  assert.equal(translateApiError(error, english), "The username or password is incorrect.");
  assert.equal(translateApiError(error, chinese), "用户名或密码不正确。");
});

test("stable instance, node, and model errors have localized messages", () => {
  const cases = [
    ["LOCAL_FOLDER_REQUIRES_INSTANCE_NODE", "Select a local folder owned by the instance node.", "请选择实例所属节点上的本地文件夹。"],
    ["APP_CWD_REQUIRES_LOCAL_FOLDER_SOURCE", "A custom app working directory requires a local folder instance source.", "自定义 App 工作目录需要使用本地文件夹实例来源。"],
    ["NODE_LOCAL_FOLDER_NOT_FOUND", "The selected local folder was not found on the node.", "节点上不存在所选本地文件夹。"],
    ["NODE_FOLDER_PATH_NOT_FOUND", "The folder path does not exist on the node.", "节点上不存在该文件夹路径。"],
    ["NODE_FOLDER_PATH_NOT_DIRECTORY", "The selected path is not a folder.", "所选路径不是文件夹。"],
    ["NODE_FOLDER_PATH_UNREADABLE", "The folder cannot be accessed by the node agent.", "节点代理无法访问该文件夹。"],
    ["LOCAL_NODE_CANNOT_BE_DELETED", "The built-in local node cannot be deleted.", "无法删除内置本地节点。"],
    ["APP_CWD_OUTSIDE_WORKSPACE", "The app working directory must be inside the instance workspace.", "App 工作目录必须位于实例工作区内。"],
    ["MODEL_NOT_FOUND", "The selected model was not found.", "未找到所选模型。"],
    ["MODEL_DISABLED", "The selected model is disabled.", "所选模型已停用。"],
    ["MODEL_APP_MISMATCH", "The selected model is not compatible with this app.", "所选模型与此 App 不兼容。"],
    ["NODE_MODEL_NOT_FOUND", "The selected model was not found on the node.", "节点上不存在所选模型。"],
    ["NODE_MODEL_DISABLED", "The selected model is disabled on the node.", "所选模型已在节点上停用。"],
    ["NODE_MODEL_APP_MISMATCH", "The selected node model is not compatible with this app.", "所选节点模型与此 App 不兼容。"],
    ["NODE_MODEL_SELECTION_MISMATCH", "The model selection does not match the node assignment.", "模型选择与节点分配不一致。"],
    ["NODE_MODEL_HASH_INVALID", "The stored node model does not match its configuration.", "节点上存储的模型与其配置不一致。"],
    ["NODE_MODEL_MIGRATION_REQUIRED", "The instance model configuration requires manual migration.", "实例模型配置需要手动迁移。"],
  ];

  for (const [code, englishMessage, chineseMessage] of cases) {
    const error = { code, message: `raw server diagnostic for ${code}` };
    assert.equal(translateApiError(error, english), englishMessage);
    assert.equal(translateApiError(error, chinese), chineseMessage);
  }
});

test("validation errors preserve the server field path and reason", () => {
  const message = "name: Invalid input: expected string, received number";
  const error = new ApiError(message, "VALIDATION_ERROR", 400);
  assert.equal(translateApiError(error, english), message);
  assert.equal(translateApiError(error, chinese), message);
});

test("known structured errors interpolate allowlisted detail parameters", () => {
  const error = {
    code: "CONTROLLED_INSTANCE_NOT_FOUND",
    message: "original diagnostic",
    details: { id: "instance-42", ignored: "not displayed" },
  };
  assert.equal(translateApiError(error, english), "Controlled instance instance-42 was not found.");
  assert.equal(translateApiError(error, chinese), "未找到受控实例 instance-42。");
});

test("unknown codes preserve their non-empty server message verbatim", () => {
  const message = "Remote provider returned opaque diagnostic #42.";
  assert.equal(translateApiError({ code: "FUTURE_ERROR", message }, english), message);
  assert.equal(translateApiError({ code: "FUTURE_ERROR", message }, chinese), message);
});

test("a message without a code is preserved verbatim", () => {
  const message = "原始服务端诊断";
  assert.equal(translateApiError({ message }, english), message);
  assert.equal(translateApiError(new Error(message), chinese), message);
  assert.equal(translateApiError(new ApiError(message), english), message);
});

test("errors without display information use localized unknown fallback", () => {
  assert.equal(translateApiError({}, english), "Something went wrong.");
  assert.equal(translateApiError(null, chinese), "发生了未知错误。");
  assert.equal(translateApiError({ code: "FUTURE_ERROR", message: "   " }, english), "Something went wrong.");
});

test("an explicit contextual fallback is used only when the error has no message", () => {
  assert.equal(translateApiError(undefined, english, "Could not save settings."), "Could not save settings.");
  assert.equal(
    translateApiError({ code: "FUTURE_ERROR", message: "raw diagnostic" }, english, "Could not save settings."),
    "raw diagnostic",
  );
});
