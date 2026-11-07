import { ExpoFileValueStore } from '../platform/file-storage';
import { BrowserStartPageStore } from './start-page-store';

// URL collections can exceed SecureStore's per-item budget; reuse app file storage.
export const mobileBrowserStartPages = new BrowserStartPageStore(new ExpoFileValueStore());
