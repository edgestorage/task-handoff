import type { CloudFetch } from './doh';

export const defaultCloudFetch: CloudFetch = (input, init) => fetch(input, init);
