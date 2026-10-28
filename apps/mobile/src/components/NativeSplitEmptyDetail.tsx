import { EmbeddedPaneHeaderOptions } from './EmbeddedPaneHeader';
import { MasterDetailEmptyState } from './MasterDetailLayout';
import type { IconName } from './Icon';

/** Empty native split detail with no stale action inherited from the previous selection. */
export function NativeSplitEmptyDetail({ icon, message, testID, title }: {
  icon: IconName;
  message: string;
  testID?: string;
  title: string;
}) {
  return <>
    <EmbeddedPaneHeaderOptions enabled title={title} />
    <MasterDetailEmptyState icon={icon} message={message} testID={testID} />
  </>;
}
