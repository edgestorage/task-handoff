const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  DesktopEmbeddedBrowserPopupController,
  embeddedBrowserPopupKind,
} = require("../src/embedded-browser-popup.cjs");

class FakeWebContents extends EventEmitter {
  constructor(id = 20) {
    super();
    this.id = id;
    this.destroyed = false;
    this.stopCount = 0;
    this.windowOpenHandler = undefined;
  }

  isDestroyed() {
    return this.destroyed;
  }

  stop() {
    this.stopCount += 1;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class FakeHost extends EventEmitter {
  constructor() {
    super();
    this.id = 11;
    this.destroyed = false;
    this.sent = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

class FakeWindow extends EventEmitter {
  constructor(webContents = new FakeWebContents()) {
    super();
    this.webContents = webContents;
    this.destroyed = false;
    this.hideCount = 0;
  }

  isDestroyed() {
    return this.destroyed;
  }

  hide() {
    this.hideCount += 1;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

function controller(options = {}) {
  const sentTabs = [];
  const logs = [];
  const errors = [];
  const instance = new DesktopEmbeddedBrowserPopupController({
    isAllowedUrl: (url) => url === "about:blank" || String(url).startsWith("http://") || String(url).startsWith("https://"),
    sendNewTab: (input) => {
      sentTabs.push(input);
      return true;
    },
    logInfo: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    popupTimeoutMs: 50,
    ...options,
  });
  return { instance, sentTabs, logs, errors };
}

function navigationEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("popup classification preserves real popup semantics and converts plain tabs only", () => {
  assert.equal(embeddedBrowserPopupKind({ disposition: "foreground-tab", frameName: "" }), "tab");
  assert.equal(embeddedBrowserPopupKind({ disposition: "background-tab", frameName: "_blank" }), "tab");
  assert.equal(embeddedBrowserPopupKind({ disposition: "new-window", frameName: "oauth" }), "popup");
  assert.equal(embeddedBrowserPopupKind({ disposition: "foreground-tab", frameName: "oauth" }), "popup");
  assert.equal(embeddedBrowserPopupKind({ disposition: "foreground-tab", frameName: "", postBody: [{ type: "rawData" }] }), "popup");
  assert.equal(embeddedBrowserPopupKind({ disposition: "other", frameName: "" }), "popup");
});

test("blank foreground popups stay hidden until the page supplies a target URL", async () => {
  const { instance, sentTabs } = controller();
  const guest = new FakeWebContents(10);
  const host = new FakeHost();
  const parent = new FakeWindow();
  const response = instance.windowOpenResponse({
    guest,
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
    parentWindow: parent,
  });
  assert.equal(response.action, "allow");
  assert.deepEqual(response.overrideBrowserWindowOptions, { show: false, skipTaskbar: true });

  const popupContents = new FakeWebContents(21);
  const popup = new FakeWindow(popupContents);
  instance.handleCreatedWindow({
    guest,
    window: popup,
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
    host,
    instanceId: "instance-a",
  });
  assert.equal(popup.hideCount, 1);

  popupContents.emit("will-navigate", navigationEvent(), "about:blank");
  assert.equal(sentTabs.length, 0);

  const event = navigationEvent();
  popupContents.emit("will-navigate", event, "https://example.com/project?silentSignin=1");
  assert.equal(event.prevented, true);
  assert.equal(popupContents.stopCount, 1);
  assert.deepEqual(sentTabs, [{
    host,
    instanceId: "instance-a",
    url: "https://example.com/project?silentSignin=1",
    disposition: "foreground-tab",
  }]);
  await immediate();
  assert.equal(popup.destroyed, true);
});

test("a converted popup forwards only its first permitted navigation", () => {
  const { instance, sentTabs } = controller();
  const guest = new FakeWebContents(10);
  const host = new FakeHost();
  const popupContents = new FakeWebContents(22);
  const popup = new FakeWindow(popupContents);
  instance.handleCreatedWindow({
    guest,
    window: popup,
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
    host,
    instanceId: "instance-a",
  });

  popupContents.emit("will-navigate", navigationEvent(), "https://example.com/one");
  popupContents.emit("will-navigate", navigationEvent(), "https://example.com/two");

  assert.deepEqual(sentTabs.map((entry) => entry.url), ["https://example.com/one"]);
});

test("OAuth-style new-window popups remain real windows with opener semantics", () => {
  const { instance, sentTabs } = controller();
  const guest = new FakeWebContents(10);
  const host = new FakeHost();
  const parent = new FakeWindow();
  const details = {
    url: "https://accounts.example.com/oauth",
    disposition: "new-window",
    frameName: "oauth-popup",
    postBody: null,
  };
  const response = instance.windowOpenResponse({ guest, details, parentWindow: parent });
  assert.equal(response.action, "allow");
  assert.equal(response.overrideBrowserWindowOptions.show, true);
  assert.equal(response.overrideBrowserWindowOptions.parent, parent);

  const popupContents = new FakeWebContents(23);
  const popup = new FakeWindow(popupContents);
  instance.handleCreatedWindow({ guest, window: popup, details, host, instanceId: "instance-a" });
  assert.equal(popup.hideCount, 0);
  assert.equal(typeof popupContents.windowOpenHandler, "function");
  assert.equal(sentTabs.length, 0);

  const blocked = navigationEvent();
  popupContents.emit("will-navigate", blocked, "file:///etc/passwd");
  assert.equal(blocked.prevented, true);

  const nestedResponse = popupContents.windowOpenHandler({
    url: "https://accounts.example.com/child",
    disposition: "new-window",
    frameName: "child",
  });
  assert.equal(nestedResponse.action, "allow");
  assert.equal(nestedResponse.overrideBrowserWindowOptions.show, true);

  host.emit("destroyed");
  assert.equal(popup.destroyed, true);
});

test("pending blank popups time out and are destroyed", async () => {
  const { instance } = controller({ popupTimeoutMs: 5 });
  const guest = new FakeWebContents(10);
  const popup = new FakeWindow(new FakeWebContents(24));
  instance.handleCreatedWindow({
    guest,
    window: popup,
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
    host: new FakeHost(),
    instanceId: "instance-a",
  });
  await waitFor(() => popup.destroyed, "pending blank popup was not destroyed");
});

test("pending tab conversion is bounded per guest", () => {
  const { instance } = controller({ maxPendingTabsPerGuest: 1 });
  const guest = new FakeWebContents(10);
  const host = new FakeHost();
  const first = instance.windowOpenResponse({
    guest,
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
  });
  assert.equal(first.action, "allow");
  instance.handleCreatedWindow({
    guest,
    window: new FakeWindow(new FakeWebContents(25)),
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
    host,
    instanceId: "instance-a",
  });
  const second = instance.windowOpenResponse({
    guest,
    details: { url: "about:blank", disposition: "foreground-tab", frameName: "" },
  });
  assert.equal(second.action, "deny");
});

test("disallowed URLs are rejected before a popup is created", () => {
  const { instance } = controller();
  const response = instance.windowOpenResponse({
    guest: new FakeWebContents(10),
    details: { url: "file:///etc/passwd", disposition: "foreground-tab", frameName: "" },
  });
  assert.equal(response.action, "deny");
});
