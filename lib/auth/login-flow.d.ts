import { type AuthorizeContext, type CallbackServer } from './authorize.js';
import type { DiscourseClient } from '../core/client.js';
import type { LinuxdoConfig } from '../config.js';
/**
 * 登录流程编排。
 *
 * 对 Agent 暴露为三个工具协作的无状态步骤：
 * - linuxdo_login        发起授权：返回授权 URL 并启动本地回调等待
 * - linuxdo_login_complete 手动路径：粘贴回调 URL 完成兑换
 * - linuxdo_auth_status  查询会话状态
 */
export interface LoginStartResult {
    authorizeUrl: string;
    /** auto = 本地回调已就绪，授权后自动完成；manual = 需要用户粘贴回调 URL */
    mode: 'auto' | 'manual';
    callbackUrl?: string;
    expiresInSeconds: number;
}
export interface LoginCompleteResult {
    username?: string;
    message: string;
}
interface PendingLogin {
    context: AuthorizeContext;
    server?: CallbackServer;
    startedAt: number;
}
export declare function getPendingLogin(): PendingLogin | undefined;
/** 测试辅助：强制清理进行中的授权会话与回调 server。 */
export declare function resetLoginFlowForTest(): void;
/**
 * 步骤一：发起授权。
 *
 * 先尝试本地回调模式（全自动）；回调端口不可用时降级为深链 + 手动粘贴模式。
 */
export declare function startLogin(config: LinuxdoConfig): Promise<LoginStartResult>;
/**
 * 步骤二：完成兑换。接受加密 payload 或完整回调 URL。
 * 自动模式下由回调 server 触发同一实现。
 */
export declare function completeLoginFromPayload(client: DiscourseClient, config: LinuxdoConfig, rawInput: string): Promise<LoginCompleteResult>;
/** 回调 server 收到 payload 后的内部入口。 */
export declare function completeLoginFromCallback(client: DiscourseClient, config: LinuxdoConfig, encryptedPayload: string): Promise<LoginCompleteResult>;
/**
 * OTP 兑换登录态：
 * POST /user-api-key/otp（User-Api-Key 头豁免 CSRF）→ RSA 解密得 OTP
 * POST /session/otp/{otp} → Set-Cookie _t
 */
export declare function exchangeOtpForSession(client: DiscourseClient, config: LinuxdoConfig, apiKey: string): Promise<{
    tToken: string;
    username?: string;
}>;
export {};
