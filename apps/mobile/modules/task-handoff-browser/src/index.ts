import TaskHandoffBrowserModule from './TaskHandoffBrowserModule';

export { default as TaskHandoffBrowserView } from './TaskHandoffBrowserView';
export * from './TaskHandoffBrowser.types';
export { createNativeRelaySocket, isNativeRelaySocketAvailable } from './native-relay-socket';

export const browserCapabilities = () => TaskHandoffBrowserModule.browserCapabilities();
export const browserDiagnostics = () => TaskHandoffBrowserModule.browserDiagnostics();
export const prepareBrowserContext = TaskHandoffBrowserModule.prepareBrowserContext.bind(TaskHandoffBrowserModule);
export const activateBrowserContext = TaskHandoffBrowserModule.activateBrowserContext.bind(TaskHandoffBrowserModule);
export const releaseBrowserContext = TaskHandoffBrowserModule.releaseBrowserContext.bind(TaskHandoffBrowserModule);
export const releaseAllBrowserContexts = TaskHandoffBrowserModule.releaseAllBrowserContexts.bind(TaskHandoffBrowserModule);
