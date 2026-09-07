import { render } from '@testing-library/react-native';
import { StorySchema } from '@task-handoff/protocol/stories';

import { StoryAutomationForm } from '../src/stories/StoryAutomationForm';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));

const story = StorySchema.parse({
  id: 'story-1',
  ownerNodeId: 'node-1',
  title: 'Release',
  actions: [{ id: 'deploy', title: 'Deploy', promptTemplate: 'Deploy it', targetInstanceId: 'instance-1' }],
  documents: [],
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
});

test('keeps automation fields below the transparent navigation header', async () => {
  jest.mocked(useMobileControlPlaneRuntime).mockReturnValue({
    api: { stories: { get: jest.fn().mockResolvedValue(story) } },
  } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
  jest.mocked(useActiveDirectories).mockReturnValue({
    state: { instances: [{ id: 'instance-1', name: 'Instance', nodeId: 'node-1', ready: true }], nodes: [] },
  } as unknown as ReturnType<typeof useActiveDirectories>);

  const screen = await render(<StoryAutomationForm nodeId="node-1" onSaved={jest.fn()} storyId={story.id} />);

  await screen.findByText('Schedule');
  expect(screen.getByTestId('story-automation-scroll').props.contentInsetAdjustmentBehavior).toBe('automatic');
});
