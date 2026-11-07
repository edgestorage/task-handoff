import { requireOptionalNativeModule } from 'expo';

export { default } from './src/TaskHandoffMarkdownView';
export type { TaskHandoffMarkdownTheme, TaskHandoffMarkdownViewProps } from './src/TaskHandoffMarkdownView';

export const isTaskHandoffMarkdownAvailable = requireOptionalNativeModule('TaskHandoffMarkdown') !== null;
