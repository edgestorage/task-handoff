import { requireNativeView } from 'expo';
import React from 'react';

import type { BrowserViewProps } from './TaskHandoffBrowser.types';

let NativeView: React.ComponentType<BrowserViewProps> | undefined;
try { NativeView = requireNativeView('TaskHandoffBrowser'); } catch { NativeView = undefined; }

export default function TaskHandoffBrowserView(props: BrowserViewProps) {
  return NativeView ? <NativeView {...props} /> : null;
}
