import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react-native';

import { StoryDocumentPreview, htmlPreviewNavigationDisposition, isHtmlStoryPath } from '../src/stories/StoryDocumentPreview';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';

jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/components/theme', () => ({ useMobileTheme: () => ({ colors: { background: '#fff', error: '#f00', text: '#111', textMuted: '#666' } }) }));
jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);

describe('mobile Story document HTML preview', () => {
  test('recognizes both HTML document extensions without changing other preview types', () => {
    expect(isHtmlStoryPath('report.html')).toBe(true);
    expect(isHtmlStoryPath('nested/REPORT.HTM')).toBe(true);
    expect(isHtmlStoryPath('report.md')).toBe(false);
    expect(isHtmlStoryPath('report.html.txt')).toBe(false);
  });

  test('keeps the embedded document local and sends only safe external links outward', () => {
    expect(htmlPreviewNavigationDisposition('about:blank')).toBe('local');
    expect(htmlPreviewNavigationDisposition('about:blank#section')).toBe('local');
    expect(htmlPreviewNavigationDisposition('data:text/html;charset=utf-8,content')).toBe('local');
    expect(htmlPreviewNavigationDisposition('https://example.com')).toBe('external');
    expect(htmlPreviewNavigationDisposition('mailto:owner@example.com')).toBe('external');
    expect(htmlPreviewNavigationDisposition('javascript:alert(1)')).toBe('blocked');
    expect(htmlPreviewNavigationDisposition('file:///etc/passwd')).toBe('blocked');
  });

  test('renders HTML content in the isolated WebView', async () => {
    const content = '<!doctype html><html><body><h1>Report</h1></body></html>';
    mockRuntime.mockReturnValue({ api: { stories: { preview: jest.fn().mockResolvedValue({
      content,
      revision: 'a'.repeat(64),
      size: content.length,
      storyPath: 'report.html',
    }) } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryDocumentPreview, { storyId: 'story-1', nodeId: 'node-1', storyPath: 'report.html' }));
    await waitFor(() => expect(screen.getByTestId('story-html-preview')).toBeTruthy());

    expect(screen.getByTestId('story-html-preview').props.source).toEqual({ html: content, baseUrl: 'about:blank' });
    expect(screen.queryByText(content)).toBeNull();
  });
});
