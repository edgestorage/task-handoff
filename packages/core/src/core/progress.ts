import { findClaudeTranscriptPath, findCodexTranscriptPath, type TranscriptSummary, watchTranscript } from "./transcript";

type TranscriptProgressOptions = {
  heading: string;
  transcriptPath?: string;
  codexId?: string;
  claudeId?: string;
  cwd?: string;
  onUpdate: (text: string) => void;
};

type TranscriptProgress = {
  transcriptPath?: string;
  stop: () => void;
};

export function resolveTranscriptPath({
  transcriptPath,
  codexId,
  claudeId,
  cwd,
}: Pick<TranscriptProgressOptions, "transcriptPath" | "codexId" | "claudeId" | "cwd">) {
  return transcriptPath || findCodexTranscriptPath(codexId) || findClaudeTranscriptPath(claudeId, cwd);
}

function updateSummaries(summaries: TranscriptSummary[], summary: TranscriptSummary) {
  const existingIndex = summary.key ? summaries.findIndex((entry) => entry.key === summary.key) : -1;
  if (existingIndex !== -1) {
    summaries[existingIndex] = summary;
    return summaries;
  }
  if (summaries[summaries.length - 1]?.text === summary.text) {
    return summaries;
  }
  return summaries.concat(summary).slice(-3);
}

export function startTranscriptProgress({
  heading,
  transcriptPath,
  codexId,
  claudeId,
  cwd,
  onUpdate,
}: TranscriptProgressOptions): TranscriptProgress {
  const resolvedTranscriptPath = resolveTranscriptPath({ transcriptPath, codexId, claudeId, cwd });
  let summaries: TranscriptSummary[] = [];
  let lastRendered = "";

  const emit = () => {
    const rendered = [heading, ...summaries.map((entry) => entry.text)].join("\n");
    if (rendered === lastRendered) {
      return;
    }
    lastRendered = rendered;
    onUpdate(rendered);
  };

  emit();

  if (!resolvedTranscriptPath) {
    return {
      transcriptPath: undefined,
      stop: () => {},
    };
  }

  const stop = watchTranscript({
    transcriptPath: resolvedTranscriptPath,
    onUpdate: (summary) => {
      summaries = updateSummaries(summaries, summary);
      emit();
    },
  });

  return {
    transcriptPath: resolvedTranscriptPath,
    stop,
  };
}
