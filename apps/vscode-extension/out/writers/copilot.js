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
exports.generateCopilotConfig = generateCopilotConfig;
exports.writeCopilotConfig = writeCopilotConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
function generateCopilotConfig(backendUrl, apiKey, useMCP = false, mcpServerPath) {
    if (useMCP) {
        const backendMcpPath = mcpServerPath || path.join(process.cwd(), 'backend', 'dist', 'ai', 'mcp.js');
        const config = {
            name: 'Engram',
            type: 'mcp',
            mcpServer: {
                command: 'node',
                args: [backendMcpPath]
            }
        };
        if (apiKey) {
            config.mcpServer.env = { EG_API_KEY: apiKey };
        }
        return config;
    }
    const config = {
        name: 'Engram',
        type: 'context_provider',
        endpoint: `${backendUrl}/api/ide/context`
    };
    if (apiKey) {
        config.authentication = {
            type: 'header',
            header: `x-api-key: ${apiKey}`
        };
    }
    return config;
}
async function writeCopilotConfig(backendUrl, apiKey, useMCP = false, mcpServerPath) {
    const copilotDir = path.join(os.homedir(), '.github', 'copilot');
    const configFile = path.join(copilotDir, 'engram.json');
    if (!fs.existsSync(copilotDir)) {
        fs.mkdirSync(copilotDir, { recursive: true });
    }
    const config = generateCopilotConfig(backendUrl, apiKey, useMCP, mcpServerPath);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    return configFile;
}
//# sourceMappingURL=copilot.js.map