import { AppSessionList } from '../../../../src/app-sessions/AppSessionList';
import { useActiveAppSessions } from '../../../../src/app-sessions/use-active-app-sessions';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
export default function AppsRoute() {
  const { closeSession, state } = useActiveAppSessions();
  const { state: directory } = useActiveDirectories();
  const { scope } = useInstanceScope();
  return <AppSessionList directory={directory} onCloseSession={closeSession} scope={scope} state={state} />;
}
