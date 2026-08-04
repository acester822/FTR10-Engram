import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface ActivityEntry {
  ts: number;
  direction: 'in' | 'out';
  kind: 'write' | 'read';
  label: string;
  route: string;
  method: string;
  status: number;
  ms: number;
  summary?: string;
  count?: number;
  breakdown?: { genome: number; phenotype: number; sectors: Record<string, number> };
  user_id?: string;
}

interface ActivityData {
  total: number;
  incoming: number;
  outgoing: number;
  entries: ActivityEntry[];
}

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _lastData: ActivityData | null = null;
  private _ftr10Watcher?: fs.FSWatcher;

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      return;
    }

    // code-server (and VS Code) force a dark/light override onto webview CSS
    // custom properties when colorScheme is 'dark'/'light', which strips
    // inline `background` colours from data-viz elements (e.g. the sector bars).
    // 'normal' tells the host NOT to inject that override, so our --ftr10-*
    // token theme renders exactly as authored.
    const webviewOpts: vscode.WebviewOptions & vscode.WebviewPanelOptions & { colorScheme?: 'light' | 'dark' | 'normal' } = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(extensionUri.fsPath, 'media'))],
      colorScheme: 'normal'
    };

    const panel = vscode.window.createWebviewPanel(
      'openMemoryDashboard',
      'Engram Dashboard',
      column || vscode.ViewColumn.One,
      webviewOpts
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'quickNote':
            vscode.commands.executeCommand('engram.quickNote');
            return;
          case 'query':
            vscode.commands.executeCommand('engram.queryContext');
            return;
          case 'patterns':
            vscode.commands.executeCommand('engram.viewPatterns');
            return;
          case 'settings':
            vscode.commands.executeCommand('engram.settings');
            return;
          case 'openWebGui':
            vscode.commands.executeCommand('engram.openWebGui');
            return;
          case 'loadInsights':
            vscode.commands.executeCommand('engram.dashboardInsights');
            return;
          case 'switchView':
            // also handled client-side; no-op here
            return;
          case 'recall':
            // Forward a semantic recall request to the extension.
            vscode.commands.executeCommand('engram.dashboardRecall', message.query);
            return;
          case 'newMemory':
            vscode.commands.executeCommand(
              'engram.dashboardAddMemory',
              message.content,
              message.isGenome,
              message.sector,
            );
            return;
        }
      },
      null,
      this._disposables
    );
  }

  /** Called by the ActivityObserver with the latest server activity snapshot. */
  public updateActivity(data: ActivityData) {
    this._lastData = data;
    if (this._panel && this._panel.visible) {
      this._panel.webview.postMessage({ command: 'activity', ...data });
    }
  }

  /** Satisfies the ActivityObserver's WebviewLike shape. */
  public postMessage(msg: any): Thenable<boolean> {
    if (!this._panel) return Promise.resolve(false);
    return this._panel.webview.postMessage(msg);
  }

  public dispose() {
    DashboardPanel.currentPanel = undefined;
    this._ftr10Watcher?.close();
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update() {
    const webview = this._panel.webview;
    this._panel.webview.html = this._getHtmlForWebview(webview);
    // Keep the dashboard's colors in sync with the live FTR10 theme engine:
    // watch ~/.ftr10/vars.json and push updates into the webview.
    this._startFtr10Watcher();
  }

  /** Reads the live FTR10 token set from ~/.ftr10/vars.json. */
  private _readFtr10Vars(): Record<string, string> {
    try {
      const varsPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '~',
        '.ftr10',
        'vars.json',
      );
      if (!fs.existsSync(varsPath)) return {};
      const raw = fs.readFileSync(varsPath, 'utf-8');
      const parsed = JSON.parse(raw) as { values?: Record<string, string> };
      return parsed.values ?? {};
    } catch {
      return {};
    }
  }

  /** Pushes the current FTR10 vars into the webview for live theming. */
  private _postFtr10Vars(): void {
    const vars = this._readFtr10Vars();
    if (Object.keys(vars).length === 0) return;
    this._panel.webview.postMessage({ command: 'ftr10VarsUpdate', vars });
  }

  /** Watches ~/.ftr10/vars.json so the dashboard re-themes when FTR10 changes. */
  private _startFtr10Watcher(): void {
    if (this._ftr10Watcher) return;
    try {
      const varsPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '~',
        '.ftr10',
        'vars.json',
      );
      if (!fs.existsSync(varsPath)) return;
      this._ftr10Watcher = fs.watch(varsPath, () => this._postFtr10Vars());
    } catch {
      // FTR10 not installed — silently skip live theming.
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();
    // Real, externally-linked stylesheet (shows as a file in Chrome DevTools
    // Sources, so it can be inspected / live-edited). Served from the
    // webview's own origin via asWebviewUri, so it satisfies the CSP
    // (style-src includes webview.cspSource).
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media', 'dashboard.css'))
    );

    // Read the live FTR10 token set from ~/.ftr10/vars.json so the dashboard
    // applies the SAME theme colors as the FTR10 Base theme (and the Hermes
    // chat panel). The vars are injected into the webview at build time and
    // pushed live via the host 'ftr10VarsUpdate' message.
    const ftr10Vars = this._readFtr10Vars();
    const ftr10VarsJson = Object.keys(ftr10Vars).length > 0
      ? JSON.stringify(ftr10Vars)
      : '{}';

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Engram Dashboard</title>
        <link rel="stylesheet" href="${cssUri}">
      </head>
      <body>
        <div class="header">
          <div>
            <h1>🧠 Engram</h1>
            <div class="sub">Live memory engine — driven by the server activity buffer</div>
          </div>
          <div class="hdr-actions">
            <button id="webGuiBtn" class="iconbtn" title="Open the Engram Web GUI in your browser">🌐 Web GUI</button>
            <button id="settingsBtn" class="iconbtn" title="Settings">⚙ Settings</button>
          </div>
        </div>

        <div class="tabs">
          <button class="tab active" data-view="activity">Live Activity</button>
          <button class="tab" data-view="recall">Recall</button>
          <button class="tab" data-view="insights">Insights</button>
          <button class="tab" data-view="new">+ New Memory</button>
        </div>

        <!-- Activity -->
        <div class="view active" id="view-activity">
          <div class="summary">
            <div class="stat in"><div class="num" id="inN">0</div><div class="lbl">Saved (in)</div></div>
            <div class="stat out"><div class="num" id="outN">0</div><div class="lbl">Recalled (out)</div></div>
            <div class="stat"><div class="num" id="totN">0</div><div class="lbl">Total</div></div>
          </div>
          <div class="feed" id="feed">
            <div class="empty">Waiting for memory activity…</div>
          </div>
        </div>

        <!-- Recall -->
        <div class="view" id="view-recall">
          <div class="field">
            <label>Semantic query</label>
            <div class="row2">
              <input id="recallQuery" placeholder="e.g. how is auth configured?" />
              <button id="recallBtn" style="flex:0 0 auto">Search</button>
            </div>
          </div>
          <div id="recallResults"><div class="empty">Run a query to recall relevant memories.</div></div>
        </div>

        <!-- Insights -->
        <div class="view" id="view-insights">
          <div class="summary">
            <div class="stat"><div class="num" id="totM">–</div><div class="lbl">Memories</div></div>
            <div class="stat in"><div class="num" id="genM">–</div><div class="lbl">Genome</div></div>
            <div class="stat out"><div class="num" id="pheM">–</div><div class="lbl">Phenotype</div></div>
          </div>
          <h2 style="font-size:0.95rem;">By Sector</h2>
          <div id="sectorBars"><div class="empty">Loading…</div></div>
          <h2 style="font-size:0.95rem;margin-top:12px;">Recent Memories</h2>
          <div id="recentMems"><div class="empty">Loading…</div></div>
        </div>

        <!-- New Memory -->
        <div class="view" id="view-new">
          <div class="field">
            <label>Content</label>
            <textarea id="memContent" placeholder="What should Engram remember?"></textarea>
          </div>
          <div class="row2">
            <div class="field">
              <label>Type</label>
              <select id="memType">
                <option value="phenotype">Phenotype (learned context)</option>
                <option value="genome">Genome (immutable directive)</option>
              </select>
            </div>
            <div class="field">
              <label>Sector</label>
              <select id="memSector">
                <option value="semantic">Semantic</option>
                <option value="procedural">Procedural</option>
                <option value="episodic">Episodic</option>
                <option value="emotional">Emotional</option>
                <option value="reflective">Reflective</option>
              </select>
            </div>
          </div>
          <button id="memSave">Save Memory</button>
          <div class="hint">Genome memories are permanent directives; Phenotype memories are recalled context.</div>
        </div>

        <script nonce="${nonce}">
          // Strip code-server's vscode-dark class entirely so its theme CSS can
          // no longer match and repaint our elements. Force color-scheme:normal.
          document.documentElement.classList.remove('vscode-dark', 'vscode-light');
          document.body.classList.remove('vscode-dark', 'vscode-light');
          document.documentElement.style.colorScheme = 'normal';
          document.body.style.colorScheme = 'normal';
          // Live FTR10 theming: apply the SAME tokens the FTR10 Base theme
          // engine pushes into every themed webview (e.g. the Hermes chat
          // panel), so the dashboard tracks the live theme instead of a
          // hard-coded palette. The extension reads ~/.ftr10/vars.json and
          // injects it at build time; live changes are pushed by the host
          // through the 'ftr10VarsUpdate' message below.
          function applyFtr10Vars(vars) {
            if (!vars) return;
            const rt = document.documentElement;
            for (const k in vars) {
              if (Object.prototype.hasOwnProperty.call(vars, k)) {
                rt.style.setProperty(k, vars[k], 'important');
              }
            }
          }
          applyFtr10Vars({{FTR10_VARS_JSON}});

          const vscode = acquireVsCodeApi();
          const $ = (id) => document.getElementById(id);

          // Settings button
          $('settingsBtn').addEventListener('click', () => vscode.postMessage({ command: 'settings' }));
          // Web GUI button
          $('webGuiBtn').addEventListener('click', () => vscode.postMessage({ command: 'openWebGui' }));

          // Tab switching
          document.querySelectorAll('.tab').forEach(t => {
            t.addEventListener('click', () => {
              document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
              document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
              t.classList.add('active');
              $('view-' + t.dataset.view).classList.add('active');
              if (t.dataset.view === 'insights') vscode.postMessage({ command: 'loadInsights' });
            });
          });

          // Recall
          const doRecall = () => {
            const q = $('recallQuery').value.trim();
            if (!q) return;
            $('recallResults').innerHTML = '<div class="empty">Searching…</div>';
            vscode.postMessage({ command: 'recall', query: q });
          };
          $('recallBtn').addEventListener('click', doRecall);
          $('recallQuery').addEventListener('keydown', e => { if (e.key === 'Enter') doRecall(); });

          // New memory
          $('memSave').addEventListener('click', () => {
            const content = $('memContent').value.trim();
            if (!content) { $('memContent').focus(); return; }
            vscode.postMessage({
              command: 'newMemory',
              content,
              isGenome: $('memType').value === 'genome',
              sector: $('memSector').value
            });
            $('memContent').value = '';
            $('memSave').textContent = 'Saved ✓';
            setTimeout(() => $('memSave').textContent = 'Save Memory', 1500);
          });

          // Activity rendering
          function renderActivity(data) {
            $('inN').textContent = data.incoming || 0;
            $('outN').textContent = data.outgoing || 0;
            $('totN').textContent = data.total || 0;
            const feed = $('feed');
            const entries = (data.entries || []).slice(0, 40);
            if (!entries.length) { feed.innerHTML = '<div class="empty">No memory activity yet.</div>'; return; }
            const t = (ts) => new Date(ts).toLocaleTimeString();
            feed.innerHTML = entries.map(e => {
              const isIn = e.direction === 'in';
              let detail = '';
              if (e.breakdown) {
                const b = e.breakdown; const parts = [];
                if (b.genome > 0) parts.push(b.genome + ' Genome');
                if (b.phenotype > 0) parts.push(b.phenotype + ' Phenotype');
                const sec = Object.entries(b.sectors || {}).sort((a,b)=>b[1]-a[1])
                  .map(([s,n])=> n+' '+ (s[0].toUpperCase()+s.slice(1))).join(' + ');
                if (sec) parts.push(sec);
                detail = parts.join(' + ');
              }
              if (!detail && e.summary) detail = (e.summary || '').slice(0, 80);
              const status = e.status ? '· ' + e.status : '';
              const ms = e.ms ? ' · ' + e.ms + 'ms' : '';
              return '<div class="row"><span class="badge '+(isIn?'in':'out')+'">'+(isIn?'SAVED':'RECALL')+'</span>'
                + '<span class="route">'+t(e.ts)+' '+e.route+status+ms+'</span>'
                + '<span class="detail">'+(detail||'')+'</span></div>';
            }).join('');
          }

          function renderRecall(data) {
            const results = data.results || [];
            const box = $('recallResults');
            if (!results.length) { box.innerHTML = '<div class="empty">No matching memories.</div>'; return; }
            box.innerHTML = results.map(m => {
              const sector = (m.sector || m.metadata?.sector || '?');
              const sl = sector.charAt(0).toUpperCase() + sector.slice(1);
              const score = typeof m.score === 'number' ? m.score.toFixed(3) : '';
              return '<div class="mem"><div>'+escapeHtml(m.content)+'</div>'
                + '<div class="meta"><span class="pill">'+sl+'</span>'+(score?'score '+score:'')+'</div></div>';
            }).join('');
          }

          function renderInsights(data) {
            const s = data.stats || {};
            $('totM').textContent = s.total_memories ?? '–';
            $('genM').textContent = s.genome_count ?? '–';
            $('pheM').textContent = s.phenotype_count ?? '–';
            const sectors = s.by_sector || {};
            const max = Math.max(1, ...Object.values(sectors).map(Number));
            const barBox = $('sectorBars');
            const keys = Object.keys(sectors);
            const palette = ['#4caf50','#2196f3','#9c27b0','#ff9800','#e91e63','#00bcd4','#8bc34a','#ff5722'];
            barBox.innerHTML = keys.length ? keys.map((k, i) => {
              const n = Number(sectors[k]); const pct = Math.round((n/max)*100);
              const color = palette[i % palette.length];
              return '<div class="bar"><span style="width:90px;text-transform:capitalize">'+k+'</span>'
                + '<span class="track"><span class="fill" style="width:'+pct+'%;--bar-color:'+color+'" data-sector="'+k+'"></span></span>'
                + '<span class="count">'+n+'</span></div>';
            }).join('') : '<div class="empty">No sector data.</div>';
            const mems = data.memories || [];
            $('recentMems').innerHTML = mems.length ? mems.slice(0,15).map(m => {
              const sector = (m.sector || '?');
              const sl = sector.charAt(0).toUpperCase() + sector.slice(1);
              const isG = m.is_genome ? ' genome' : '';
              const gtag = m.is_genome ? '<span class="pill genome">Genome</span>' : '';
              return '<div class="mem"><div>'+escapeHtml(m.content)+'</div>'
                + '<div class="meta">'+gtag+'<span class="pill">'+sl+'</span>'+(m.recorded_at?new Date(m.recorded_at).toLocaleDateString():'')+'</div></div>';
            }).join('') : '<div class="empty">No memories found.</div>';
          }

          function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
          }

          window.addEventListener('message', (ev) => {
            const m = ev.data;
            if (!m || !m.command) return;
            if (m.command === 'ftr10VarsUpdate') { applyFtr10Vars(m.vars); return; }
            if (m.command === 'activity') renderActivity(m);
            else if (m.command === 'recallResult') renderRecall(m);
            else if (m.command === 'insights') renderInsights(m);
            else if (m.command === 'switchView') {
              const tab = document.querySelector('.tab[data-view="' + m.view + '"]');
              if (tab) tab.click();
            }
          });

          vscode.postMessage({ command: 'requestActivity' });
        </script>
      </body>
      </html>`.replace('{{FTR10_VARS_JSON}}', ftr10VarsJson);
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
