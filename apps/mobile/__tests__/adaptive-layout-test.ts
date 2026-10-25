import {
  ADAPTIVE_CONTENT_MAX_WIDTH,
  ADAPTIVE_READING_MAX_WIDTH,
  adaptiveContentContainerStyle,
  adaptiveContentLayout,
  adaptiveContentStyle,
  adaptiveContentWidth,
  adaptiveScrollIndicatorInsets,
} from '../src/components/adaptive-layout';
import { StyleSheet } from 'react-native';

describe('adaptive layout sizing', () => {
  it('keeps compact windows at their natural width', () => {
    expect(adaptiveContentWidth(699)).toBeUndefined();
    expect(adaptiveContentStyle(390)).toBeUndefined();
  });

  it('lets regular content use its component padding before reaching the cap', () => {
    expect(adaptiveContentWidth(760)).toBe(760);
    expect(adaptiveContentStyle(760)).toBeUndefined();
  });

  it('caps large windows and centers the content', () => {
    expect(adaptiveContentWidth(1440)).toBe(ADAPTIVE_CONTENT_MAX_WIDTH);
    expect(adaptiveContentStyle(1440)).toEqual({ marginLeft: 300, marginRight: 300 });
  });

  it('supports a tighter reading column', () => {
    expect(adaptiveContentWidth(951, 780)).toBe(780);
    expect(adaptiveContentStyle(951, 780)).toEqual({ marginLeft: 85.5, marginRight: 85.5 });
  });

  it('keeps compact content clear of a native side rail', () => {
    expect(adaptiveContentLayout(466, ADAPTIVE_CONTENT_MAX_WIDTH, { right: 84 })).toEqual({
      contentInsets: { left: 0, right: 84 },
      contentStyle: { marginLeft: 0, marginRight: 84 },
      contentWidth: 382,
      regular: false,
      scrollIndicatorInsets: undefined,
    });
  });

  it('centers a regular column inside the safe area rather than under a side rail', () => {
    expect(adaptiveContentLayout(951, ADAPTIVE_READING_MAX_WIDTH, { right: 84 })).toEqual({
      contentInsets: { left: 43.5, right: 127.5 },
      contentStyle: { marginLeft: 43.5, marginRight: 127.5 },
      contentWidth: 780,
      regular: true,
      scrollIndicatorInsets: { bottom: 0, left: 43.5, right: 43.5, top: 0 },
    });
  });

  it('accounts for asymmetric side safe areas', () => {
    expect(adaptiveContentLayout(844, ADAPTIVE_CONTENT_MAX_WIDTH, { left: 47, right: 47 })).toEqual({
      contentInsets: { left: 47, right: 47 },
      contentStyle: { marginLeft: 47, marginRight: 47 },
      contentWidth: 750,
      regular: true,
      scrollIndicatorInsets: undefined,
    });
  });

  it('leaves ordinary phone layouts unchanged', () => {
    expect(adaptiveContentLayout(390)).toEqual({
      contentInsets: { left: 0, right: 0 },
      contentStyle: undefined,
      contentWidth: 390,
      regular: false,
      scrollIndicatorInsets: undefined,
    });
  });

  it('keeps horizontal safe-area insets inside the scroll content', () => {
    expect(StyleSheet.flatten(adaptiveContentContainerStyle(
      { paddingHorizontal: 16, paddingTop: 12 },
      { left: 13.5, right: 97.5 },
    ))).toEqual({
      paddingHorizontal: 16,
      paddingLeft: 29.5,
      paddingRight: 113.5,
      paddingTop: 12,
    });
    expect(adaptiveScrollIndicatorInsets({ left: 13.5, right: 97.5 }, { right: 84 })).toEqual({
      bottom: 0,
      left: 13.5,
      right: 13.5,
      top: 0,
    });
  });

  it('only adds the centered column offset to iOS scroll indicators', () => {
    expect(adaptiveScrollIndicatorInsets({ left: 43.5, right: 127.5 }, { right: 84 })).toEqual({
      bottom: 0,
      left: 43.5,
      right: 43.5,
      top: 0,
    });
    expect(adaptiveScrollIndicatorInsets({ left: 0, right: 84 }, { right: 84 })).toBeUndefined();
  });

  it('does not add scroll-content or indicator insets to compact layouts', () => {
    const contentStyle = { paddingHorizontal: 16 };
    expect(adaptiveContentContainerStyle(contentStyle, { left: 0, right: 0 })).toBe(contentStyle);
    expect(adaptiveScrollIndicatorInsets({ left: 0, right: 0 })).toBeUndefined();
  });
});
