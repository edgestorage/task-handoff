import ExpoModulesCore
import Foundation

public final class TaskHandoffRemoteDesktopModule: Module {
  private let queue = DispatchQueue(label: "com.taskhandoff.mobile.remote-desktop-decoder", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("TaskHandoffRemoteDesktop")
    Events("onRemoteDesktopDecoderError")

    OnCreate { [weak self] in
      RemoteDesktopDecoderEngine.shared.onError = { [weak self] code, message in
        DispatchQueue.main.async {
          self?.sendEvent("onRemoteDesktopDecoderError", ["code": code, "message": message as Any])
        }
      }
    }

    Function("isAvailable") { true }

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
      RemoteDesktopDecoderEngine.shared.onError = nil
      RemoteDesktopDecoderEngine.shared.close()
    }
  }
}
