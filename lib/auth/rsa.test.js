import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptRsaPayload, encryptRsaPayload, generateRsaKeyPair, normalizeBase64, } from './rsa.js';
test('RSA roundtrip：公钥加密 → 私钥解密', () => {
    const { publicKeyPem, privateKeyPem } = generateRsaKeyPair();
    const plaintext = JSON.stringify({ key: 'test-key-123', nonce: 'abc' });
    const encrypted = encryptRsaPayload(publicKeyPem, plaintext);
    const decrypted = decryptRsaPayload(privateKeyPem, encrypted);
    assert.equal(decrypted, plaintext);
});
test('RSA 解密兼容 Ruby Base64 每 60 字符换行格式', () => {
    const { publicKeyPem, privateKeyPem } = generateRsaKeyPair();
    // PKCS1 v1.5 单块明文上限 = keySize/8 - 11 = 245 字节
    const plaintext = 'x'.repeat(200);
    const encrypted = encryptRsaPayload(publicKeyPem, plaintext);
    // 模拟 Ruby Base64.encode64：每 60 字符插入换行，末尾补换行
    const rubyStyle = (encrypted.match(/.{1,60}/g) ?? []).join('\n') + '\n';
    // 再混入 URL 传输可能引入的空格
    const messy = rubyStyle.replace(/\n/g, ' \n ');
    assert.equal(decryptRsaPayload(privateKeyPem, messy), plaintext);
});
test('normalizeBase64 清理全部空白字符', () => {
    assert.equal(normalizeBase64('ab\ncd  ef\n'), 'abcdef');
    assert.equal(normalizeBase64(''), '');
});
test('错误密钥解密得到的是乱码（OpenSSL 防 Bleichenbacher 行为），与原文不符', () => {
    const a = generateRsaKeyPair();
    const b = generateRsaKeyPair();
    const plaintext = JSON.stringify({ key: 'secret-key', nonce: 'n-1' });
    const encrypted = encryptRsaPayload(a.publicKeyPem, plaintext);
    let decrypted;
    try {
        decrypted = decryptRsaPayload(b.privateKeyPem, encrypted);
    }
    catch {
        // 部分环境会直接抛错，同样视为安全失败
    }
    assert.notEqual(decrypted, plaintext);
});
test('SPKI PEM 公钥格式正确', () => {
    const { publicKeyPem } = generateRsaKeyPair();
    assert.match(publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
    assert.match(publicKeyPem, /-----END PUBLIC KEY-----\s*$/);
});
