/** 插件错误基类。code 用于 Agent 侧结构化识别。 */
export class LinuxdoError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LinuxdoError';
    }
}
/** 未登录或会话失效：提示走 linuxdo_login 重新授权。 */
export class AuthRequiredError extends LinuxdoError {
    constructor(detail = '') {
        super('AUTH_REQUIRED', `Linux.do 登录态缺失或已失效${detail ? `（${detail}）` : ''}。` +
            `请调用 linuxdo_login 工具发起重新授权，引导用户在浏览器中完成登录并点击授权。`);
        this.name = 'AuthRequiredError';
    }
}
/** Cloudflare 挑战页：当前 HTTP 栈指纹被拦截。 */
export class ChallengeError extends LinuxdoError {
    constructor(status) {
        super('CF_CHALLENGE', `请求被 Cloudflare 拦截（HTTP ${status}）。` +
            `请稍后重试；若持续出现，说明站点收紧了 bot 防护，` +
            `可通过环境变量 LINUXDO_USER_AGENT 将 UA 设置为与你浏览器完全一致的值后重试。`);
        this.name = 'ChallengeError';
    }
}
/** 上游 API 返回非预期状态。 */
export class ApiError extends LinuxdoError {
    status;
    path;
    constructor(status, path, detail) {
        super('API_ERROR', `Discourse API ${path} 返回 HTTP ${status}${detail ? `：${detail}` : ''}`);
        this.status = status;
        this.path = path;
        this.name = 'ApiError';
    }
}
/** 判定响应体是否为 Cloudflare 挑战页。 */
export function looksLikeChallenge(body) {
    const markers = ['Just a moment', 'cf-browser-verification', 'challenge-platform', 'Attention Required'];
    return markers.some((m) => body.includes(m));
}
