import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
const FILE_MODE = 0o600;
export class SessionStore {
    filePath;
    constructor(filePath) {
        this.filePath =
            filePath && filePath.trim() !== ''
                ? resolve(filePath)
                : resolve(homedir(), '.dsh-plugin-linuxdo', 'session.json');
    }
    load() {
        if (!existsSync(this.filePath))
            return {};
        try {
            const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
            return {
                tToken: typeof raw.tToken === 'string' ? raw.tToken : undefined,
                username: typeof raw.username === 'string' ? raw.username : undefined,
                savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : undefined,
            };
        }
        catch {
            return {};
        }
    }
    save(state) {
        const dir = dirname(this.filePath);
        mkdirSync(dir, { recursive: true });
        const payload = { ...state, savedAt: new Date().toISOString() };
        writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
        try {
            chmodSync(this.filePath, FILE_MODE);
        }
        catch {
            // Windows 上 chmod 语义受限，忽略
        }
    }
    clear() {
        if (existsSync(this.filePath)) {
            writeFileSync(this.filePath, JSON.stringify({}, null, 2), { mode: FILE_MODE });
        }
    }
}
