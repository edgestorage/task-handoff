import { SafeMarkdown } from './SafeMarkdown';
import type { MarkdownContentProps } from './MarkdownContent.types';

export function MarkdownContent({
  children,
  compact,
  nativeSelectable,
  onOpenBuiltinBrowser,
  streamKey,
  streaming,
  trimEnd,
}: MarkdownContentProps) {
  return <SafeMarkdown
    compact={compact}
    nativeSelectable={nativeSelectable}
    onOpenBuiltinBrowser={onOpenBuiltinBrowser}
    streamKey={streamKey}
    streaming={streaming}
    trimEnd={trimEnd}
  >{children}</SafeMarkdown>;
}
