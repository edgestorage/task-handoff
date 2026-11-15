import ExpoModulesCore
import Foundation

public final class TaskHandoffRemoteDesktopModule: Module {
  private let queue = DispatchQueue(label: "com.taskhandoff.mobile.remote-desktop-decoder", qos: .userInitiated)
  private var textInputObserver: NSObjectProtocol?
  private var textInputNativeID: String?

  private func stopTextInputObservation() {
    if let textInputObserver { NotificationCenter.default.removeObserver(textInputObserver) }
    textInputObserver = nil
    textInputNativeID = nil
  }

  private func observedTextInput(_ object: Any) -> UITextField? {
    guard let field = object as? UITextField, let textInputNativeID else { return nil }
    var view: UIView? = field
    while let current = view {
      if current.accessibilityIdentifier == textInputNativeID { return field }
      if current.responds(to: NSSelectorFromString("nativeId")),
         let nativeID = current.value(forKey: "nativeId") as? String,
         nativeID == textInputNativeID { return field }
      view = current.superview
    }
    return nil
  }

  private func matchesTextInput(_ field: UITextField, nativeID: String) -> Bool {
    if field.accessibilityIdentifier == nativeID { return true }
    var view = field.superview
    while let current = view {
      if current.accessibilityIdentifier == nativeID { return true }
      if current.responds(to: NSSelectorFromString("nativeId")),
         let currentNativeID = current.value(forKey: "nativeId") as? String,
         currentNativeID == nativeID { return true }
      view = current.superview
    }
    return false
  }

  private func textFields(in view: UIView, matching nativeID: String) -> [UITextField] {
    var matches: [UITextField] = []
    if let field = view as? UITextField, matchesTextInput(field, nativeID: nativeID) {
      matches.append(field)
    }
    for subview in view.subviews {
      matches.append(contentsOf: textFields(in: subview, matching: nativeID))
    }
    return matches
  }

  private func focusedTextInput(nativeID: String) -> UITextField? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
    return windows
      .flatMap { textFields(in: $0, matching: nativeID) }
      .first { $0.isFirstResponder }
  }

  public func definition() -> ModuleDefinition {
    Name("TaskHandoffRemoteDesktop")
    Events("onRemoteDesktopDecoderError", "onRemoteDesktopVideoDimensions", "onRemoteDesktopTextInput")

    OnCreate { [weak self] in
      RemoteDesktopDecoderEngine.shared.onError = { [weak self] code, message in
        DispatchQueue.main.async {
          self?.sendEvent("onRemoteDesktopDecoderError", ["code": code, "message": message as Any])
        }
      }
      RemoteDesktopDecoderEngine.shared.onVideoDimensions = { [weak self] width, height in
        DispatchQueue.main.async {
          self?.sendEvent("onRemoteDesktopVideoDimensions", ["width": width, "height": height])
        }
      }
    }

    Function("isAvailable") { true }

    Function("startTextInputObservation") { (nativeID: String) -> Bool in
      self.stopTextInputObservation()
      var field: UITextField?
      if Thread.isMainThread {
        field = self.focusedTextInput(nativeID: nativeID)
      } else {
        DispatchQueue.main.sync {
          field = self.focusedTextInput(nativeID: nativeID)
        }
      }
      guard field != nil else { return false }
      self.textInputNativeID = nativeID
      self.textInputObserver = NotificationCenter.default.addObserver(
        forName: UITextField.textDidChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        guard let self, let field = self.observedTextInput(notification.object as Any) else { return }
        self.sendEvent("onRemoteDesktopTextInput", [
          "text": field.text ?? "",
          "composing": field.markedTextRange != nil,
        ])
      }
      return true
    }

    Function("stopTextInputObservation") {
      self.stopTextInputObservation()
    }

    AsyncFunction("configure") { (config: RemoteDesktopCodecConfig) in
      RemoteDesktopDecoderEngine.shared.configure(config)
    }.runOnQueue(queue)

    AsyncFunction("decode") { (data: Data, keyframe: Bool, timestampUs: Double) in
      RemoteDesktopDecoderEngine.shared.decode(data, keyframe: keyframe, timestampUs: timestampUs)
    }.runOnQueue(queue)

    AsyncFunction("reset") {
      RemoteDesktopDecoderEngine.shared.reset()
    }.runOnQueue(queue)

    AsyncFunction("close") {
      RemoteDesktopDecoderEngine.shared.close()
    }.runOnQueue(queue)

    View(TaskHandoffRemoteDesktopView.self) {}

    OnDestroy {
      self.stopTextInputObservation()
      RemoteDesktopDecoderEngine.shared.onError = nil
      RemoteDesktopDecoderEngine.shared.onVideoDimensions = nil
      RemoteDesktopDecoderEngine.shared.close()
    }
  }
}
