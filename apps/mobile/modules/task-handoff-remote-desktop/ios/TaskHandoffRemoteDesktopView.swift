import AVFoundation
import ExpoModulesCore
import UIKit

public final class TaskHandoffRemoteDesktopView: ExpoView {
  let displayLayer = AVSampleBufferDisplayLayer()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    displayLayer.backgroundColor = UIColor.black.cgColor
    displayLayer.videoGravity = .resizeAspect
    layer.addSublayer(displayLayer)
    RemoteDesktopDecoderEngine.shared.attach(displayLayer)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    displayLayer.frame = bounds
    CATransaction.commit()
  }

  deinit {
    RemoteDesktopDecoderEngine.shared.detach(displayLayer)
  }
}
