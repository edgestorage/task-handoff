const fs = require('node:fs');
const path = require('node:path');

const patch = fs.readFileSync(path.resolve(__dirname, '../../../patches/react-native-screens@4.26.2.patch'), 'utf8');
const screen = fs.readFileSync(path.resolve(__dirname, '../node_modules/react-native-screens/ios/RNSScreen.mm'), 'utf8');

test('native screens resolves the top content scroll view through nested layout wrappers', () => {
  for (const source of [patch, screen]) {
    expect(source).toContain('- (nullable UIScrollView *)contentScrollViewForEdge:(NSDirectionalRectEdge)edge');
    expect(source).toMatch(/if \(edge == NSDirectionalRectEdgeTop\)[\s\S]*firstDescendantScrollViewInView:self\.view/);
    expect(source).toContain('return [super contentScrollViewForEdge:edge];');
  }
});
