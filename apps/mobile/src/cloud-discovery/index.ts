import { mobileCloudDiscoveryConfig, mobileCloudEnvironment } from '../platform/build-variant';
import { ExpoFileValueStore } from '../platform/file-storage';
import { CloudEndpointResolver } from './resolver';

export const mobileCloudDiscovery = new CloudEndpointResolver({
  config: mobileCloudDiscoveryConfig,
  fallbackOrigin: mobileCloudDiscoveryConfig?.fallbackOrigin ?? mobileCloudEnvironment.serviceOrigin,
  store: new ExpoFileValueStore('taskhandoff-cloud-discovery'),
});

export { CloudEndpointResolver } from './resolver';
export { parseCloudDiscoveryRecord, decodeDnsTxtValue } from './format';
export type { CloudDiscoveryConfig } from './format';
export type { CloudRequestFunction } from './resolver';
