import { fireEvent, render } from '@testing-library/react-native';

import { AnimatedSegmentedControl } from '../src/components/AnimatedSegmentedControl';
import { AnimatedTabStrip } from '../src/components/AnimatedTabStrip';

const options = [
  { label: 'App Sessions', testID: 'segment-apps', value: 'apps' },
  { label: 'Web Sessions', testID: 'segment-browser', value: 'browser' },
] as const;

test('exposes tab semantics and reports a changed selection', async () => {
  const onChange = jest.fn();
  const screen = await render(<AnimatedSegmentedControl
    accessibilityLabel="App Session sections"
    onChange={onChange}
    options={options}
    testID="section-tabs"
    value="apps"
  />);

  expect(screen.getByTestId('section-tabs').props.accessibilityLabel).toBe('App Session sections');
  expect(screen.getByTestId('section-tabs').props.accessibilityRole).toBe('tablist');
  expect(screen.getByTestId('segment-apps').props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByTestId('segment-browser').props.accessibilityState).toEqual({ selected: false });

  await fireEvent.press(screen.getByTestId('segment-browser'));
  expect(onChange).toHaveBeenCalledWith('browser');
});

test('scrollable tabs keep their semantics and selection indicator', async () => {
  const onChange = jest.fn();
  const screen = await render(<AnimatedTabStrip
    indicatorTestID="filter-indicator"
    onChange={onChange}
    options={[
      { label: 'All', testID: 'filter-all', value: 'all' },
      { label: 'Active', testID: 'filter-active', value: 'active' },
    ]}
    scrollTestID="filter-scroll"
    testID="filters"
    value="all"
  />);

  expect(screen.getByTestId('filters').props.accessibilityRole).toBe('tablist');
  expect(screen.getByTestId('filter-scroll').props.horizontal).toBe(true);
  expect(screen.getByTestId('filter-indicator')).toBeTruthy();
  expect(screen.getByTestId('filter-all').props.accessibilityState).toEqual({ selected: true });

  await fireEvent.press(screen.getByTestId('filter-active'));
  expect(onChange).toHaveBeenCalledWith('active');
});
