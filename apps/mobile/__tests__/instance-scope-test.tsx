import { useEffect } from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { InstanceScopeProvider, useInstanceScope } from '../src/instance-scope/use-instance-scope';

const mockDirectory = {
  controlPlaneId: 'cp-1',
  state: { instances: [{ id: 'instance-1' }] },
};

jest.mock('../src/directories/use-directories', () => ({
  useActiveDirectories: () => mockDirectory,
}));

test('instance scope updates keep setScope stable and ignore equivalent writes', async () => {
  let effectRuns = 0;
  function Consumer() {
    const { scope, setScope } = useInstanceScope();
    useEffect(() => {
      effectRuns += 1;
      setScope({ kind: 'instance', instanceId: 'instance-1' });
    }, [setScope]);
    return <Text>{scope.kind === 'instance' ? scope.instanceId : scope.kind}</Text>;
  }

  const screen = await render(<InstanceScopeProvider><Consumer /></InstanceScopeProvider>);
  await waitFor(() => screen.getByText('instance-1'));
  expect(effectRuns).toBe(1);
});
