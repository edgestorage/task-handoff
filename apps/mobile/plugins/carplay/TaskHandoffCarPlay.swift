import CarPlay
import Foundation
import React

@objc(TaskHandoffWindowSceneDelegate)
final class TaskHandoffWindowSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let appWindow = appDelegate.window else { return }
    appWindow.windowScene = windowScene
    window = appWindow
    appWindow.makeKeyAndVisible()
  }
}

private struct TaskHandoffCarPlaySession {
  let id: String
  let instanceId: String
  let title: String
  let detail: String
  let status: String
  let instance: String

  init?(_ value: [String: Any]) {
    guard let id = value["id"] as? String,
          let instanceId = value["instanceId"] as? String,
          let title = value["title"] as? String,
          let detail = value["detail"] as? String,
          let status = value["status"] as? String,
          let instance = value["instance"] as? String else { return nil }
    self.id = id
    self.instanceId = instanceId
    self.title = title
    self.detail = detail
    self.status = status
    self.instance = instance
  }
}

private struct TaskHandoffCarPlaySection {
  let title: String
  let sessions: [TaskHandoffCarPlaySession]

  init?(_ value: [String: Any]) {
    guard let title = value["title"] as? String,
          let rawSessions = value["sessions"] as? [[String: Any]] else { return nil }
    self.title = title
    self.sessions = rawSessions.compactMap(TaskHandoffCarPlaySession.init)
  }
}

private final class TaskHandoffCarPlayCoordinator {
  static let shared = TaskHandoffCarPlayCoordinator()

  private let storageKey = "task-handoff.carplay.snapshot"
  private var interfaceController: CPInterfaceController?
  private var rootTemplate: CPListTemplate?
  private var sections: [TaskHandoffCarPlaySection] = []
  private var featuredSession: TaskHandoffCarPlaySession?
  private var updatedAt = ""

  private init() {
    if let stored = UserDefaults.standard.dictionary(forKey: storageKey) {
      apply(stored, persist: false)
    }
  }

  var connected: Bool { interfaceController != nil }

  func connect(_ controller: CPInterfaceController) {
    interfaceController = controller
    let template = makeRootTemplate()
    rootTemplate = template
    controller.setRootTemplate(template, animated: false, completion: nil)
    TaskHandoffCarPlayModule.emitConnection(true)
  }

  func disconnect(_ controller: CPInterfaceController) {
    guard interfaceController === controller else { return }
    interfaceController = nil
    rootTemplate = nil
    TaskHandoffCarPlayModule.emitConnection(false)
  }

  func apply(_ payload: [String: Any], persist: Bool = true) {
    guard let rawSections = payload["sections"] as? [[String: Any]] else { return }
    sections = rawSections.compactMap(TaskHandoffCarPlaySection.init)
    featuredSession = (payload["featured"] as? [String: Any]).flatMap(TaskHandoffCarPlaySession.init)
    updatedAt = payload["updatedAt"] as? String ?? ""
    if persist { UserDefaults.standard.set(payload, forKey: storageKey) }
    rootTemplate?.updateSections(makeSections())
    if #available(iOS 26.4, *) { rootTemplate?.listHeader = makeDetailsHeader() }
  }

  private func makeRootTemplate() -> CPListTemplate {
    let template = CPListTemplate(title: "TaskHandoff", sections: makeSections())
    template.emptyViewTitleVariants = ["No AI sessions"]
    template.emptyViewSubtitleVariants = ["Open TaskHandoff on iPhone to connect."]
    if #available(iOS 26.4, *) { template.listHeader = makeDetailsHeader() }
    return template
  }

  @available(iOS 26.4, *)
  private func makeDetailsHeader() -> CPListTemplateDetailsHeader? {
    guard let session = featuredSession,
          let image = UIImage(
            systemName: "bolt.horizontal.circle.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 36, weight: .semibold)
          )?.withTintColor(.systemBlue, renderingMode: .alwaysOriginal) else { return nil }
    return CPListTemplateDetailsHeader(
      thumbnail: CPThumbnailImage(image: image),
      title: session.title,
      subtitle: "\(session.instance) · \(session.status)",
      bodyVariants: [NSAttributedString(string: session.detail)],
      actionButtons: []
    )
  }

  private func makeSections() -> [CPListSection] {
    sections.compactMap { section in
      let items = section.sessions.map(makeListItem)
      return items.isEmpty ? nil : CPListSection(items: items, header: section.title, sectionIndexTitle: nil)
    }
  }

  private func makeListItem(_ session: TaskHandoffCarPlaySession) -> CPListItem {
    let item = CPListItem(text: session.title, detailText: session.detail)
    item.accessoryType = .disclosureIndicator
    item.handler = { [weak self] _, completion in
      self?.showDetail(session, completion: completion)
    }
    return item
  }

  private func showDetail(_ session: TaskHandoffCarPlaySession, completion: @escaping () -> Void) {
    guard let interfaceController else { completion(); return }
    let details = [
      CPInformationItem(title: "Status", detail: session.status),
      CPInformationItem(title: "Instance", detail: session.instance),
      CPInformationItem(title: "Activity", detail: session.detail),
    ]
    let template = CPInformationTemplate(title: session.title, layout: .twoColumn, items: details, actions: [])
    interfaceController.pushTemplate(template, animated: true) { _, _ in completion() }
  }
}

@objc(TaskHandoffCarPlay)
final class TaskHandoffCarPlayModule: RCTEventEmitter {
  private static weak var activeEmitter: TaskHandoffCarPlayModule?

  override init() {
    super.init()
    Self.activeEmitter = self
  }

  @objc override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! { ["TaskHandoffCarPlayConnectionChanged"] }

  @objc func update(_ payload: NSDictionary) {
    TaskHandoffCarPlayCoordinator.shared.apply(payload as? [String: Any] ?? [:])
  }

  @objc func isConnected(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(TaskHandoffCarPlayCoordinator.shared.connected)
  }

  static func emitConnection(_ connected: Bool) {
    activeEmitter?.sendEvent(withName: "TaskHandoffCarPlayConnectionChanged", body: ["connected": connected])
  }
}

@objc(TaskHandoffCarPlaySceneDelegate)
final class TaskHandoffCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    TaskHandoffCarPlayCoordinator.shared.connect(interfaceController)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController
  ) {
    TaskHandoffCarPlayCoordinator.shared.disconnect(interfaceController)
  }
}
