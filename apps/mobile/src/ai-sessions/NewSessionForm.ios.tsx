import { Button, Form, Host, Label, Picker, Section, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, foregroundStyle, frame, keyboardType, lineLimit, listSectionSpacing, pickerStyle, submitLabel, tag, textInputAutocapitalization, tint } from '@expo/ui/swift-ui/modifiers';
import { SafeAreaView } from 'react-native-screens/experimental';

import { useMobileTheme } from '../components/theme';
import type { NewSessionFormProps } from './new-session-types';

export function NewSessionForm(props: NewSessionFormProps) {
  const { colors, dark } = useMobileTheme();
  const cwd = useNativeState(props.cwd);
  const message = useNativeState(props.message);

  return (
    <SafeAreaView edges={{ bottom: true }} style={{ flex: 1 }}>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }} useViewportSizeMeasurement>
        <Form modifiers={[listSectionSpacing('compact'), tint(colors.primary)]}>
          <Section title="SESSION">
            {props.instances.length ? (
              <Picker label="Instance" onSelectionChange={props.onInstanceChange} selection={props.selectedInstanceId} systemImage="server.rack" modifiers={[pickerStyle('menu')]}> 
                {props.instances.map((instance) => <Text key={instance.id} modifiers={[tag(instance.id)]}>{instance.name}</Text>)}
              </Picker>
            ) : <Label title="No instances available" systemImage="exclamationmark.triangle" modifiers={[foregroundStyle('secondary')]} />}
            {props.selectedInstance?.availableAgents.length ? (
              <Picker label="Agent" onSelectionChange={props.onAgentChange} selection={props.selectedAgent} systemImage="sparkles" modifiers={[pickerStyle('menu')]}> 
                {props.selectedInstance.availableAgents.map((agent) => <Text key={agent.id} modifiers={[tag(agent.id)]}>{agent.name}</Text>)}
              </Picker>
            ) : <Label title="No AI agents available" systemImage="exclamationmark.triangle" modifiers={[foregroundStyle('secondary')]} />}
            <Picker label="Permission" onSelectionChange={(value) => props.onPermissionModeChange(value as NewSessionFormProps['permissionMode'])} selection={props.permissionMode} systemImage="hand.raised" modifiers={[pickerStyle('menu')]}> 
              <Text modifiers={[tag('ask')]}>Ask before changes</Text>
              <Text modifiers={[tag('auto-review')]}>Auto review</Text>
              <Text modifiers={[tag('full-access')]}>Full access</Text>
            </Picker>
            <TextField onTextChange={props.onCwdChange} placeholder="Working directory" text={cwd} modifiers={[keyboardType('ascii-capable'), textInputAutocapitalization('never'), submitLabel('next')]} />
          </Section>

          <Section title="PROMPT">
            <TextField axis="vertical" onTextChange={props.onMessageChange} placeholder="Describe what you want to do" text={message} modifiers={[lineLimit({ min: 6, max: 12 }), submitLabel('send')]} />
            <Button label={props.busy ? 'Creating…' : 'Create Session'} onPress={props.onCreate} systemImage={props.busy ? 'hourglass' : 'arrow.up.circle.fill'} modifiers={[buttonStyle('borderedProminent'), controlSize('large'), disabled(props.disabled), frame({ maxWidth: Infinity })]} />
          </Section>

          {props.error ? <Section><Label title={props.error} systemImage="exclamationmark.triangle.fill" modifiers={[foregroundStyle(colors.error)]} /></Section> : null}
        </Form>
      </Host>
    </SafeAreaView>
  );
}
