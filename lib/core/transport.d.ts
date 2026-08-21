export interface TransportResponse {
    status: number;
    text: string;
    setCookies: string[];
}
export interface TransportRequest {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    /** 已编码的 form body（POST 时） */
    body?: string;
    signal?: AbortSignal;
}
export interface Transport {
    readonly name: string;
    request(req: TransportRequest): Promise<TransportResponse>;
}
export declare class FetchTransport implements Transport {
    private readonly fetchImpl;
    readonly name = "fetch";
    constructor(fetchImpl?: typeof fetch);
    request(req: TransportRequest): Promise<TransportResponse>;
}
/**
 * 构造 curl-impersonate 命令行参数（纯函数，便于测试）。
 * -D - 把响应头 dump 到 stdout，与 body 一起输出后统一解析。
 */
export declare function buildCurlArgs(binary: string, req: TransportRequest): string[];
/** 从 curl -D - 的原始输出中拆出状态行、头集合与 body。 */
export declare function parseCurlOutput(raw: string): {
    status: number;
    headers: Record<string, string[]>;
    body: string;
};
export declare class CurlImpersonateTransport implements Transport {
    private readonly binaryPath;
    readonly name = "curl-impersonate";
    constructor(binaryPath: string);
    request(req: TransportRequest): Promise<TransportResponse>;
}
