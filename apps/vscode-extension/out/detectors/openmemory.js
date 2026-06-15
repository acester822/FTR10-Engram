"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectBackend = detectBackend;
exports.getBackendInfo = getBackendInfo;
async function detectBackend(url) {
    try {
        const response = await fetch(`${url}/health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        return response.ok;
    }
    catch {
        return false;
    }
}
async function getBackendInfo(url) {
    try {
        const response = await fetch(`${url}/health`);
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=openmemory.js.map