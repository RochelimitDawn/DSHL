import { type ToolDeps } from './shared.js';
import { TopicCursorStore } from '../core/topic-cursor-store.js';
import { LocalIndex } from '../core/local-index.js';
export interface GetTopicExtras {
    cursors: TopicCursorStore;
    localIndex: LocalIndex | undefined;
}
/**
 * linuxdo_get_topic：读取话题内容。
 *
 * token 控制四件套：
 * 1. cooked HTML 清洗为纯文本（引用自动折叠）
 * 2. 楼层窗口分页（fromPostNumber + maxPosts）
 * 3. maxChars 硬上限截断 + nextFromPostNumber 续读游标
 * 4. mode=incremental 增量模式：只返回上次读取后的新楼
 *
 * 每次成功读取都会沉淀到本地 FTS5 知识库（启用时）。
 */
export declare function buildGetTopicTool(deps: ToolDeps, extras: GetTopicExtras): import("@deepseek-ai/dsh-tools").ToolDefinition;
