import { type ToolDeps } from './shared.js';
export type BrowseStream = 'latest' | 'top' | 'hot' | 'new';
/**
 * linuxdo_browse：浏览话题流。
 * 覆盖"今天站内有什么热点"这类逛站场景，与搜索互补。
 */
export declare function buildBrowseTool(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
