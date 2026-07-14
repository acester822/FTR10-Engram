#!/usr/bin/env node
/*
 - filename
 - what is the file used for
*/

const fs = require('fs');
const path = require('path');

// load .env from root
const loadenv = () => {
  const envp = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envp)) return;
  const lns = fs.readFileSync(envp, 'utf8').split('\n');
  for (const ln of lns) {
    const trim = ln.trim();
    if (!trim || trim.startsWith('#')) continue;
    const m = trim.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
};
loadenv();

const port = process.env.EG_PORT || '8080';
// CLI targets the Engram API port. Respect explicit OPENMEMORY_URL; otherwise
// default to the canonical API port 8098 (Docker exposes 8098; dev proxy 8080).
let url = process.env.OPENMEMORY_URL || `http://localhost:${port}`;
if (!process.env.OPENMEMORY_URL && port !== '8098') {
  url = 'http://localhost:8098';
}
let key = process.env.OPENMEMORY_API_KEY || process.env.EG_API_KEY || '';
const bin = path.basename(process.argv[1] || 'engram');
const helptext = `

${bin} cli

usage: ${bin} <command> [options]

commands:
  watch [--interval N] [--once] [--json]   live activity feed (IN/OUT memory ops)
  add <text>            add memory
  query <text>          search memories
  list                  show all memories
  delete <id>           delete memory
  health                ping server
  mcp                   start mcp server (stdio)
  serve                 start api server

options:
  --user <id>           user id
  --tags <t1,t2>        comma tags
  --limit <n>           result limit (default: 10)
  --interval <n>        watch poll seconds (default: 2)
  --once                watch: dump current snapshot and exit
  --json                watch: raw json output (with --once)
  --url <url>           override server url
  --api-key <key>       override api key
  -h, --help            show help

env vars:
  OPENMEMORY_URL        api url (default: http://localhost:8080)
  OPENMEMORY_API_KEY    auth key
  EG_API_KEY            alt auth key

examples:
  ${bin} watch
  ${bin} watch --interval 5
  ${bin} watch --once --json
  ${bin} add "user likes dark mode" --user u123 --tags prefs
  ${bin} query "preferences" --user u123
  ${bin} list --limit 5
`;

const req = async (pth, opts = {}) => {
  const target = `${url}${pth}`;
  const hdrs = {
    'content-type': 'application/json',
    ...(key && { authorization: `Bearer ${key}` }),
  };
  try {
    const res = await fetch(target, {
      ...opts,
      headers: { ...hdrs, ...opts.headers },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => 'no response');
      throw new Error(`http ${res.status}: ${txt}`);
    }
    return await res.json();
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
};

const addmem = async (txt, opts) => {
  const body = { content: txt };
  if (opts.usr) body.user_id = opts.usr;
  if (opts.tags) body.facets = { tags: opts.tags.split(',') };
  const r = await req('/memories', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  console.log('[ok] memory added');
  console.log(`id: ${r.id || r.memory_id}`);
  if (r.status) console.log(`status: ${r.status}`);
};

const querymem = async (txt, opts) => {
  const body = { query: txt, limit: opts.lim || 10 };
  if (opts.usr) body.user_id = opts.usr;
  const r = await req('/recall', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const memories = r.results || [];
  console.log(`[results] ${memories.length} found\n`);
  memories.forEach((m, i) => {
    console.log(`${i + 1}. ${m.content}`);
    console.log(`   id: ${m.id || m.memory_id}`);
    if (typeof m.score === 'number') console.log(`   score: ${m.score.toFixed(3)}`);
    if (m.facets?.tags) console.log(`   tags: ${m.facets.tags.join(',')}`);
    console.log();
  });
};

const listmem = async (opts) => {
  const lim = opts.lim || 10;
  const params = new URLSearchParams({ limit: String(lim), offset: '0' });
  if (opts.usr) params.set('user_id', opts.usr);
  const r = await req(`/memories?${params.toString()}`);
  const items = r.items || [];
  console.log(`[memories] showing ${items.length}\n`);
  items.forEach((m, i) => {
    console.log(`${i + 1}. ${m.content}`);
    console.log(`   id: ${m.id} | user: ${m.user_id || opts.usr || 'system'}`);
    if (typeof m.salience === 'number') console.log(`   salience: ${m.salience.toFixed(3)}`);
    if (m.facets?.tags) console.log(`   tags: ${m.facets.tags.join(',')}`);
    console.log();
  });
};

const delmem = async (id, opts) => {
  const params = new URLSearchParams();
  if (opts.usr) params.set('user_id', opts.usr);
  const suffix = params.size ? `?${params.toString()}` : '';
  await req(`/memories/${id}${suffix}`, { method: 'DELETE' });
  console.log(`[ok] memory ${id} deleted`);
};

const health = async () => {
  const r = await req('/health');
  console.log(`[health] ${r.ok ? 'ok' : r.status || 'unknown'}`);
  if (r.version) console.log(`version: ${r.version}`);
  if (r.uptime) console.log(`uptime: ${Math.floor(r.uptime / 1000)}s`);
};

// ── watch: live activity feed (IN = saved, OUT = recalled) ──────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', blue: '\x1b[34m', red: '\x1b[31m',
  dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};
const hasColor = process.stdout.isTTY !== false;
const c = (code, s) => (hasColor ? code + s + C.reset : s);

const fmtBreakdown = (b) => {
  if (!b) return '';
  const parts = [];
  if (b.genome > 0) parts.push(`${b.genome} Genome`);
  if (b.phenotype > 0) parts.push(`${b.phenotype} Phenotype`);
  const sec = Object.entries(b.sectors || {})
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s[0].toUpperCase() + s.slice(1)}`)
    .join(' + ');
  if (sec) parts.push(sec);
  return parts.join(' + ');
};

const renderSnapshot = (data) => {
  const t = (ts) => new Date(ts).toLocaleTimeString();
  console.log(
    c(C.bold, `\n=== Engram activity  `) +
      c(C.green, `IN ${data.incoming}`) + '  ' +
      c(C.blue, `OUT ${data.outgoing}`) + '  ' +
      c(C.dim, `total ${data.total}`),
  );
  const entries = (data.entries || []).slice(0, 25);
  if (!entries.length) {
    console.log(c(C.dim, '  (no activity yet — make a request to /recall or /ingest/conversation)'));
    return;
  }
  for (const e of entries) {
    const isIn = e.direction === 'in';
    const tag = isIn ? c(C.green, 'SAVED') : c(C.blue, 'RECALL');
    const detail = fmtBreakdown(e.breakdown) || (e.summary ? e.summary.slice(0, 70) : '');
    const status = e.status ? c(C.dim, `${e.status}`) : '';
    const ms = e.ms ? c(C.dim, `${e.ms}ms`) : '';
    console.log(
      `  ${tag} ${c(C.dim, t(e.ts))} ${c(C.cyan, e.route)} ${status} ${ms}  ${detail}`,
    );
  }
};

const watch = async (opts) => {
  const intervalMs = Math.max(1, (opts.interval || 2)) * 1000;
  const baseReq = () => req('/api/dashboard/activity');

  if (opts.once) {
    const data = await baseReq();
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      renderSnapshot(data);
    }
    return;
  }

  console.log(c(C.bold, `Engram watch — polling ${url}/api/dashboard/activity every ${intervalMs / 1000}s (Ctrl+C to stop)`));
  let lastTs = 0;
  let first = true;
  const tick = async () => {
    let data;
    try {
      data = await baseReq();
    } catch (e) {
      process.stdout.write(c(C.red, `\r[error] ${e.message} — retrying…`));
      return;
    }
    if (first) {
      lastTs = data.entries.length ? data.entries[0].ts : 0;
      renderSnapshot(data);
      first = false;
      return;
    }
    const fresh = (data.entries || []).filter((e) => e.ts > lastTs);
    if (data.entries.length) lastTs = data.entries[0].ts;
    for (const e of fresh) {
      const isIn = e.direction === 'in';
      const tag = isIn ? c(C.green, 'SAVED ') : c(C.blue, 'RECALL');
      const detail = fmtBreakdown(e.breakdown) || (e.summary ? e.summary.slice(0, 70) : '');
      const status = e.status ? c(C.dim, ` ${e.status}`) : '';
      const ms = e.ms ? c(C.dim, ` ${e.ms}ms`) : '';
      const t = new Date(e.ts).toLocaleTimeString();
      console.log(`${tag} ${c(C.dim, t)} ${c(C.cyan, e.route)}${status}${ms}  ${detail}`);
    }
  };
  await tick();
  const id = setInterval(tick, intervalMs);
  process.on('SIGINT', () => {
    clearInterval(id);
    console.log(c(C.dim, '\n[watch stopped]'));
    process.exit(0);
  });
};

// parse args
const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(helptext);
  process.exit(0);
}

const opts = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--user') opts.usr = argv[++i];
  else if (argv[i] === '--tags') opts.tags = argv[++i];
  else if (argv[i] === '--limit') opts.lim = parseInt(argv[++i]);
  else if (argv[i] === '--interval') opts.interval = parseInt(argv[++i]);
  else if (argv[i] === '--once') opts.once = true;
  else if (argv[i] === '--json') opts.json = true;
  else if (argv[i] === '--url') url = argv[++i];
  else if (argv[i] === '--api-key') key = argv[++i];
}

const commandText = () => {
  const optionStart = argv.findIndex((arg, index) => index > 0 && arg.startsWith('--'));
  const end = optionStart === -1 ? argv.length : optionStart;
  return argv.slice(1, end).join(' ');
};
const text = commandText();

// run command
(async () => {
  try {
    switch (cmd) {
      case 'add':
        if (!text) throw new Error('content required: opm add "text"');
        await addmem(text, opts);
        break;
      case 'query':
        if (!text) throw new Error('query text required: opm query "text"');
        await querymem(text, opts);
        break;
      case 'list':
        await listmem(opts);
        break;
      case 'delete':
        if (!argv[1]) throw new Error('id required: opm delete <id>');
        await delmem(argv[1], opts);
        break;
      case 'health':
        await health();
        break;
      case 'watch':
        await watch(opts);
        break;
      case 'mcp':
        try {
          const mcp = require('../dist/mcp/server.js');
          if (!mcp.startMcpStdio) throw new Error('missing startMcpStdio export');
          await mcp.startMcpStdio({ base_url: url, api_key: key });
        } catch (e) {
          console.error(
            '[error] failed to start mcp server. ensure project is built and @modelcontextprotocol/sdk is installed.',
          );
          console.error(e.message);
          process.exit(1);
        }
        break;
      case 'serve':
        try {
          console.log('[opm] passing control to server...');
          require('../dist/server.js');
        } catch (e) {
          console.error(
            '[error] failed to start server. ensure project is built (npm run build).',
          );
          console.error(e.message);
          process.exit(1);
        }
        break;
      default:
        console.error(`[error] unknown command: ${cmd}`);
        console.log(helptext);
        process.exit(1);
    }
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
})();
