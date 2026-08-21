import { completeLoginFromCallback, completeLoginFromPayload, startLogin } from '../auth/login-flow.js';
import { type ToolDeps } from './shared.js';
/** linuxdo_login：发起授权，返回授权 URL。 */
export declare function buildLoginTool(deps: ToolDeps, config: Parameters<typeof startLogin>[0]): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** linuxdo_login_complete：手动粘贴回调 URL 完成兑换。 */
export declare function buildLoginCompleteTool(deps: ToolDeps, client: Parameters<typeof completeLoginFromPayload>[0], config: Parameters<typeof completeLoginFromPayload>[1]): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** linuxdo_auth_status：查询当前会话状态。 */
export declare function buildAuthStatusTool(deps: ToolDeps, client: Parameters<typeof completeLoginFromCallback>[0]): import("@deepseek-ai/dsh-tools").ToolDefinition;
