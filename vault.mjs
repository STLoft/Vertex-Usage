// Credential keys are non-extractable CryptoKeys, never raw JSON in ST settings.
export class BrowserVault {
    constructor(scope) { this.name = `st-vertex-usage-v3:${scope}`; this.memory = new Map(); this.db = null; }
    async open() {
        if (!globalThis.indexedDB) return false;
        try {
            this.db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(this.name, 2);
                request.onupgradeneeded = () => {
                    for (const [name, keyPath] of [['accounts', 'id'], ['snapshots', 'projectId'], ['observations', 'id']]) {
                        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error('Browser storage is busy'));
            });
            return true;
        } catch { this.db = null; return false; }
    }
    async transaction(store, mode, operation) {
        if (!this.db) throw new Error('브라우저 저장소를 사용할 수 없습니다. 현재 탭에서만 인증을 유지할 수 있습니다.');
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(store, mode);
            let request;
            try { request = operation(tx.objectStore(store)); }
            catch (error) { tx.abort(); reject(error); return; }
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(new Error('브라우저 저장에 실패했습니다. 인증 기억을 끄고 다시 등록할 수 있습니다.'));
            tx.onabort = () => reject(new Error('브라우저 저장을 완료하지 못했습니다.'));
        });
    }
    async list() {
        let persisted = [];
        if (this.db) persisted = await this.transaction('accounts', 'readonly', store => store.getAll());
        const accounts = new Map(persisted.map(account => [account.id, { ...account, remembered: true }]));
        for (const [id, account] of this.memory) accounts.set(id, account);
        return [...accounts.values()];
    }
    async put(account, remember) {
        if (remember) await this.transaction('accounts', 'readwrite', store => store.put(account));
        else if (this.db) await this.transaction('accounts', 'readwrite', store => store.delete(account.id));
        this.memory.set(account.id, { ...account, remembered: remember });
    }
    async remove(id) {
        if (this.db) await this.transaction('accounts', 'readwrite', store => store.delete(id));
        this.memory.delete(id);
    }
    async snapshot(project) {
        return this.db ? this.transaction('snapshots', 'readonly', store => store.get(project)) : undefined;
    }
    async saveSnapshot(snapshot) {
        if (this.db) await this.transaction('snapshots', 'readwrite', store => store.put(snapshot));
    }
    async observations() {
        return this.db ? this.transaction('observations', 'readonly', store => store.getAll()) : [];
    }
    async saveObservation(row) {
        if (this.db) await this.transaction('observations', 'readwrite', store => store.put(row));
    }
    close() { this.db?.close(); this.db = null; this.memory.clear(); }
}
