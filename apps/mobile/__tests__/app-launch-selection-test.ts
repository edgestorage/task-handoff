import type { ControlPlaneInstanceResourceEntry, ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';
import { resolveAppLaunchSelection } from '../src/app-sessions/new-app-session-types';

const terminal = { id: 'terminal', name: 'Terminal', kind: 'tty' as const, supportsCwdSelection: true };
const browser = { id: 'embedded-browser', name: 'Browser', kind: 'web' as const, supportsCwdSelection: false };
const instance = { id: 'instance', nodeId: 'node', runtime: { type: 'local' }, availableApps: [terminal] } as ControlPlaneInstanceResourceEntry;
const folder = { id: 'folder', nodeId: 'node' } as ControlPlaneNodeLocalFolder;
const selection = { controlPlaneId: 'cp', instanceId: 'instance', appId: 'terminal', folderId: 'folder' };

test('a late browser capability cannot switch the directory App default or an explicit selection', () => {
  expect(resolveAppLaunchSelection('cp', instance, [terminal], {}, []).app).toBe(terminal);
  expect(resolveAppLaunchSelection('cp', instance, [browser, terminal], {}, []).app).toBe(terminal);
  expect(resolveAppLaunchSelection('cp', instance, [browser, terminal], selection, []).app).toBe(terminal);
  expect(resolveAppLaunchSelection('cp', instance, [browser, terminal], { ...selection, appId: browser.id }, []).app).toBe(browser);
  expect(resolveAppLaunchSelection('cp', { ...instance, availableApps: [] }, [browser], {}, []).app).toBe(browser);
});

test('workspace selection is only valid for the selected CP, instance, App and authoritative folder', () => {
  expect(resolveAppLaunchSelection('cp', instance, [terminal], selection, [folder]).folderId).toBe('folder');
  expect(resolveAppLaunchSelection('other-cp', instance, [terminal], selection, [folder]).folderId).toBeUndefined();
  expect(resolveAppLaunchSelection('cp', { ...instance, id: 'other-instance' }, [terminal], selection, [folder]).folderId).toBeUndefined();
  expect(resolveAppLaunchSelection('cp', instance, [terminal], selection, []).folderId).toBeUndefined();
  expect(resolveAppLaunchSelection('cp', instance, [terminal], selection, [{ ...folder, nodeId: 'other-node' }]).folderId).toBeUndefined();
  expect(resolveAppLaunchSelection('cp', instance, [browser], { ...selection, appId: browser.id }, [folder]).folderId).toBeUndefined();
  expect(resolveAppLaunchSelection('cp', { ...instance, runtime: { id: 'docker', type: 'docker' } }, [terminal], selection, [folder]).folderId).toBeUndefined();
});
