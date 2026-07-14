import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';
import { shouldSkipEvent, getSectorFilter } from './hooks/ideEvents';
import { writeCursorConfig } from './writers/cursor';
import { writeClaudeConfig } from './writers/claude';
import { writeWindsurfConfig } from './writers/windsurf';
import { writeCopilotConfig } from './writers/copilot';
import { writeCodexConfig } from './writers/codex';
import { DashboardPanel } from './panels/DashboardPanel';
import { generateDiff } from './utils/diff';
import { ActivityObserver } from './activity';

function isCodeServer(): boolean {
    try {
        const remoteName = vscode.env.remoteName || '';
        if (remoteName && remoteName.toLowerCase().includes('codeserver')) return true;
    } catch { /* not available */ }
    return false;
}

let session_id: string | null = null;
let backend_url = 'http://localhost:8098';
let api_key: string | undefined = undefined;
let status_bar: vscode.StatusBarItem;
let is_tracking = false;
let auto_linked = false;
let use_mcp = false;
let mcp_server_path = '';
let is_enabled = true;
let user_id = '';
let activity_observer: ActivityObserver | undefined;
let show_toasts = true;
let show_status_bar = true;
const fileCache = new Map<string, string>();

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('engram');
    is_enabled = config.get('enabled') ?? true;
    backend_url = config.get('backendUrl') || 'http://localhost:8098';
    api_key = config.get('apiKey') || undefined;
    use_mcp = config.get('useMCP') || false;
    mcp_server_path = config.get('mcpServerPath') || '';
    show_status_bar = config.get<boolean>('showStatusBar') ?? true;
    show_toasts = config.get<boolean>('showToasts') ?? true;
    user_id = getUserId(context, config);

    status_bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status_bar.command = 'engram.statusBarClick';
    context.subscriptions.push(status_bar);

    const status_click = vscode.commands.registerCommand('engram.statusBarClick', () => show_menu());

    if (!is_enabled) {
        update_status_bar('disabled');
        if (show_status_bar) status_bar.show();
        context.subscriptions.push(status_click);
        return;
    }

    update_status_bar('connecting');
    if (show_status_bar) status_bar.show();

    check_connection().then(async connected => {
        if (connected) {
            await auto_link_all();
            await start_session();
        } else {
            update_status_bar('disconnected');
            vscode.window.showErrorMessage('❌ Cannot connect to Engram backend at ' + backend_url);
        }
    });

    // ... commands ...
    const query_cmd = vscode.commands.registerCommand('engram.queryContext', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Engram: Querying Context...",
            cancellable: false
        }, async () => {
            try {
                const query = editor.document.getText(editor.selection) || editor.document.getText();
                const memories = await query_context(query, editor.document.uri.fsPath);
                const doc = await vscode.workspace.openTextDocument({ content: format_memories(memories), language: 'markdown' });
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                vscode.window.showErrorMessage(`Query failed: ${error}`);
            }
        });
    });

    const add_cmd = vscode.commands.registerCommand('engram.addToMemory', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showErrorMessage('No text selected');
            return;
        }
        const kind = await vscode.window.showQuickPick(
            [
                { label: 'Phenotype', description: 'Learned context (recalled, mutable)', isGenome: false },
                { label: 'Genome', description: 'Immutable directive (always injected)', isGenome: true },
            ],
            { placeHolder: 'Save selection as Phenotype or Genome?' },
        );
        if (!kind) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Engram: Saving selection as ${kind.label}...`,
            cancellable: false
        }, async () => {
            try {
                const res = await add_memory(selection, editor.document.uri.fsPath, kind.isGenome, 'semantic');
                if (res?.id) vscode.window.showInformationMessage(`Selection added to Engram (${kind.label})`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add memory: ${error}`);
            }
        });
    });

    const note_cmd = vscode.commands.registerCommand('engram.quickNote', async () => {
        const input = await vscode.window.showInputBox({ prompt: 'Enter a quick note to remember', placeHolder: 'e.g. Refactored the auth logic to use JWT' });
        if (!input) return;
        const kind = await vscode.window.showQuickPick(
            [
                { label: 'Phenotype', description: 'Learned context (recalled, mutable)', isGenome: false },
                { label: 'Genome', description: 'Immutable directive (always injected)', isGenome: true },
            ],
            { placeHolder: 'Save as Phenotype or Genome?' },
        );
        if (!kind) return;
        try {
            const editor = vscode.window.activeTextEditor;
            const file = editor ? editor.document.uri.fsPath : 'manual-note';
            const res = await add_memory(input, file, kind.isGenome, 'semantic');
            if (res?.id) vscode.window.showInformationMessage(`Note saved (${kind.label})`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add note: ${error}`);
        }
    });

    const patterns_cmd = vscode.commands.registerCommand('engram.viewPatterns', async () => {
        // Open the dashboard and surface the Insights tab (stats + sectors + recent memories).
        DashboardPanel.createOrShow(context.extensionUri);
        // Give the panel a moment to mount, then ask it to load insights.
        setTimeout(() => {
            DashboardPanel.currentPanel?.postMessage({ command: 'switchView', view: 'insights' });
        }, 200);
    });

    const recall_cmd = vscode.commands.registerCommand('engram.dashboardRecall', async (query?: string) => {
        if (!query || !query.trim()) return;
        try {
            const data = await dashboard_recall(query);
            DashboardPanel.currentPanel?.postMessage({ command: 'recallResult', ...data });
        } catch (error) {
            DashboardPanel.currentPanel?.postMessage({ command: 'recallResult', results: [], error: String(error) });
        }
    });

    const addmem_cmd = vscode.commands.registerCommand('engram.dashboardAddMemory', async (content?: string, isGenome?: boolean, sector?: string) => {
        if (!content || !content.trim()) return;
        try {
            const res = await add_memory(content, 'dashboard', Boolean(isGenome), sector || 'semantic');
            if (res?.id) {
                if (show_toasts) vscode.window.showInformationMessage(`Memory saved (${isGenome ? 'Genome' : 'Phenotype'})`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save memory: ${error}`);
        }
    });

    const settings_cmd = vscode.commands.registerCommand('engram.settings', async () => {
        await show_settings();
    });

    const insights_cmd = vscode.commands.registerCommand('engram.dashboardInsights', async () => {
        try {
            const data = await dashboard_insights();
            DashboardPanel.currentPanel?.postMessage({ command: 'insights', ...data });
        } catch (error) {
            DashboardPanel.currentPanel?.postMessage({ command: 'insights', stats: {}, memories: [] });
        }
    });

    const webgui_cmd = vscode.commands.registerCommand('engram.openWebGui', async () => {
        await open_web_gui();
    });

    const toggle_cmd = vscode.commands.registerCommand('engram.toggleTracking', () => {
        is_tracking = !is_tracking;
        update_status_bar(is_tracking ? 'active' : 'paused');
    });

    const dashboard_cmd = vscode.commands.registerCommand('engram.dashboard', () => { DashboardPanel.createOrShow(context.extensionUri); });

    // Initialize cache for all currently open documents
    vscode.workspace.textDocuments.forEach(doc => {
        if (doc.uri.scheme === 'file') {
            fileCache.set(doc.uri.toString(), doc.getText());
        }
    });

    const open_listener = vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === 'file') {
            fileCache.set(doc.uri.toString(), doc.getText());
        }
    });

    const save_listener = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (is_enabled && is_tracking && doc.uri.scheme === 'file') {
            const newContent = doc.getText();
            const oldContent = fileCache.get(doc.uri.toString());
            let contentToSend = "";

            if (oldContent) {
                const diff = generateDiff(oldContent, newContent, doc.uri.fsPath);
                // If diff is huge, maybe cap it? For now, user requested "parts which changed"
                contentToSend = diff;
            } else {
                contentToSend = `[New File Snapshot]\n${newContent}`;
            }

            // Update cache for next save
            fileCache.set(doc.uri.toString(), newContent);

            send_event({ event_type: 'save', file_path: doc.uri.fsPath, language: doc.languageId, content: contentToSend });
        }
    });

    // Register Chat Participant (Phase 5: Explainable Traces)
    registerChatParticipant(context);

    context.subscriptions.push(status_click, status_bar, toggle_cmd, webgui_cmd, dashboard_cmd, insights_cmd, settings_cmd, recall_cmd, addmem_cmd, save_listener, open_listener);
    // Note: Re-registering commands that were elided in this block for brevity if they weren't before. 
    // Actually, I need to be careful not to delete the existing command registrations if I'm replacing a huge block.
    // The target range seems to include most of activate.
    // I will try to be more precise or include the commands.

    // Commands were: query_cmd, add_cmd, note_cmd, patterns_cmd.
    // I will include them in the full replacement to be safe since I selected a large range.
}

async function auto_link_all() {
    auto_linked = false;
    try {
        const configs: string[] = [];
        configs.push(await writeCursorConfig(backend_url, api_key, use_mcp, mcp_server_path));
        configs.push(await writeClaudeConfig(backend_url, api_key, use_mcp, mcp_server_path));
        configs.push(await writeWindsurfConfig(backend_url, api_key, use_mcp, mcp_server_path));
        configs.push(await writeCopilotConfig(backend_url, api_key, use_mcp, mcp_server_path));
        configs.push(await writeCodexConfig(backend_url, api_key, use_mcp, mcp_server_path));

        const mode = use_mcp ? 'MCP protocol' : 'Direct HTTP';
        vscode.window.showInformationMessage(`✅ Auto-linked Engram to AI tools (${mode})`);
        auto_linked = true;
    } catch (error) {
        console.error('Auto-link failed:', error);
    }
}

function update_status_bar(state: 'active' | 'paused' | 'connecting' | 'disconnected' | 'disabled') {
    const build = 'B';
    const icons = { active: `$(pulse) Engram [${build}]`, paused: `$(debug-pause) Engram [${build}]`, connecting: `$(sync~spin) Engram [${build}]`, disconnected: `$(error) Engram [${build}]`, disabled: `$(circle-slash) Engram [${build}]` };
    const mode = use_mcp ? 'MCP' : 'HTTP';
    const tooltips = {
        active: `Engram [${build}]: Tracking active (${mode}) • Click for options`,
        paused: `Engram [${build}]: Tracking paused (${mode}) • Click to resume`,
        connecting: `Engram [${build}]: Connecting (${mode})...`,
        disconnected: `Engram [${build}]: Disconnected (${mode}) • Click to setup`,
        disabled: `Engram [${build}]: Disabled • Click to enable`
    };
    status_bar.text = icons[state];
    status_bar.tooltip = tooltips[state];
    if (show_status_bar) status_bar.show();
    else status_bar.hide();
}

async function show_menu() {
    if (!is_enabled) {
        const choice = await vscode.window.showQuickPick([
            { label: '$(check) Enable Engram', action: 'enable' }
        ], { placeHolder: 'Engram is Disabled' });
        if (!choice) return;
        if (choice.action === 'enable') {
            const config = vscode.workspace.getConfiguration('engram');
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);
            is_enabled = true;
            vscode.window.showInformationMessage('Engram enabled. Reloading window...');
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        return;
    }

    const items = [];
    items.push(is_tracking ? { label: '$(debug-pause) Pause Tracking', action: 'pause' } : { label: '$(play) Resume Tracking', action: 'resume' });
    items.push({ label: '$(dashboard) Open Dashboard', action: 'dashboard' });
    items.push({ label: '$(search) Query Context', action: 'query' }, { label: '$(add) Add Selection', action: 'add' }, { label: '$(pencil) Quick Note', action: 'note' }, { label: '$(graph) View Patterns', action: 'patterns' }, { label: '$(circle-slash) Disable Extension', action: 'disable' }, { label: '$(refresh) Reconnect', action: 'reconnect' });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Engram Actions' });
    if (!choice) return;
    switch (choice.action) {
        case 'dashboard': vscode.commands.executeCommand('engram.dashboard'); break;
        case 'pause': is_tracking = false; update_status_bar('paused'); break;
        case 'resume': is_tracking = true; update_status_bar('active'); break;
        case 'query': vscode.commands.executeCommand('engram.queryContext'); break;
        case 'add': vscode.commands.executeCommand('engram.addToMemory'); break;
        case 'note': vscode.commands.executeCommand('engram.quickNote'); break;
        case 'patterns': vscode.commands.executeCommand('engram.viewPatterns'); break;
        case 'disable':
            const config = vscode.workspace.getConfiguration('engram');
            await config.update('enabled', false, vscode.ConfigurationTarget.Global);
            is_enabled = false;
            if (session_id) await end_session();
            update_status_bar('disabled');
            vscode.window.showInformationMessage('Engram disabled');
            break;
        case 'reconnect':
            update_status_bar('connecting');
            const connected = await check_connection();
            if (connected) {
                await start_session();
            } else {
                update_status_bar('disconnected');
                vscode.window.showErrorMessage('Cannot connect to backend');
            }
            break;
    }
}

async function open_web_gui() {
    const config = vscode.workspace.getConfiguration('engram');
    let url = (config.get<string>('webGuiUrl') || '').trim();

    if (!url) {
        // Derive a sensible suggestion from the backend host, defaulting the Web GUI port to 8099.
        let suggestion = 'http://localhost:8099';
        try {
            const b = new URL(backend_url);
            suggestion = `${b.protocol}//${b.hostname}:8099`;
        } catch { /* keep default */ }

        const entered = await vscode.window.showInputBox({
            prompt: 'Enter your Engram Web GUI address',
            placeHolder: 'http://192.168.1.50:8099',
            value: suggestion,
            ignoreFocusOut: true,
            validateInput: (v) => {
                const t = (v || '').trim();
                if (!t) return 'Enter a URL, or press Escape to cancel';
                try { const u = new URL(t); if (!/^https?:$/.test(u.protocol)) return 'URL must start with http:// or https://'; }
                catch { return 'Not a valid URL'; }
                return null;
            }
        });
        if (entered === undefined) return; // cancelled
        url = entered.trim();
        await config.update('webGuiUrl', url, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Engram Web GUI saved: ${url}`);
    }

    vscode.env.openExternal(vscode.Uri.parse(url));
}

async function show_settings() {
    const config = vscode.workspace.getConfiguration('engram');
    const curToasts = config.get('showToasts') ?? true;
    const curStatus = config.get('showStatusBar') ?? true;
    const items = [
        { label: `${curToasts ? '$(check)' : '$(circle-large-outline)'} Toast notifications`, setting: 'showToasts', value: !curToasts, description: 'Pop-ups when Engram saves new memories' },
        { label: `${curStatus ? '$(check)' : '$(circle-large-outline)'} Status bar item`, setting: 'showStatusBar', value: !curStatus, description: 'Live activity count in the status bar' },
        { label: '$(server) Change Backend URL', action: 'url' },
        { label: '$(globe) Change Web GUI URL', action: 'webgui' },
        { label: '$(key) Configure API Key', action: 'apikey' },
    ];
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Engram Settings' });
    if (!choice) return;

    if ((choice as any).action === 'url') {
        const url = await vscode.window.showInputBox({ prompt: 'Enter backend URL', value: backend_url, placeHolder: 'http://localhost:8098' });
        if (url) {
            await config.update('backendUrl', url, vscode.ConfigurationTarget.Global);
            backend_url = url;
            vscode.window.showInformationMessage('Backend URL updated. Reconnecting…');
            if (await check_connection()) await start_session();
        }
        return;
    }
    if ((choice as any).action === 'webgui') {
        const current = config.get<string>('webGuiUrl') || '';
        const url = await vscode.window.showInputBox({
            prompt: 'Enter your Engram Web GUI address (leave empty to be prompted next time)',
            value: current,
            placeHolder: 'http://192.168.1.50:8099',
            ignoreFocusOut: true,
            validateInput: (v) => {
                const t = (v || '').trim();
                if (!t) return null; // empty is allowed (clears it)
                try { const u = new URL(t); if (!/^https?:$/.test(u.protocol)) return 'URL must start with http:// or https://'; }
                catch { return 'Not a valid URL'; }
                return null;
            }
        });
        if (url !== undefined) {
            await config.update('webGuiUrl', url.trim(), vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(url.trim() ? `Web GUI URL saved: ${url.trim()}` : 'Web GUI URL cleared');
        }
        return;
    }
    if ((choice as any).action === 'apikey') {
        const key = await vscode.window.showInputBox({ prompt: 'Enter API key (leave empty if not required)', password: true, placeHolder: 'your-api-key' });
        if (key !== undefined) {
            await config.update('apiKey', key, vscode.ConfigurationTarget.Global);
            api_key = key;
            vscode.window.showInformationMessage('API key saved');
        }
        return;
    }
    // Toggle a boolean setting.
    const setting = (choice as any).setting as string;
    const newValue = (choice as any).value as boolean;
    await config.update(setting, newValue, vscode.ConfigurationTarget.Global);
    if (setting === 'showToasts') show_toasts = newValue;
    if (setting === 'showStatusBar') {
        show_status_bar = newValue;
        update_status_bar(is_tracking ? 'active' : 'paused');
    }
    vscode.window.showInformationMessage(`Engram ${setting} ${newValue ? 'enabled' : 'disabled'}`);
}

function getUserId(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration): string {
    // 1. Check if user has configured a custom userId
    const configuredUserId = config.get<string>('userId');
    if (configuredUserId) return configuredUserId;

    // 2. Check if we have a persistent userId in global state
    let persistedUserId = context.globalState.get<string>('engram.userId');
    if (persistedUserId) return persistedUserId;

    // 3. Generate a new unique userId based on machine ID
    const machineId = vscode.env.machineId; // Unique per machine
    const userName = process.env.USERNAME || process.env.USER || 'user';
    persistedUserId = `${userName}-${machineId.substring(0, 8)}`;

    // 4. Persist it for future sessions
    context.globalState.update('engram.userId', persistedUserId);

    return persistedUserId;
}

function getProjectName(): string {
    const config = vscode.workspace.getConfiguration('engram');
    return config.get<string>('projectName') || vscode.workspace.workspaceFolders?.[0]?.name || 'unknown';
}

async function check_connection(): Promise<boolean> {
    try {
        const response = await fetch(`${backend_url}/health`, { method: 'GET', headers: get_headers() });
        return response.ok;
    } catch {
        return false;
    }
}

function get_headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (api_key) headers['x-api-key'] = api_key;
    // code-server passes auth via the remote's connection token when running in a container/remote
    return headers;
}

async function start_session() {
    try {
        const config = vscode.workspace.getConfiguration('engram');
        const configuredProject = config.get<string>('projectName');
        const project = configuredProject || vscode.workspace.workspaceFolders?.[0]?.name || 'unknown';
        const ideName = isCodeServer() ? 'codeserver' : 'vscode';
        const response = await fetch(`${backend_url}/api/ide/session/start`, { method: 'POST', headers: get_headers(), body: JSON.stringify({ user_id: user_id, project_name: project, ide_name: ideName }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        session_id = data.session_id;
        is_tracking = true;
        update_status_bar('active');
        vscode.window.showInformationMessage('Engram connected');
        // Start the passive activity observer (server-side traffic buffer).
        // Works whether Engram is driven standalone or via the Hermes plugin.
        activity_observer = new ActivityObserver(
          backend_url,
          api_key,
          status_bar,
          () => DashboardPanel.currentPanel,
          () => show_toasts,
        );
        activity_observer.start();
    } catch {
        update_status_bar('disconnected');
        vscode.window.showErrorMessage('❌ Cannot connect to Engram backend at ' + backend_url);
    }
}

async function end_session() {
    activity_observer?.stop();
    activity_observer = undefined;
    if (!session_id) return;
    try {
        await fetch(`${backend_url}/api/ide/session/end`, { method: 'POST', headers: get_headers(), body: JSON.stringify({ session_id, user_id }) });
        session_id = null;
    } catch { }
}

async function send_event(event_data: { event_type: string; file_path: string; language: string; content?: string; metadata?: any; }) {
    if (!session_id || !is_tracking) return;
    try {
        await fetch(`${backend_url}/api/ide/events`, { method: 'POST', headers: get_headers(), body: JSON.stringify({ session_id, user_id, event_type: event_data.event_type, file_path: event_data.file_path, language: event_data.language, content: event_data.content, metadata: event_data.metadata, timestamp: new Date().toISOString() }) });
    } catch { }
}

async function query_context(query: string, file: string) {
    const response = await fetch(`${backend_url}/api/ide/context`, { method: 'POST', headers: get_headers(), body: JSON.stringify({ query, session_id, file_path: file, limit: 10 }) });
    const data = await response.json();
    return data.memories || [];
}

// Semantic recall used by the dashboard Recall tab (/api/dashboard/recall).
async function dashboard_recall(query: string) {
    const response = await fetch(`${backend_url}/api/dashboard/recall`, {
        method: 'POST',
        headers: get_headers(),
        body: JSON.stringify({ query, limit: 20, mode: 'associative' })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

// Insights used by the dashboard Insights tab.
async function dashboard_insights() {
    const [statsRes, memRes] = await Promise.all([
        fetch(`${backend_url}/api/dashboard/stats`, { method: 'GET', headers: get_headers() }),
        fetch(`${backend_url}/api/dashboard/memories?limit=15`, { method: 'GET', headers: get_headers() }),
    ]);
    const stats = statsRes.ok ? await statsRes.json() : {};
    const mems = memRes.ok ? await memRes.json() : { memories: [] };
    return { stats, memories: mems.memories || [] };
}

async function add_memory(content: string, file: string, isGenome: boolean = false, sector: string = 'semantic') {
    const response = await fetch(`${backend_url}/memories`, {
        method: 'POST',
        headers: get_headers(),
        body: JSON.stringify({
            content,
            user_id: user_id,
            project_id: getProjectName(),
            is_genome: isGenome,
            metadata: { sector: sector, source: 'vscode', file }
        })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

async function get_patterns(sid: string) {
    const response = await fetch(`${backend_url}/api/ide/patterns/${sid}`, { method: 'GET', headers: get_headers() });
    const data = await response.json();
    return data.patterns || [];
}

function format_memories(memories: any[]): string {
    let out = '# Engram Context Results\n\n';
    if (memories.length === 0) return out + 'No relevant memories found.\n';
    for (const m of memories) {
        out += `## Memory ID: ${m.id}\n**Score:** ${m.score?.toFixed(3) || 'N/A'}\n**Sector:** ${m.sector}\n**Content:**\n\`\`\`\n${m.content}\n\`\`\`\n\n`;
    }
    return out;
}

function format_patterns(patterns: any[]): string {
    let out = '# Detected Coding Patterns\n\n';
    if (patterns.length === 0) return out + 'No patterns detected.\n';
    for (const p of patterns) {
        out += `## Pattern: ${p.description || 'Unknown'}\n**Frequency:** ${p.frequency || 'N/A'}\n**Context:**\n\`\`\`\n${p.context || 'No context'}\n\`\`\`\n\n`;
    }
    return out;
}

// ── Chat Participant (Phase 5: Explainable Traces) ───────────────────────

interface CognitiveTrace {
	genome: string[];
	phenotype: Array<{ sector: string; content: string; score: number }>;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

async function gatherChatLocalContext(): Promise<string> {
	let context = '';
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const fileName = path.basename(editor.document.fileName);
		const language = editor.document.languageId;
		const snippet = editor.document.getText(new vscode.Range(0, 0, 15, 0)).trim();
		context += `\n- Active File: ${fileName} (${language})\n- Snippet:\n${snippet}\n`;
	}
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceFolder) {
			const branch = execSync('git branch --show-current', { cwd: workspaceFolder, encoding: 'utf-8' }).trim();
			context += `\n- Current Git Branch: ${branch}\n`;
		}
	} catch { /* ignore git errors */ }
	return context.trim() || 'No specific local workspace context available.';
}

function renderDynamicCognitiveTrace(stream: vscode.ChatResponseStream, trace: CognitiveTrace) {
	let markdown = '\n\n---\n<details>\n<summary>🧬 <b>Engram Memory Trace</b> (Click to expand)</summary>\n<br>\n';
	if (trace.genome && trace.genome.length > 0) {
		markdown += '<b>✅ Genome (Immutable Directives):</b>\n<ul>\n';
		trace.genome.forEach(fact => { markdown += `  <li>${escapeHtml(fact)}</li>\n`; });
		markdown += '</ul>\n<br>\n';
	} else {
		markdown += '<b>✅ Genome:</b> <i>None active</i><br>\n';
	}
	if (trace.phenotype && trace.phenotype.length > 0) {
		markdown += '<b>🔄 Phenotype (Recalled Context):</b>\n<ul>\n';
		trace.phenotype.forEach(mem => {
			const sectorLabel = mem.sector.charAt(0).toUpperCase() + mem.sector.slice(1);
			markdown += `  <li><i>[${sectorLabel}]</i> ${escapeHtml(mem.content)}</li>\n`;
		});
		markdown += '</ul>\n';
	} else {
		markdown += '<b>🔄 Phenotype:</b> <i>No contextual memories matched</i>\n';
	}
	markdown += `<br>\n<i>💡 These memories were implicitly injected into the LLM's system prompt before generation.</i>\n</details>\n`;
	stream.markdown(markdown);
}

export function registerChatParticipant(context: vscode.ExtensionContext) {
	const handler: vscode.ChatRequestHandler = async (
		request: vscode.ChatRequest,
		chatContext: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	) => {
		const localContext = await gatherChatLocalContext();
		const messages = [
			{ role: 'system', content: `You are Engram Cortex. Local Context: ${localContext}` },
			{ role: 'user', content: request.prompt },
		];

		stream.progress('🧬 Querying Engram cognitive engine...');

		let dynamicTrace: CognitiveTrace | null = null;

		try {
			const response = await fetch(`${backend_url}/v1/chat/completions`, {
				method: 'POST',
				headers: get_headers(),
				body: JSON.stringify({ messages, stream: true, model: 'proxy' }),
			});

			if (!response.ok || !response.body) {
				throw new Error(`Proxy failed with status ${response.status}`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const chunks = buffer.split('\n\n');
				buffer = chunks.pop() || '';

				for (const msg of chunks) {
					if (!msg.trim()) continue;
					let eventType = 'message';
					let eventData = '';
					const lines = msg.split('\n');
					for (const line of lines) {
						if (line.startsWith('event: ')) eventType = line.slice(7).trim();
						else if (line.startsWith('data: ')) eventData = line.slice(6).trim();
					}

					if (eventType === 'message' && eventData !== '[DONE]') {
						try {
							const json = JSON.parse(eventData);
							const content = json.choices?.[0]?.delta?.content || '';
							if (content) stream.markdown(content);
						} catch { /* ignore partial chunks */ }
					} else if (eventType === 'engram_trace') {
						try { dynamicTrace = JSON.parse(eventData) as CognitiveTrace; }
						catch (e) { console.error('[Engram] Failed to parse trace data:', e); }
					}
				}
			}

			if (dynamicTrace) {
				renderDynamicCognitiveTrace(stream, dynamicTrace);
			} else {
				stream.markdown('\n\n---\n<i>💡 No specific long-term memories were triggered for this request.</i>');
			}
		} catch (error: any) {
			stream.markdown(`❌ **Engram Error**: ${error.message}\n\n*Is the Engram proxy running on port 8080?*`);
		}
	};

	const participant = vscode.chat.createChatParticipant('engram.cortex', handler);
	const iconUri = vscode.Uri.file(
			path.join(context.extensionPath, 'icon.png'),
		);
		participant.iconPath = iconUri;
	context.subscriptions.push(participant);
}
