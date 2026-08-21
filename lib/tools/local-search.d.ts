import { type ToolDeps } from './shared.js';
import type { LocalIndex } from '../core/local-index.js';
/**
 * linuxdo_search_local：本地知识库检索。
 * 查询读过的话题内容，零站内请求、离线可用。
 */
export declare function buildLocalSearchTool(deps: ToolDeps, localIndex: LocalIndex): import("@deepseek-ai/dsh-tools").ToolDefinition;
