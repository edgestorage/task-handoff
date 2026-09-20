import { act, fireEvent, render } from '@testing-library/react-native';
import { StorySchema } from '@task-handoff/protocol/stories';
import { createElement } from 'react';

import { parseStoryMaxIdleAiSessions, resolveStoryOwnerNodeId, StoryEditor } from '../src/stories/StoryEditor';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const mockDirectories = jest.mocked(useActiveDirectories);

beforeEach(() => {
  jest.clearAllMocks();
  mockDirectories.mockReturnValue({ state: { instances: [], nodes: [] } } as unknown as ReturnType<typeof useActiveDirectories>);
});

describe('StoryEditor', () => {
  test('selects the first available node after the directory loads', () => {
    expect(resolveStoryOwnerNodeId('', [])).toBe('');
    expect(resolveStoryOwnerNodeId('', [{ id: 'node-1' }])).toBe('node-1');
    expect(resolveStoryOwnerNodeId('node-2', [{ id: 'node-1' }])).toBe('node-2');
  });

  test('accepts only the protocol retention range', () => {
    expect(parseStoryMaxIdleAiSessions('1')).toBe(1);
    expect(parseStoryMaxIdleAiSessions('50')).toBe(50);
    expect(parseStoryMaxIdleAiSessions('0')).toBeUndefined();
    expect(parseStoryMaxIdleAiSessions('51')).toBeUndefined();
    expect(parseStoryMaxIdleAiSessions('1.5')).toBeUndefined();
  });

  test('loads and updates the same idle Session retention setting as the Web editor', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const update = jest.fn().mockResolvedValue(story);
    const retentionSettings = jest.fn().mockResolvedValue({ maxIdleAiSessions: 7 });
    mockRuntime.mockReturnValue({ api: { stories: { get: jest.fn().mockResolvedValue(story), retentionSettings, update } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    const retentionInput = await screen.findByLabelText('Keep idle AI Sessions');
    expect(retentionInput.props.value).toBe('7');

    await act(async () => { fireEvent.changeText(retentionInput, '9'); });
    expect(screen.getByLabelText('Keep idle AI Sessions').props.value).toBe('9');
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(retentionSettings).toHaveBeenCalledWith('story-1', 'node-1');
    expect(update).toHaveBeenCalledWith('story-1', 'node-1', expect.objectContaining({ maxIdleAiSessions: 9 }));
  });

  test('loads the four authoritative Agent tool categories and saves changed policy', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const updateAgentToolSettings = jest.fn().mockResolvedValue({
      policy: { content: true, actions: false, automations: true, aiSessions: false },
      revision: 'b'.repeat(64),
    });
    const agentToolSettings = jest.fn().mockResolvedValue({
      policy: { content: true, actions: false, automations: false, aiSessions: false },
      revision: 'a'.repeat(64),
    });
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{
      id: 'node-1', name: 'Node', connectionPhase: 'healthy',
      capabilities: [],
    }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    const node = jest.fn().mockResolvedValue({
      id: 'node-1',
      capabilities: { agent: { capabilities: { stories: { agentToolCapabilities: { policy: true } } } } },
    });
    mockRuntime.mockReturnValue({ api: { resources: { node }, stories: {
      get: jest.fn().mockResolvedValue(story),
      retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
      agentToolSettings,
      update: jest.fn().mockResolvedValue(story),
      updateAgentToolSettings,
    } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    expect((await screen.findByLabelText('Content')).props.value).toBe(true);
    expect(screen.getByLabelText('Preset actions').props.value).toBe(false);
    expect(screen.getByLabelText('Automations').props.value).toBe(false);
    expect(screen.getByLabelText('AI Sessions').props.value).toBe(false);

    await act(async () => { fireEvent(screen.getByLabelText('Automations'), 'valueChange', true); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(agentToolSettings).toHaveBeenCalledWith('story-1', 'node-1');
    expect(node).toHaveBeenCalledWith('node-1');
    expect(updateAgentToolSettings).toHaveBeenCalledWith('story-1', 'node-1', {
      content: true, actions: false, automations: true, aiSessions: false,
    });
  });

  test('disables Agent tool settings when the node capability is absent', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const agentToolSettings = jest.fn();
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{
      id: 'node-1', name: 'Node', connectionPhase: 'healthy', capabilities: [],
    }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: { resources: { node: jest.fn().mockResolvedValue({
      id: 'node-1',
      capabilities: { agent: { capabilities: { stories: { enabled: true, agentTools: true } } } },
    }) }, stories: {
      get: jest.fn().mockResolvedValue(story),
      retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
      agentToolSettings,
    } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    expect(await screen.findByText('Tool settings are not supported by this node agent.')).toBeTruthy();
    expect(agentToolSettings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Content')).toBeNull();
  });

  test('keeps the editor open when Agent tool policy save conflicts', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const onSaved = jest.fn();
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{
      id: 'node-1', name: 'Node', connectionPhase: 'healthy',
      capabilities: [],
    }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: { resources: { node: jest.fn().mockResolvedValue({
      id: 'node-1',
      capabilities: { agent: { capabilities: { stories: { agentToolCapabilities: { policy: true } } } } },
    }) }, stories: {
      get: jest.fn().mockResolvedValue(story),
      retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
      agentToolSettings: jest.fn().mockResolvedValue({ policy: { content: true, actions: false, automations: false, aiSessions: false }, revision: 'a'.repeat(64) }),
      update: jest.fn().mockResolvedValue(story),
      updateAgentToolSettings: jest.fn().mockRejectedValue(new Error('Story tool settings changed.')),
    } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved, storyId: 'story-1' }));
    await screen.findByLabelText('Preset actions');
    await act(async () => { fireEvent(screen.getByLabelText('Preset actions'), 'valueChange', true); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(await screen.findByText('Story tool settings changed.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Preset actions').props.value).toBe(true);
  });

  test('creates a Story with the Web editor retention default', async () => {
    const created = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const create = jest.fn().mockResolvedValue(created);
    mockRuntime.mockReturnValue({ api: { stories: { create } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'online' }] } } as unknown as ReturnType<typeof useActiveDirectories>);

    const screen = await render(createElement(StoryEditor, { onSaved: jest.fn() }));
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Title'), 'Release'); });
    expect(screen.getByLabelText('Title').props.value).toBe('Release');
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(create).toHaveBeenCalledWith('node-1', expect.objectContaining({ maxIdleAiSessions: 5, title: 'Release' }));
  });
});
