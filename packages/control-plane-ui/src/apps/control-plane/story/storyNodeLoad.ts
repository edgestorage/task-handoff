import { nodeQueryLoadState, type NodeLoadState, type NodeQuerySnapshot } from "../shared/nodeQueryLoad.ts";

export type StoryNodeLoadState = NodeLoadState;

export type StoryNodeQuerySnapshot = NodeQuerySnapshot;

/** Story 目录与其它 Node 作用域目录共用同一套「按 Node 独立应答」的加载态判定。 */
export const storyNodeLoadState = nodeQueryLoadState;
