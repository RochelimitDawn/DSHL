import { type ToolDeps } from './shared.js';
import { ApiError, AuthRequiredError, ChallengeError } from '../core/errors.js';
export declare function loadCategoryNames(deps: ToolDeps, signal?: AbortSignal): Promise<Map<number, string>>;
export declare function buildSearchTool(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** 供测试与状态查询复用的错误再导出。 */
export { ApiError, AuthRequiredError, ChallengeError };
