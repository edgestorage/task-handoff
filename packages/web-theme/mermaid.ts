import type { RenderResult } from "mermaid";

export type MermaidTheme = "dark" | "default";

let nextDiagramId = 0;
let renderQueue: Promise<void> = Promise.resolve();

export function renderMermaid(source: string, theme: MermaidTheme): Promise<RenderResult> {
  const renderJob = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      flowchart: { htmlLabels: false },
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      theme,
    });
    nextDiagramId += 1;
    return mermaid.render(`markdown-mermaid-${nextDiagramId}`, source);
  });

  renderQueue = renderJob.then(() => undefined, () => undefined);
  return renderJob;
}
