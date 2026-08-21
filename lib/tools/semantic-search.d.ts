import { type ToolDeps } from './shared.js';
/**
 * linuxdo_semantic_search：站方 discourse-ai embeddings 提供的语义搜索。
 * 返回结构与标准搜索一致（GroupedSearchResultSerializer）。
 * 这是本插件相对普通爬取方案的差异化能力：向量由站方维护，天然覆盖全站内容。
 */
export declare function buildSemanticSearchTool(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
