import { isPickerCacheUri } from '../src/platform/file-picker';

test('only treats picker-owned cache file URIs as temporary', () => {
  expect(isPickerCacheUri('file:///data/user/0/com.taskhandoff.mobile/cache/photo.jpg')).toBe(true);
  expect(isPickerCacheUri('file:///var/mobile/Containers/Data/Application/id/Library/Caches/photo.jpg')).toBe(true);
  expect(isPickerCacheUri('file:///var/mobile/Media/DCIM/photo.jpg')).toBe(false);
  expect(isPickerCacheUri('content://media/external/images/1')).toBe(false);
});
