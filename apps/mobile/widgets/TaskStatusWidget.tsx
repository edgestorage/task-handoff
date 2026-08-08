import { HStack, Image, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

import type { TaskStatusProps } from '../src/task-status/model';

const TaskStatusWidget = (props: TaskStatusProps, environment: WidgetEnvironment) => {
  'widget';
  const accent = props.status === 'problem'
    ? '#FF453A'
    : props.status === 'waiting'
      ? '#FF9F0A'
      : props.status === 'active'
        ? '#64D2FF'
        : '#8E8E93';
  const symbol = props.status === 'problem'
    ? 'exclamationmark.triangle.fill'
    : props.status === 'waiting'
      ? 'hand.raised.fill'
      : props.status === 'active'
        ? 'sparkles'
        : 'checkmark.circle.fill';
  const compact = environment.widgetFamily === 'systemSmall';

  return (
    <ZStack modifiers={[containerBackground('#111318', 'widget'), clipShape('containerRelativeShape')]}>
      <VStack
        alignment="leading"
        spacing={8}
        modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'leading' }), padding({ all: 14 })]}
      >
        <HStack spacing={7}>
          <Image systemName={symbol} size={15} color={accent} />
          <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(accent), lineLimit(1)]}>
            {props.statusLabel}
          </Text>
          <Spacer />
        </HStack>
        <Spacer />
        <Text modifiers={[font({ weight: 'bold', size: compact ? 17 : 19 }), foregroundStyle('#FFFFFF'), lineLimit(compact ? 3 : 2)]}>
          {props.title}
        </Text>
        <Text modifiers={[font({ size: 12 }), foregroundStyle('#FFFFFF99'), lineLimit(1)]}>
          {props.detail}
        </Text>
        <HStack spacing={10}>
          <Text modifiers={[font({ weight: 'medium', size: 11 }), foregroundStyle('#64D2FF')]}>▶ {props.activeCount}</Text>
          <Text modifiers={[font({ weight: 'medium', size: 11 }), foregroundStyle('#FF9F0A')]}>◷ {props.waitingCount}</Text>
          {!compact && props.problemCount > 0 ? (
            <Text modifiers={[font({ weight: 'medium', size: 11 }), foregroundStyle('#FF453A')]}>! {props.problemCount}</Text>
          ) : null}
        </HStack>
      </VStack>
    </ZStack>
  );
};

export default createWidget<TaskStatusProps>('TaskStatusWidget', TaskStatusWidget);
