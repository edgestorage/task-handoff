import { CLOUD_PRODUCTION_ORIGIN } from '../src/control-plane/cloud-account';
import { allowCloudRelayUrlForService } from '../src/control-plane/relay-channel';

test('production cloud connectivity trusts only the thandoff.com service and Relay domains', () => {
  expect(CLOUD_PRODUCTION_ORIGIN).toBe('https://cloud.thandoff.com');
  expect(allowCloudRelayUrlForService(new URL('wss://eu.relay.thandoff.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(true);
  expect(allowCloudRelayUrlForService(new URL('wss://relay.taskhandoff.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(false);
  expect(allowCloudRelayUrlForService(new URL('wss://eu.relay.taskhandoff.com/connect'), CLOUD_PRODUCTION_ORIGIN)).toBe(false);
});
