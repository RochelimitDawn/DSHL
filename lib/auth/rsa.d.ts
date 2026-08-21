/**
 * RSA 密钥对与 payload 解密。
 *
 * 对齐 Discourse user_api_keys_controller 的约定：
 * - 客户端生成 RSA-2048 密钥对，SPKI PEM 公钥随授权请求上送
 * - 服务端以 RSA PKCS#1 v1.5 加密回传 payload
 * - Ruby Base64.encode64 每 60 字符插入换行，URL 传输还可能引入空格，解密前需清理
 */
export interface RsaKeyPair {
    publicKeyPem: string;
    privateKeyPem: string;
}
export declare function generateRsaKeyPair(): RsaKeyPair;
/** 清理 Ruby 风格 Base64（60 字符换行 + URL 传输引入的空白）。 */
export declare function normalizeBase64(input: string): string;
/** 用私钥解密服务端回传的 Base64(RSA-PKCS1(data))，返回 UTF-8 明文。 */
export declare function decryptRsaPayload(privateKeyPem: string, base64Payload: string): string;
/** 测试辅助：用对应公钥加密明文（模拟服务端行为）。 */
export declare function encryptRsaPayload(publicKeyPem: string, plaintext: string): string;
