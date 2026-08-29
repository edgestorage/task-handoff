import TaskHandoffBrowserModule from './TaskHandoffBrowserModule';

export { default as TaskHandoffBrowserView } from './TaskHandoffBrowserView';
export * from './TaskHandoffBrowser.types';

export const browserCapabilities = () => TaskHandoffBrowserModule.browserCapabilities();
export const browserDiagnostics = () => TaskHandoffBrowserModule.browserDiagnostics();
export const prepareBrowserContext = TaskHandoffBrowserModule.prepareBrowserContext.bind(TaskHandoffBrowserModule);
export const releaseBrowserContext = TaskHandoffBrowserModule.releaseBrowserContext.bind(TaskHandoffBrowserModule);
export const releaseAllBrowserContexts = TaskHandoffBrowserModule.releaseAllBrowserContexts.bind(TaskHandoffBrowserModule);
