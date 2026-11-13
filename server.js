#!/usr/bin/env node
// Multica Squad Board — local-only server.
// Reads/writes through the `multica` CLI, so credentials never leave ~/.multica.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4177);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const CLI = process.env.MULTICA_CLI || 'multica';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function runCli(args, { input, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`multica ${args[0]} timed out`));
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ${CLI}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `multica exited with code ${code}`));
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function cliJson(args, opts) {
  const raw = await runCli([...args, '--output', 'json'], opts);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`multica ${args.join(' ')} 返回了非 JSON 内容`);
  }
}

const wsArgs = (workspaceId) => (workspaceId ? ['--workspace-id', workspaceId] : []);
const doneStatuses = new Set(['done', 'canceled', 'cancelled', 'archived']);
const isOpen = (s) => !doneStatuses.has(String(s || '').toLowerCase());
const isActive = (s) => String(s || '').toLowerCase() === 'in_progress';

function countByAssignee(issues) {
  const map = new Map();
  for (const issue of issues) {
    if (!issue.assignee_id) continue;
    const key = `${issue.assignee_type}:${issue.assignee_id}`;
    const entry = map.get(key) || { open: 0, active: 0 };
    if (isOpen(issue.status)) entry.open += 1;
    if (isActive(issue.status)) entry.active += 1;
    map.set(key, entry);
  }
  return map;
}

let appUrlCache;
async function getAppUrl() {
  if (appUrlCache !== undefined) return appUrlCache;
  try {
    const raw = await runCli(['config', 'show']);
    const line = raw.split('\n').find((l) => l.trim().startsWith('app_url:'));
    appUrlCache = line ? line.split('app_url:')[1].trim().replace(/\/$/, '') : '';
  } catch {
    appUrlCache = '';
  }
  return appUrlCache;
}

async function getOverview(workspaceId) {
  const [squadsRaw, agentsRaw, issuesRaw, runtimesRaw] = await Promise.all([
    cliJson(['squad', 'list', ...wsArgs(workspaceId)]),
    cliJson(['agent', 'list', ...wsArgs(workspaceId)]),
    cliJson(['issue', 'list', '--limit', '200', ...wsArgs(workspaceId)]),
    cliJson(['runtime', 'list', ...wsArgs(workspaceId)]).catch(() => []),
  ]);

  const issues = Array.isArray(issuesRaw) ? issuesRaw : issuesRaw.issues || [];
  const counts = countByAssignee(issues);
  const runtimeById = new Map(
    (runtimesRaw || []).map((r) => [
      r.id,
      {
        name: r.custom_name || r.device_info || r.name || 'runtime',
        lastSeenAt: r.last_seen_at || null,
        status: r.status || r.state || '',
      },
    ]),
  );

  const agents = (agentsRaw || [])
    .filter((a) => !a.archived_at)
    .map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description || '',
      model: a.model || '',
      status: a.status || 'idle',
      avatarUrl: a.avatar_url || '',
      runtimeMode: a.runtime_mode || '',
      runtime: runtimeById.get(a.runtime_id) || null,
      updatedAt: a.updated_at,
      openIssues: counts.get(`agent:${a.id}`)?.open || 0,
      activeIssues: counts.get(`agent:${a.id}`)?.active || 0,
    }));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const squads = await Promise.all(
    (squadsRaw || [])
      .filter((s) => !s.archived_at)
      .map(async (s) => {
        const membersRaw = await cliJson(['squad', 'member', 'list', s.id, ...wsArgs(workspaceId)]).catch(() => []);
        const members = (membersRaw || []).map((m) => ({
          memberId: m.member_id,
          type: m.member_type,
          role: m.role || '',
          isLeader: m.role === 'leader',
          agent: m.member_type === 'agent' ? agentById.get(m.member_id) || null : null,
        }));
        members.sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
        return {
          id: s.id,
          name: s.name,
          description: s.description || '',
          members,
          openIssues: counts.get(`squad:${s.id}`)?.open || 0,
          activeIssues: counts.get(`squad:${s.id}`)?.active || 0,
        };
      }),
  );

  const recentIssues = issues
    .filter((i) => isOpen(i.status))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 12)
    .map((i) => ({
      id: i.id,
      identifier: i.identifier || '',
      title: i.title,
      status: i.status,
      assigneeType: i.assignee_type,
      assigneeId: i.assignee_id,
      updatedAt: i.updated_at,
    }));

  return {
    squads,
    agents,
    recentIssues,
    appUrl: await getAppUrl(),
    generatedAt: new Date().toISOString(),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(body);
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  if (rel.startsWith('..')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const file = join(PUBLIC_DIR, rel);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const overviewCache = new Map();
const OVERVIEW_TTL = 8000;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/workspaces') {
      sendJson(res, 200, await cliJson(['workspace', 'list']));
      return;
    }
    if (url.pathname === '/api/overview') {
      const workspaceId = url.searchParams.get('workspace') || '';
      const refresh = url.searchParams.has('refresh');
      const cached = overviewCache.get(workspaceId);
      if (!refresh && cached && Date.now() - cached.at < OVERVIEW_TTL) {
        sendJson(res, 200, cached.data);
        return;
      }
      const data = await getOverview(workspaceId);
      overviewCache.set(workspaceId, { at: Date.now(), data });
      sendJson(res, 200, data);
      return;
    }
    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) throw new Error('请求体过大');
      }
      const { workspaceId, title, description = '', assigneeId } = JSON.parse(body || '{}');
      if (!title || !String(title).trim()) throw new Error('标题不能为空');
      if (!assigneeId) throw new Error('请选择指派对象');
      const args = [
        'issue', 'create',
        '--title', String(title).trim(),
        '--assignee-id', assigneeId,
        ...wsArgs(workspaceId),
        '--output', 'json',
      ];
      const desc = String(description || '');
      if (desc.trim()) args.push('--description-stdin');
      const created = JSON.parse(await runCli(args, { input: desc }));
      overviewCache.clear();
      sendJson(res, 200, { ok: true, issue: created });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'unknown endpoint' });
      return;
    }
    await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err).slice(0, 600) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Multica Squad Board  →  http://${HOST}:${PORT}`);
  console.log('仅监听本机回环地址；凭证由 multica CLI 管理，请勿将端口暴露到公网。');
});
