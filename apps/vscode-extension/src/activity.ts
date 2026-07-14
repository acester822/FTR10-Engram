import * as vscode from 'vscode';

/**
 * ActivityObserver — a passive observer of Engram's server-side memory
 * traffic buffer (GET /api/dashboard/activity).
 *
 * It does NOT instrument this extension's own calls. It polls the backend's
 * in-memory ring buffer, which captures EVERY inbound request — whether made
 * by this extension's @cortex participant, by the Hermes engram plugin
 * (prefetch -> /recall, sync_turn -> /ingest/conversation), the web GUI, or
 * curl. Because it observes the server, the same notifications surface whether
 * Engram is driven standalone or as Hermes's memory sidecar.
 *
 * Emits:
 *  - a live status-bar count (injected ↓ / saved ↑)
 *  - throttled toast popups on *saved* / consolidation events
 *  - postMessage updates to the Engram Dashboard webview (live IN/OUT feed)
 */

export interface ActivityBreakdown {
  genome: number;
  phenotype: number;
  sectors: Record<string, number>;
}

export interface ActivityEntry {
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
  breakdown?: ActivityBreakdown;
  user_id?: string;
}

export interface ActivityResponse {
  success: boolean;
  total: number;
  incoming: number;
  outgoing: number;
  entries: ActivityEntry[];
}

type WebviewLike = {
  postMessage: (msg: any) => Thenable<boolean>;
  webview?: { postMessage: (msg: any) => Thenable<boolean> };
};

const POLL_MS = 2500;
const TOAST_COOLDOWN_MS = 4000; // avoid toast spam when many saves happen at once

function getHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

function formatBreakdown(b?: ActivityBreakdown): string {
  if (!b) return '';
  const parts: string[] = [];
  if (b.genome > 0) parts.push(`${b.genome} Genome`);
  if (b.phenotype > 0) parts.push(`${b.phenotype} Phenotype`);
  if (parts.length === 0 && Object.keys(b.sectors).length === 0) return '';
  const sec = Object.entries(b.sectors)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s[0].toUpperCase() + s.slice(1)}`)
    .join(' + ');
  if (sec) parts.push(sec);
  return parts.join(' + ');
}

export class ActivityObserver {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTs = 0;
  private lastToastAt = 0;
  private statusBar: vscode.StatusBarItem | undefined;

  constructor(
    private backendUrl: string,
    private apiKey?: string,
    private statusBarItem?: vscode.StatusBarItem,
    private getWebview?: () => WebviewLike | undefined,
    private shouldToast?: () => boolean,
  ) {
    this.statusBar = statusBarItem;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    // Immediate first poll so the UI reflects state right away.
    void this.poll();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll() {
    const url = `${this.backendUrl}/api/dashboard/activity`;
    let data: ActivityResponse | undefined;
    try {
      const res = await fetch(url, { method: 'GET', headers: getHeaders(this.apiKey) });
      if (!res.ok) return;
      data = (await res.json()) as ActivityResponse;
    } catch {
      return; // backend down — stay silent, next poll retries
    }
    if (!data || !Array.isArray(data.entries)) return;

    const fresh = data.entries.filter((e) => e.ts > this.lastTs);
    if (data.entries.length && data.entries[0].ts > this.lastTs) {
      this.lastTs = data.entries[0].ts;
    }

    // Push the full feed to the webview (live dashboard).
    const panel = this.getWebview?.();
    if (panel) {
      panel.postMessage({ command: 'activity', ...data });
    }

    if (fresh.length === 0) return;

    // Status-bar live count: most recent injected (out) vs saved (in).
    let injectedSummary = '';
    let savedSummary = '';
    for (const e of fresh) {
      const txt = formatBreakdown(e.breakdown);
      if (e.direction === 'out') {
        injectedSummary = txt || `${e.count ?? ''} recalled`.trim();
      } else if (e.label === 'ingest' || e.label === 'remember') {
        savedSummary = txt || `${e.count ?? ''} saved`.trim();
      }
    }
    this.updateStatusBar(injectedSummary, savedSummary);

    // Toast on a *new save* event (only), throttled.
    const newSave = fresh.find(
      (e) => e.direction === 'in' && (e.label === 'ingest' || e.label === 'remember'),
    );
    if (newSave) {
      const now = Date.now();
      const enabled = this.shouldToast ? this.shouldToast() : true;
      if (enabled && now - this.lastToastAt > TOAST_COOLDOWN_MS) {
        this.lastToastAt = now;
        const detail = formatBreakdown(newSave.breakdown);
        if (detail) {
          vscode.window.showInformationMessage(
            `🧠 Engram: ${detail} saved from this interaction`,
          );
        }
      }
    }
  }

  private updateStatusBar(injected: string, saved: string) {
    if (!this.statusBar) return;
    const parts: string[] = [];
    if (injected) parts.push(`${injected} ↓`);
    if (saved) parts.push(`${saved} ↑`);
    const label = parts.length ? `🧠 ${parts.join(' · ')}` : `$(pulse) Engram`;
    this.statusBar.text = label;
    this.statusBar.tooltip = 'Engram: live memory activity (server-side)';
  }
}
