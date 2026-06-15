"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateEventHash = generateEventHash;
exports.shouldSkipEvent = shouldSkipEvent;
exports.getSectorFilter = getSectorFilter;
exports.updateMicroCache = updateMicroCache;
exports.checkMicroCache = checkMicroCache;
const crypto = __importStar(require("crypto"));
const recentHashes = new Set();
const HASH_CACHE_SIZE = 1000;
const microVectorCache = new Map();
const CACHE_MAX_SIZE = 32;
function generateEventHash(filePath, eventType, content) {
    const snippet = content.slice(0, 128);
    return crypto.createHash('sha1').update(`${filePath}${eventType}${snippet}`).digest('hex');
}
function shouldSkipEvent(filePath, eventType, content) {
    const hash = generateEventHash(filePath, eventType, content);
    if (recentHashes.has(hash)) {
        return true;
    }
    recentHashes.add(hash);
    if (recentHashes.size > HASH_CACHE_SIZE) {
        const first = recentHashes.values().next().value;
        if (first)
            recentHashes.delete(first);
    }
    return false;
}
function getSectorFilter(eventType) {
    switch (eventType) {
        case 'edit':
        case 'save':
            return ['procedural', 'semantic'];
        case 'comment':
            return ['reflective', 'emotional'];
        case 'refactor':
            return ['procedural', 'reflective'];
        case 'debug':
        case 'error':
            return ['emotional', 'procedural'];
        default:
            return ['episodic', 'semantic'];
    }
}
function updateMicroCache(query, vector, score) {
    const key = crypto.createHash('md5').update(query).digest('hex');
    microVectorCache.set(key, { vector, timestamp: Date.now(), score });
    if (microVectorCache.size > CACHE_MAX_SIZE) {
        let oldestKey = '';
        let oldestTime = Infinity;
        for (const [k, v] of microVectorCache.entries()) {
            if (v.timestamp < oldestTime) {
                oldestTime = v.timestamp;
                oldestKey = k;
            }
        }
        if (oldestKey)
            microVectorCache.delete(oldestKey);
    }
}
function checkMicroCache(query, lambda = 0.7, tau = 3600000) {
    const key = crypto.createHash('md5').update(query).digest('hex');
    const cached = microVectorCache.get(key);
    if (!cached)
        return null;
    const deltaT = Date.now() - cached.timestamp;
    const cacheScore = lambda * cached.score + (1 - lambda) * Math.exp(-deltaT / tau);
    if (cacheScore > 0.85) {
        return { vector: cached.vector, score: cacheScore };
    }
    return null;
}
//# sourceMappingURL=ideEvents.js.map