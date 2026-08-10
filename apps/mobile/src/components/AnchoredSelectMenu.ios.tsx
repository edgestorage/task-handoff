import { useState } from 'react';
import { Button, Divider, Host, HStack, Image, Popover, RNHostView, ScrollView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, font, foregroundStyle, frame, lineLimit, padding } from '@expo/ui/swift-ui/modifiers';

import {
  ANCHORED_SELECT_MENU_CONTENT_WIDTH,
  ANCHORED_SELECT_MENU_HORIZONTAL_PADDING,
  ANCHORED_SELECT_MENU_WIDTH,
} from './anchored-select-menu-layout';
import type { AnchoredSelectMenuProps } from './anchored-select-menu-types';
import { useMobileTheme } from './theme';

export type { AnchoredSelectOption } from './anchored-select-menu-types';

export function AnchoredSelectMenu<Value extends string>(props: AnchoredSelectMenuProps<Value>) {
  const { colors, dark } = useMobileTheme();
  const [presented, setPresented] = useState(false);
  const open = props.disabled || props.options.length === 0 ? undefined : () => setPresented(true);
  const select = (value: Value) => {
    setPresented(false);
    props.onSelect(value);
  };

  return <Host colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" matchContents seedColor={colors.primary}>
    <Popover isPresented={presented} onIsPresentedChange={setPresented}>
      <Popover.Trigger><RNHostView matchContents>{props.children(open)}</RNHostView></Popover.Trigger>
      <Popover.Content>
        <VStack alignment="leading" spacing={0} modifiers={[frame({ width: ANCHORED_SELECT_MENU_WIDTH }), padding({ vertical: 8 })]}>
          <Text modifiers={[font({ textStyle: 'headline' }), frame({ width: ANCHORED_SELECT_MENU_CONTENT_WIDTH, alignment: 'leading' }), padding({ horizontal: ANCHORED_SELECT_MENU_HORIZONTAL_PADDING, vertical: 8 })]}>{props.title}</Text>
          <Divider />
          <ScrollView modifiers={[frame({ maxHeight: 420 })]} showsIndicators>
            <VStack alignment="leading" spacing={0}>
              {props.options.map((option) => <Button
                key={option.value}
                modifiers={[buttonStyle('plain')]}
                onPress={() => select(option.value)}
                role={option.danger ? 'destructive' : 'default'}
              >
                <HStack alignment="center" spacing={10} modifiers={[frame({ width: ANCHORED_SELECT_MENU_CONTENT_WIDTH, alignment: 'leading' }), padding({ horizontal: ANCHORED_SELECT_MENU_HORIZONTAL_PADDING, vertical: 10 })]}>
                  {option.systemImage ? <Image color={option.danger ? colors.error : colors.textMuted} size={18} systemName={option.systemImage} /> : null}
                  <VStack alignment="leading" spacing={2}>
                    <Text modifiers={[font({ textStyle: 'body', weight: 'medium' }), foregroundStyle(option.danger ? colors.error : 'primary'), lineLimit(1)]}>{option.label}</Text>
                    {option.description ? <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(2)]}>{option.description}</Text> : null}
                  </VStack>
                  <Spacer />
                  {option.value === props.selectedValue ? <Image color={colors.primary} size={15} systemName="checkmark" /> : null}
                </HStack>
              </Button>)}
            </VStack>
          </ScrollView>
        </VStack>
      </Popover.Content>
    </Popover>
  </Host>;
}
