import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateRsaKeyPair, decryptRsaPayload } from './rsa.js';
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

export const AUTH_REDIRECT_DEEP_LINK = 'discourse://auth_redirect';
export const SCOPES = 'one_time_password';
export const APPLICATION_NAME = 'DSH Linux.do Plugin';

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
export function createAuthorizeContext(
  config: LinuxdoConfig,
  redirectUri: string,
): AuthorizeContext {
  const keys = generateRsaKeyPair();
  const nonce = randomUUID();
  const params = new URLSearchParams({
    application_name: APPLICATION_NAME,
    client_id: randomUUID(),
    scopes: SCOPES,
    public_key: keys.publicKeyPem,
    nonce,
    auth_redirect: redirectUri,
  });
  const authorizeUrl = `${config.baseUrl.replace(/\/+$/, '')}/user-api-key/new?${params.toString()}`;
  return {
    authorizeUrl,
    nonce,
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
  };
}

/**
 * 从用户粘贴内容中提取加密 payload。
 * 兼容三种输入：完整回调 URL、裸 query 串、纯 base64 payload。
 */
export function extractPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('输入为空');
  // 完整 URL 或 discourse:// 深链
  const match = /[?&]payload=([^&\s]+)/.exec(trimmed);
  if (match && match[1]) return decodeURIComponent(match[1]);
  // 裸 base64（可能带换行）
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return trimmed;
  throw new Error(
    '无法从输入中识别 payload。请粘贴浏览器地址栏中的完整回调 URL（含 ?payload=... 参数）',
  );
}

/** 解密并校验授权 payload。 */
export function decryptAuthorizePayload(
  privateKeyPem: string,
  encryptedPayload: string,
  expectedNonce: string,
): AuthorizePayload {
  const plain = decryptRsaPayload(privateKeyPem, encryptedPayload);
  const parsed = JSON.parse(plain) as AuthorizePayload;
  if (!parsed.key || typeof parsed.key !== 'string') {
    throw new Error('授权结果中缺少 API Key');
  }
  if (parsed.nonce && parsed.nonce !== expectedNonce) {
    throw new Error(`nonce 校验失败（期望 ${expectedNonce}，收到 ${parsed.nonce}），可能存在重放风险`);
  }
  return parsed;
}

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
export function startCallbackServer(config: LinuxdoConfig): Promise<CallbackServer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let payloadResolve: ((value: string) => void) | undefined;
    let payloadReject: ((err: Error) => void) | undefined;

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${config.callbackHost}`);
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      const payload = url.searchParams.get('payload') ?? '';
      const ok = payload.length > 0;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderCallbackPage(ok));
      if (ok) {
        payloadResolve?.(payload);
        payloadResolve = undefined;
        payloadReject = undefined;
      }
    });

    server.on('error', (err) => rejectPromise(err));
    server.listen(config.callbackPort, config.callbackHost, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.callbackPort;
      resolvePromise({
        url: `http://${config.callbackHost}:${port}`,
        port,
        waitForPayload: (timeoutMs, signal) =>
          new Promise<string>((res, rej) => {
            const timer = setTimeout(() => {
              payloadReject = undefined;
              rej(new Error(`等待授权回调超时（${Math.round(timeoutMs / 1000)} 秒）`));
            }, timeoutMs);
            payloadResolve = (value) => {
              clearTimeout(timer);
              res(value);
            };
            payloadReject = (err) => {
              clearTimeout(timer);
              rej(err);
            };
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                rej(new Error('已取消等待授权回调'));
              },
              { once: true },
            );
          }),
        close: () => server.close(),
      });
    });
  });
}

function renderCallbackPage(ok: boolean): string {
  const message = ok
    ? '授权成功！凭证已送达插件，本页面可以关闭，回到 DeepSeek Harness 继续使用。'
    : '回调缺少 payload 参数，请从授权页重新发起。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Linux.do 授权${ok ? '成功' : '异常'}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f7f9}
.card{background:#fff;padding:2.5rem 3rem;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:28rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}p{color:#555;line-height:1.6}</style></head>
<body><div class="card"><h1>${ok ? '授权成功' : '授权异常'}</h1><p>${message}</p></div></body></html>`;
}
