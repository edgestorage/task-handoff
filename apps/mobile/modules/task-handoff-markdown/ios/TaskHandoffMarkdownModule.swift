import ExpoModulesCore

public final class TaskHandoffMarkdownModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TaskHandoffMarkdown")

    View(TaskHandoffMarkdownView.self) {
      Events("onAddToConversation", "onLinkPress", "onLinkLongPress")

      Prop("markdown") { (view: TaskHandoffMarkdownView, markdown: String) in
        view.setMarkdown(markdown)
      }
      Prop("streamKey") { (view: TaskHandoffMarkdownView, streamKey: String?) in
        view.setStreamKey(streamKey)
      }
      Prop("streaming") { (view: TaskHandoffMarkdownView, streaming: Bool) in
        view.setStreaming(streaming)
      }
      Prop("compact") { (view: TaskHandoffMarkdownView, compact: Bool) in
        view.setCompact(compact)
      }
      Prop("trimEnd") { (view: TaskHandoffMarkdownView, trimEnd: Bool) in
        view.setTrimEnd(trimEnd)
      }
      Prop("theme") { (view: TaskHandoffMarkdownView, theme: TaskHandoffMarkdownTheme) in
        view.setTheme(theme)
      }
      Prop("labels") { (view: TaskHandoffMarkdownView, labels: TaskHandoffMarkdownLabels) in
        view.setLabels(labels)
      }
    }
  }
}
internal struct TaskHandoffMarkdownTheme: Record {
  @Field var background: String = "#00000000"
  @Field var border: String = "#d0d7de"
  @Field var codeBackground: String = "#f6f8fa"
  @Field var codeForeground: String = "#24292f"
  @Field var link: String = "#0969da"
  @Field var muted: String = "#57606a"
  @Field var surface: String = "#ffffff"
  @Field var surfaceHover: String = "#e9e9ef"
  @Field var surfaceInset: String = "#f8f8fa"
  @Field var surfaceRaised: String = "#ffffff"
  @Field var syntaxNumber: String = "#9a6700"
  @Field var tableBackground: String = "#ffffff"
  @Field var tableBorder: String = "#d1d1d6"
  @Field var tableHeaderBackground: String = "#f8f8fa"
  @Field var tableStripe: String = "#fcfcfc"
  @Field var tableText: String = "#1c1c1e"
  @Field var text: String = "#24292f"
}

internal struct TaskHandoffMarkdownLabels: Record {
  @Field var addToConversation: String?
  @Field var copy: String = "Copy"
  @Field var copied: String = "Copied"
  @Field var plainText: String = "Plain text"
}
