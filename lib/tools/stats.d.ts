import { type ToolDeps } from './shared.js';
import type { DiscourseClient } from '../core/client.js';
import type { LocalIndex } from '../core/local-index.js';
export interface StatsSources {
    clients: Array<{
        name: string;
        client: DiscourseClient;
    }>;
    localIndex: LocalIndex | undefined;
}
/**
 * linuxdo_stats：请求预算自观测。
 * Agent 在长任务中可据此自主决定节流或改用本地索引。
 */
export declare function buildStatsTool(deps: ToolDeps, sources: StatsSources): import("@deepseek-ai/dsh-tools").ToolDefinition;
