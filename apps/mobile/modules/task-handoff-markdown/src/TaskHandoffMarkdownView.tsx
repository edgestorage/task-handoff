import type { ViewProps } from 'react-native';
import { requireNativeView } from 'expo';

export type TaskHandoffMarkdownTheme = {
  background: string;
  border: string;
  codeBackground: string;
  codeForeground: string;
  link: string;
  muted: string;
  surface: string;
  surfaceHover: string;
  surfaceInset: string;
  surfaceRaised: string;
  syntaxNumber: string;
  tableBackground: string;
  tableBorder: string;
  tableHeaderBackground: string;
  tableStripe: string;
  tableText: string;
  text: string;
};

export type TaskHandoffMarkdownLabels = {
  addToConversation?: string;
  copied: string;
  copy: string;
  plainText: string;
};

export type TaskHandoffMarkdownViewProps = ViewProps & {
  compact?: boolean;
  labels: TaskHandoffMarkdownLabels;
  markdown: string;
  streamKey?: string;
  streaming?: boolean;
  theme: TaskHandoffMarkdownTheme;
  trimEnd?: boolean;
  onAddToConversation?: (event: { nativeEvent: { text: string } }) => void;
  onLinkPress?: (event: { nativeEvent: { url: string } }) => void;
  onLinkLongPress?: (event: { nativeEvent: { height: number; url: string; width: number; x: number; y: number } }) => void;
};

const NativeView = requireNativeView<TaskHandoffMarkdownViewProps>('TaskHandoffMarkdown');

export default NativeView;
