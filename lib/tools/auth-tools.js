import { defineTool } from '@deepseek-ai/dsh-tools';
import { completeLoginFromPayload, getPendingLogin, startLogin, } from '../auth/login-flow.js';
import { AuthRequiredError } from '../core/errors.js';
import { pruneUndefined, renderAsText } from './shared.js';
/** linuxdo_login：发起授权，返回授权 URL。 */
export function buildLoginTool(deps, config) {
    return defineTool({
        name: 'linuxdo_login',
        description: '发起 Linux.do 授权登录。返回一个授权 URL：请把它展示给用户，' +
            '引导用户在浏览器中打开并点击"授权"按钮。' +
            '自动模式下用户授权后插件会自动完成登录；' +
            '若 5 分钟后仍未完成，用 linuxdo_auth_status 查询状态或重新发起。',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(_args, exec) {
            const result = await startLogin(config);
            deps.log('info', `发起授权：mode=${result.mode}`);
            if (result.mode === 'auto') {
                return pruneUndefined({
                    mode: result.mode,
                    authorizeUrl: result.authorizeUrl,
                    instruction: '请把 authorizeUrl 展示给用户并在浏览器打开。用户点击授权后登录将自动完成，' +
                        `稍后可用 linuxdo_auth_status 确认。回调等待 ${result.expiresInSeconds} 秒。`,
                    expiresInSeconds: result.expiresInSeconds,
                });
            }
            return pruneUndefined({
                mode: result.mode,
                authorizeUrl: result.authorizeUrl,
                instruction: '本地回调端口不可用，已降级为手动模式。请让用户在浏览器打开 authorizeUrl 并授权；' +
                    '授权后浏览器会跳转到一个 discourse:// 开头无法打开的地址——' +
                    '让用户把地址栏完整 URL 复制下来，作为 callbackUrlOrPayload 参数调用 linuxdo_login_complete。',
                expiresInSeconds: result.expiresInSeconds,
            });
        },
    });
}
/** linuxdo_login_complete：手动粘贴回调 URL 完成兑换。 */
export function buildLoginCompleteTool(deps, client, config) {
    return defineTool({
        name: 'linuxdo_login_complete',
        description: '完成 Linux.do 手动授权：接收用户从浏览器地址栏复制的完整回调 URL' +
            '（discourse://auth_redirect?payload=... 形式）或其中的 payload 参数。',
        parameters: {
            callbackUrlOrPayload: {
                type: 'string',
                required: true,
                description: '完整回调 URL 或裸 payload 字符串',
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(args, exec) {
            const { callbackUrlOrPayload } = args;
            const result = await completeLoginFromPayload(client, config, callbackUrlOrPayload);
            return pruneUndefined(result);
        },
    });
}
/** linuxdo_auth_status：查询当前会话状态。 */
export function buildAuthStatusTool(deps, client) {
    return defineTool({
        name: 'linuxdo_auth_status',
        description: '查询 Linux.do 登录状态。检索类工具报 AUTH_REQUIRED 错误后，' +
            '先用本工具确认状态，再决定是否调用 linuxdo_login。',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(_args, exec) {
            const pending = getPendingLogin();
            const hasToken = client.hasSession();
            const stats = client.stats();
            if (!hasToken) {
                const invalidated = stats.sessionInvalidated;
                return pruneUndefined({
                    loggedIn: false,
                    pendingAuthorization: Boolean(pending),
                    hint: pending
                        ? '有进行中的授权会话。自动模式下等用户在浏览器完成授权；手动模式下用 linuxdo_login_complete 提交回调 URL。'
                        : invalidated
                            ? '登录态已失效（服务端返回 401/403）。请调用 linuxdo_login 发起重新授权。'
                            : '未登录。调用 linuxdo_login 发起授权。',
                });
            }
            // 有 token 时用轻量接口验证有效性
            try {
                const session = await client.getJson('/session/current.json', { cacheTtlMs: 0, signal: exec.signal });
                const username = session.current_user?.username;
                return pruneUndefined({
                    loggedIn: Boolean(username),
                    ...(username ? { username } : {}),
                    hint: username ? undefined : 'token 已失效，请调用 linuxdo_login 重新授权。',
                });
            }
            catch (err) {
                if (err instanceof AuthRequiredError) {
                    return pruneUndefined({
                        loggedIn: false,
                        pendingAuthorization: Boolean(pending),
                        hint: 'token 已失效，请调用 linuxdo_login 重新授权。',
                    });
                }
                throw err;
            }
        },
    });
}
