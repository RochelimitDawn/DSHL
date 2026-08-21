import type { LinuxdoConfig } from '../config.js';
/**
 * Discourse User API Key 授权流程。
 *
 * 链路（与 FluxDO 客户端同源，均为 DiscourseHub 标准流程）：
 * 1. 插件生成 RSA 密钥对 + nonce，构造 /user-api-key/new 授权 URL
 * 2. 用户在自己浏览器打开该 URL（登录态、CF、2FA 全部天然通过）
 * 3. 授权后服务端 302 到 auth_redirect，携带 RSA 加密的 payload
 *    - 主路径：auth_redirect 指向插件本地回调 http://127.0.0.1:{port}/callback，
 *      浏览器直接回连，全自动（依赖站方 allowed_user_api_auth_redirects 白名单）
 *    - 降级路径：auth_redirect 为 discourse://auth_redirect，用户复制
 *      地址栏完整 URL 粘贴回来
 * 4. 插件解密 payload 得到 key（one_time_password scope），校验 nonce
 * 5. POST /user-api-key/otp（User-Api-Key 头豁免 CSRF）→ 解密得一次性 OTP
 * 6. POST /session/otp/{otp} → 响应 Set-Cookie _t → 插件持有登录态
 */
export declare const AUTH_REDIRECT_DEEP_LINK = "discourse://auth_redirect";
export declare const SCOPES = "one_time_password";
export declare const APPLICATION_NAME = "DSH Linux.do Plugin";
/** 授权 payload 解密后的结构。 */
export interface AuthorizePayload {
    key: string;
    nonce?: string;
    push?: boolean;
    api?: number;
}
export interface AuthorizeContext {
    authorizeUrl: string;
    nonce: string;
    privateKeyPem: string;
    publicKeyPem: string;
}
/** 构造授权上下文：密钥对、nonce 与完整授权 URL。 */
export declare function createAuthorizeContext(config: LinuxdoConfig, redirectUri: string): AuthorizeContext;
/**
 * 从用户粘贴内容中提取加密 payload。
 * 兼容三种输入：完整回调 URL、裸 query 串、纯 base64 payload。
 */
export declare function extractPayload(raw: string): string;
/** 解密并校验授权 payload。 */
export declare function decryptAuthorizePayload(privateKeyPem: string, encryptedPayload: string, expectedNonce: string): AuthorizePayload;
export interface CallbackServer {
    /** 本地回调根地址，如 http://127.0.0.1:54321 */
    readonly url: string;
    /** 实际监听端口 */
    readonly port: number;
    /** 等待一次回调，resolve 收到的加密 payload */
    waitForPayload(timeoutMs: number, signal?: AbortSignal): Promise<string>;
    close(): void;
}
/**
 * 启动本地 HTTP 回调 server，等待站方授权后浏览器的自动回连。
 * 接到 /callback?payload=... 后立即响应一个对用户友好的 HTML 页面。
 */
export declare function startCallbackServer(config: LinuxdoConfig): Promise<CallbackServer>;
