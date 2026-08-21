import { createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, constants as cryptoConstants, } from 'node:crypto';
export function generateRsaKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}
/** 清理 Ruby 风格 Base64（60 字符换行 + URL 传输引入的空白）。 */
export function normalizeBase64(input) {
    return input.replace(/\s+/g, '');
}
/** 用私钥解密服务端回传的 Base64(RSA-PKCS1(data))，返回 UTF-8 明文。 */
export function decryptRsaPayload(privateKeyPem, base64Payload) {
    const key = createPrivateKey(privateKeyPem);
    const cipher = Buffer.from(normalizeBase64(base64Payload), 'base64');
    const plain = privateDecrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, cipher);
    return plain.toString('utf8');
}
/** 测试辅助：用对应公钥加密明文（模拟服务端行为）。 */
export function encryptRsaPayload(publicKeyPem, plaintext) {
    const key = createPublicKey(publicKeyPem);
    return publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(plaintext, 'utf8')).toString('base64');
}
