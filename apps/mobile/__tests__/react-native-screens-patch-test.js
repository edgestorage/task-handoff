const fs = require('node:fs');
const path = require('node:path');

const patch = fs.readFileSync(path.resolve(__dirname, '../../../patches/react-native-screens@4.26.2.patch'), 'utf8');
const screen = fs.readFileSync(path.resolve(__dirname, '../node_modules/react-native-screens/ios/RNSScreen.mm'), 'utf8');
const splitNavigation = fs.readFileSync(path.resolve(__dirname, '../node_modules/react-native-screens/ios/gamma/split/RNSSplitNavigationController.swift'), 'utf8');
const splitHost = fs.readFileSync(path.resolve(__dirname, '../node_modules/react-native-screens/ios/gamma/split/RNSSplitHostComponentView.mm'), 'utf8');

test('native screens resolves the top content scroll view through nested layout wrappers', () => {
  for (const source of [patch, screen]) {
    expect(source).toContain('- (nullable UIScrollView *)contentScrollViewForEdge:(NSDirectionalRectEdge)edge');
    expect(source).toMatch(/if \(edge == NSDirectionalRectEdgeTop\)[\s\S]*firstDescendantScrollViewInView:self\.view/);
    expect(source).toContain('return [super contentScrollViewForEdge:edge];');
  }
});

test('native split host retries the first mounting transaction after attaching to a window', () => {
  for (const source of [patch, splitHost]) {
    expect(source).toContain('if (self.window != nil && _controller.viewControllers.count == 0 && [self getNumberOfColumns] >= 2)');
    expect(source).toContain('[_controller setNeedsUpdateOfChildViewControllers];');
    expect(source).toContain('[_controller reactMountingTransactionDidMount];');
  }
});

test('native split columns leave header chrome to their nested navigation stack', () => {
  for (const source of [patch, splitNavigation]) {
    expect(source).toContain('header chrome belongs to the native');
    expect(source).toContain('setNavigationBarHidden(true, animated: false)');
  }
});

test('native split column wrappers inherit the split host safe area after resizing', () => {
  for (const source of [patch, splitNavigation]) {
    expect(source).toContain('viewSafeAreaInsetsDidChange()');
    expect(source).toContain('correctSafeAreaIfNeeded()');
    expect(source).toContain('additionalSafeAreaInsets = correction');
    expect(source).toContain('parentView.safeAreaInsets.top - systemInsets.top');
  }
});
