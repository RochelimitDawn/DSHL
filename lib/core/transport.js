/**
 * HTTP Transport 抽象与 Cloudflare 指纹降级链。
 *
 * FetchTransport：Node 原生 fetch（undici），默认通道。
 * CurlImpersonateTransport：经 curl-impersonate 子进程以 Chrome TLS 指纹发请求。
 *
 * 降级链策略：默认走 fetch；响应判定为 CF 挑战页且配置了 impersonate
 * 二进制时，自动切换并 sticky（后续请求全部走指纹通道，避免反复撞盾）。
 */
import { spawn } from 'node:child_process';
export class FetchTransport {
    fetchImpl;
    name = 'fetch';
    constructor(fetchImpl = fetch) {
        this.fetchImpl = fetchImpl;
    }
    async request(req) {
        const response = await this.fetchImpl(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            redirect: 'manual',
            signal: req.signal,
        });
        const text = await response.text();
        const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
        return { status: response.status, text, setCookies };
    }
}
/**
 * 构造 curl-impersonate 命令行参数（纯函数，便于测试）。
 * -D - 把响应头 dump 到 stdout，与 body 一起输出后统一解析。
 */
export function buildCurlArgs(binary, req) {
    const args = ['--silent', '--max-time', '30', '--compressed', '-X', req.method];
    for (const [key, value] of Object.entries(req.headers)) {
        args.push('-H', `${key}: ${value}`);
    }
    if (req.body) {
        args.push('--data-raw', req.body);
    }
    args.push('-D', '-', req.url);
    void binary;
    return args;
}
/** 从 curl -D - 的原始输出中拆出状态行、头集合与 body。 */
export function parseCurlOutput(raw) {
    const separator = /\r?\n\r?\n/;
    const match = separator.exec(raw);
    const headerBlock = match ? raw.slice(0, match.index) : raw;
    const body = match ? raw.slice(match.index + match[0].length) : '';
    const lines = headerBlock.split(/\r?\n/);
    let status = 0;
    const headers = {};
    for (const line of lines) {
        const statusMatch = /^HTTP\/[\d.]+\s+(\d+)/i.exec(line);
        if (statusMatch && statusMatch[1]) {
            status = Number(statusMatch[1]);
            continue;
        }
        const colon = line.indexOf(':');
        if (colon > 0) {
            const key = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            (headers[key] ??= []).push(value);
        }
    }
    return { status, headers, body };
}
export class CurlImpersonateTransport {
    binaryPath;
    name = 'curl-impersonate';
    constructor(binaryPath) {
        this.binaryPath = binaryPath;
    }
    async request(req) {
        const args = buildCurlArgs(this.binaryPath, req);
        return new Promise((resolve, reject) => {
            const child = spawn(this.binaryPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                child.kill('SIGKILL');
                reject(new Error('Aborted'));
            };
            req.signal?.addEventListener('abort', onAbort, { once: true });
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
            });
            child.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                reject(new Error(`curl-impersonate 启动失败（${this.binaryPath}）：${err.message}`));
            });
            child.on('close', () => {
                if (settled)
                    return;
                settled = true;
                req.signal?.removeEventListener('abort', onAbort);
                try {
                    const { status, headers } = parseCurlOutput(stdout);
                    resolve({
                        status,
                        text: stdoutBody(stdout),
                        setCookies: headers['set-cookie'] ?? [],
                    });
                }
                catch (err) {
                    reject(new Error(`curl-impersonate 输出解析失败：${err instanceof Error ? err.message : String(err)}；stderr=${stderr.slice(0, 200)}`));
                }
            });
        });
    }
}
/** curl -D - 输出中定位 body 起点（首个空行之后）。 */
function stdoutBody(raw) {
    const separator = /\r?\n\r?\n/;
    const match = separator.exec(raw);
    return match ? raw.slice(match.index + match[0].length) : '';
}
