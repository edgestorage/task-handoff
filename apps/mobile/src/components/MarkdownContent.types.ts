export type MarkdownContentProps = {
  children: string;
  compact?: boolean;
  nativeSelectable?: boolean;
  onAddToConversation?(text: string): void;
  onOpenBuiltinBrowser?(url: string): void | Promise<void>;
  onOpenFile?(href: string): void | Promise<void>;
  streamKey?: string;
  streaming?: boolean;
  trimEnd?: boolean;
};
