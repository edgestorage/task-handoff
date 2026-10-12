import type { MenuAction } from '@expo/ui/community/menu';
import { androidSymbolForSfSymbol } from './menu-icons';
import type { FloatingMenuBlock, FloatingMenuItem, FloatingMenuPage } from './menu-model';

/** `@react-native-menu/menu` (and the iOS screen builders) attach a subtitle to actions. */
type MenuActionWithSubtitle = MenuAction & { subtitle?: string };

function actionId(action: MenuAction) {
  return action.id ?? action.title;
}

function itemFromAction(
  action: MenuActionWithSubtitle,
  select: (action: MenuAction) => void,
  extra?: Pick<FloatingMenuItem, 'submenu'>,
): FloatingMenuItem {
  const { image } = action;
  return {
    disabled: action.attributes?.disabled,
    destructive: action.attributes?.destructive,
    icon: androidSymbolForSfSymbol(typeof image === 'string' ? image : undefined),
    iconColor: typeof action.imageColor === 'string' ? action.imageColor : undefined,
    iconSource: typeof image === 'string' || image === undefined ? undefined : image,
    key: actionId(action),
    label: action.title,
    onPress: () => select(action),
    selected: action.state === 'on',
    subtitle: action.subtitle,
    ...extra,
  };
}

function pushActions(actions: MenuAction[], blocks: FloatingMenuBlock[], select: (action: MenuAction) => void) {
  for (const action of actions) {
    if (action.attributes?.hidden) continue;
    const subactions = action.subactions?.filter((sub) => !sub.attributes?.hidden) ?? [];
    if (!subactions.length) {
      blocks.push({ item: itemFromAction(action, select), key: actionId(action), type: 'item' });
      continue;
    }
    if (action.displayInline) {
      if (action.title.trim()) blocks.push({ key: `section:${actionId(action)}`, label: action.title, type: 'section' });
      pushActions(subactions, blocks, select);
      continue;
    }
    // The nested page's back row already shows the action title, so only set the page
    // title instead of adding a second title block inside the page.
    const submenu: FloatingMenuPage = { blocks: menuPageFromActions(subactions, undefined, select).blocks, title: action.title };
    blocks.push({ item: itemFromAction(action, select, { submenu }), key: actionId(action), type: 'item' });
  }
}

/**
 * Flattens the `@react-native-menu/menu` action tree into the floating menu model:
 * inline submenus become group labels, other submenus become nested pages.
 */
export function menuPageFromActions(actions: MenuAction[], title?: string, select: (action: MenuAction) => void = () => {}): FloatingMenuPage {
  const blocks: FloatingMenuBlock[] = [];
  if (title) blocks.push({ key: 'title', label: title, type: 'title' });
  pushActions(actions, blocks, select);
  return { blocks, title };
}
