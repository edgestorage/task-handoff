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
import { createLiveActivity } from 'expo-widgets';

import type { TaskStatusProps } from '../src/task-status/model';

const TaskStatusActivity = (props: TaskStatusProps) => {
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
  const CountSummary = () => (
    <HStack spacing={8}>
      <Text modifiers={[font({ weight: 'medium', size: 11 }), foregroundStyle('#64D2FF')]}>▶ {props.activeCount}</Text>
      <Text modifiers={[font({ weight: 'medium', size: 11 }), foregroundStyle('#FF9F0A')]}>◷ {props.waitingCount}</Text>
    </HStack>
  );

  return {
    banner: (
      <ZStack modifiers={[containerBackground('#111318', 'widget'), clipShape('containerRelativeShape')]}>
        <VStack alignment="leading" spacing={7} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ all: 14 })]}>
          <HStack spacing={7}>
            <Image systemName={symbol} size={15} color={accent} />
            <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(accent)]}>{props.statusLabel}</Text>
            <Spacer />
            <CountSummary />
          </HStack>
          <Text modifiers={[font({ weight: 'medium', size: 12 }), foregroundStyle('#FFFFFF99'), lineLimit(1)]}>{props.title} · {props.detail}</Text>
          <Text modifiers={[font({ weight: 'bold', size: 16 }), foregroundStyle('#FFFFFF'), lineLimit(2)]}>{props.message}</Text>
        </VStack>
      </ZStack>
    ),
    bannerSmall: (
      <HStack spacing={8} modifiers={[padding({ all: 10 })]}>
        <Image systemName={symbol} size={15} color={accent} />
        <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
          <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(accent), lineLimit(1)]}>{props.statusLabel}</Text>
          <Text modifiers={[font({ weight: 'medium', size: 13 }), foregroundStyle('#FFFFFF'), lineLimit(1)]}>{props.message}</Text>
        </VStack>
      </HStack>
    ),
    compactLeading: <Image systemName={symbol} size={14} color={accent} />,
    compactTrailing: <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(accent)]}>{props.activeCount + props.waitingCount}</Text>,
    minimal: <Image systemName={symbol} size={14} color={accent} />,
    expandedLeading: (
      <HStack spacing={6} modifiers={[padding({ leading: 6 })]}>
        <Image systemName={symbol} size={15} color={accent} />
        <Text modifiers={[font({ weight: 'semibold', size: 13 }), foregroundStyle(accent)]}>{props.statusLabel}</Text>
      </HStack>
    ),
    expandedTrailing: <HStack modifiers={[padding({ trailing: 6 })]}><CountSummary /></HStack>,
    expandedBottom: (
      <VStack alignment="leading" spacing={3} modifiers={[padding({ top: 5, horizontal: 6 })]}>
        <Text modifiers={[font({ size: 12 }), foregroundStyle('#FFFFFF99'), lineLimit(1)]}>{props.title} · {props.detail}</Text>
        <Text modifiers={[font({ weight: 'bold', size: 15 }), foregroundStyle('#FFFFFF'), lineLimit(2)]}>{props.message}</Text>
      </VStack>
    ),
  };
};

export default createLiveActivity<TaskStatusProps>('TaskStatusActivity', TaskStatusActivity);
