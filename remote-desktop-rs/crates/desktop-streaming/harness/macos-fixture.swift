// Disposable AppKit input fixture. Records counts/expected-match only, never
// typed text, screen contents, application titles or unrelated input events.
import AppKit

final class MarkerView: NSView {
    var marked = false
    override func draw(_ dirtyRect: NSRect) {
        (marked ? NSColor.systemRed : NSColor.systemBlue).setFill()
        bounds.fill()
    }
}

@MainActor
final class Fixture: NSObject, NSApplicationDelegate, NSTextViewDelegate {
    var window: NSWindow!
    var text: NSTextView!
    var marker: MarkerView!
    var monitor: Any?
    var auxiliary: NSWindow?
    var cursorHidden = false
    var previous: NSRunningApplication?
    var downs = 0, ups = 0, clicks = 0, releases = 0
    var wheels = 0
    var lastMouseX: CGFloat = -1
    var lastMouseY: CGFloat = -1
    let expected = "中文・日本語・é・😀 mixed ASCII punctuation !?"

    func stringArgument(_ name: String) -> String? {
        guard let index = CommandLine.arguments.firstIndex(of: name),
              CommandLine.arguments.indices.contains(index + 1) else { return nil }
        return CommandLine.arguments[index + 1]
    }

    func sizeArgument(_ name: String) -> NSSize? {
        guard let value = stringArgument(name) else { return nil }
        let parts = value.split(separator: "x", maxSplits: 1).compactMap { Double($0) }
        guard parts.count == 2, parts.allSatisfy({ $0 > 0 }) else { return nil }
        return NSSize(width: parts[0], height: parts[1])
    }

    func aspectArgument() -> NSSize? {
        guard let value = stringArgument("--aspect-ratio") else { return nil }
        let parts = value.split(separator: ":", maxSplits: 1).compactMap { Double($0) }
        guard parts.count == 2, parts.allSatisfy({ $0 > 0 }) else { return nil }
        return NSSize(width: parts[0], height: parts[1])
    }

    func emit(_ kind: String) {
        let frame = window.frame
        let mainHeight: CGFloat = NSScreen.screens.first?.frame.height ?? 0
        let mainWidth: CGFloat = NSScreen.screens.first?.frame.width ?? 0
        let workArea = NSScreen.screens.first?.visibleFrame ?? .zero
        let display: [String: CGFloat] = ["x": 0, "y": 0, "width": mainWidth, "height": mainHeight]
        let state: [String: Any] = [
            "kind": kind, "pid": ProcessInfo.processInfo.processIdentifier,
            "active": NSApplication.shared.isActive,
            "display": display,
            "workArea": ["x": workArea.minX, "y": mainHeight - workArea.maxY,
                         "width": workArea.width, "height": workArea.height],
            "rect": ["x": frame.minX, "y": mainHeight - frame.maxY,
                     "width": frame.width, "height": frame.height],
            "keyDowns": downs, "keyUps": ups, "mouseDowns": clicks,
            "mouseUps": releases, "marked": marker.marked,
            "wheels": wheels, "lastMouseX": lastMouseX, "lastMouseY": lastMouseY,
            "characters": text.string.count, "expectedTextMatches": text.string == expected
        ]
        if let bytes = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(bytes)
            FileHandle.standardOutput.write(Data([10]))
        }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        previous = NSWorkspace.shared.frontmostApplication
        let fixed = CommandLine.arguments.contains("--fixed")
        window = NSWindow(contentRect: NSRect(x: 180, y: 160, width: 640, height: 360),
                          styleMask: fixed ? [.titled, .closable, .miniaturizable]
                                           : [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = stringArgument("--title") ?? "G1 owned macOS input fixture"
        if let minimum = sizeArgument("--min-size") { window.minSize = minimum }
        if let maximum = sizeArgument("--max-size") { window.maxSize = maximum }
        if let aspect = aspectArgument() { window.aspectRatio = aspect }
        if let initial = sizeArgument("--size") {
            window.setFrame(NSRect(origin: window.frame.origin, size: initial), display: true)
        }
        window.isReleasedWhenClosed = false
        let content = window.contentView!
        marker = MarkerView(frame: NSRect(x: 16, y: 280, width: 48, height: 48))
        content.addSubview(marker)
        text = NSTextView(frame: NSRect(x: 16, y: 16, width: 608, height: 240))
        text.isRichText = false
        text.font = NSFont.systemFont(ofSize: 16)
        text.delegate = self
        content.addSubview(text)
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .scrollWheel]) { [weak self] event in
            guard let self, event.window === self.window else { return event }
            switch event.type {
            case .keyDown: self.downs += 1
            case .keyUp: self.ups += 1
            case .leftMouseDown:
                self.clicks += 1
                self.lastMouseX = event.locationInWindow.x
                self.lastMouseY = event.locationInWindow.y
                self.marker.marked.toggle()
                self.marker.needsDisplay = true
            case .leftMouseUp: self.releases += 1
            case .scrollWheel:
                self.wheels += 1
                self.lastMouseX = event.locationInWindow.x
                self.lastMouseY = event.locationInWindow.y
            default: break
            }
            self.emit("input")
            return event
        }
        NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.emit("resized") }
        }
        if CommandLine.arguments.contains("--background") {
            window.orderBack(nil)
            emit("ready")
        } else {
            focus()
        }
        let duration = min(600, max(1, Int(CommandLine.arguments.dropFirst().first ?? "180") ?? 180))
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(duration)) {
            self.emit("expired")
            NSApplication.shared.terminate(nil)
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count <= 4096,
                      let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                      let action = request["action"] else { continue }
                DispatchQueue.main.async {
                    switch action {
                    case "focus": self.focus()
                    case "cursorHide":
                        if !self.cursorHidden { NSCursor.hide(); self.cursorHidden = true }
                        self.emit("cursorHidden")
                    case "cursorShow":
                        if self.cursorHidden { NSCursor.unhide(); self.cursorHidden = false }
                        self.emit("cursorShown")
                    case "move":
                        self.window.setFrameOrigin(NSPoint(x: 260, y: 180))
                        self.emit("moved")
                    case "resize":
                        self.window.setContentSize(NSSize(width: 720, height: 400))
                        self.emit("resized")
                    case "occlude":
                        self.auxiliary?.close()
                        let panel = NSPanel(contentRect: self.window.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                        panel.isReleasedWhenClosed = false
                        panel.level = .floating
                        panel.backgroundColor = .systemGreen
                        panel.orderFrontRegardless()
                        self.auxiliary = panel
                        self.emit("occluded")
                    case "steal":
                        self.auxiliary?.close()
                        let other = NSWindow(contentRect: NSRect(x: 1000, y: 150, width: 240, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
                        other.isReleasedWhenClosed = false
                        other.title = "G1 owned focus fixture"
                        other.makeKeyAndOrderFront(nil)
                        self.auxiliary = other
                        self.emit("stolen")
                    case "uncover":
                        self.auxiliary?.close(); self.auxiliary = nil
                        self.emit("uncovered")
                    case "minimize":
                        self.window.miniaturize(nil)
                        self.emit("minimized")
                    case "close":
                        self.window.close()
                        self.emit("closed")
                    case "clear": self.text.string = ""; self.emit("cleared")
                    case "snapshot": self.emit("snapshot")
                    case "quit": NSApplication.shared.terminate(nil)
                    default: break
                    }
                }
            }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
    }
    func focus() {
        if !NSApplication.shared.isActive || !window.isKeyWindow {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        window.makeFirstResponder(text)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150)) { self.emit("ready") }
    }
    func textDidChange(_ notification: Notification) { emit("text") }
    func applicationWillTerminate(_ notification: Notification) {
        if cursorHidden { NSCursor.unhide(); cursorHidden = false }
        if let monitor { NSEvent.removeMonitor(monitor) }
        if NSApplication.shared.isActive { previous?.activate(options: []) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
@main
struct Launcher {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let fixture = Fixture()
        app.delegate = fixture
        app.run()
    }
}
