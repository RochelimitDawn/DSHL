/** 插件错误基类。code 用于 Agent 侧结构化识别。 */
export declare class LinuxdoError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 未登录或会话失效：提示走 linuxdo_login 重新授权。 */
export declare class AuthRequiredError extends LinuxdoError {
    constructor(detail?: string);
}
/** Cloudflare 挑战页：当前 HTTP 栈指纹被拦截。 */
export declare class ChallengeError extends LinuxdoError {
    constructor(status: number);
}
/** 上游 API 返回非预期状态。 */
export declare class ApiError extends LinuxdoError {
    readonly status: number;
    readonly path: string;
    constructor(status: number, path: string, detail?: string);
}
/** 判定响应体是否为 Cloudflare 挑战页。 */
export declare function looksLikeChallenge(body: string): boolean;
