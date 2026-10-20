/**
 * workspace.json registry + filesystem safety helpers.
 * @module workspace
 */
import fs from 'node:fs';
import path from 'node:path';
import { uuid5 } from './format.mjs';

const nowIso = () => new Date().toISOString();

/** Load an existing workspace.json, or a fresh empty document. */
export function loadWorkspaceJson(file) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fall through */ }
  }
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: null },
    tables: { workspaces: {} },
  };
}

function normalize(ws) {
  ws.global ||= {};
  ws.global.workspaceIds ||= [];
  ws.global.archivedSessionIds ||= [];
  ws.global.pinnedSessionIds ||= [];
  ws.tables ||= {};
  ws.tables.workspaces ||= {};
  return ws;
}

/**
 * Ensure a workspace exists for `cwd` and reference one session in it.
 * @returns {string} the workspace id
 */
export function ensureWorkspace(ws, cwd, title, sid) {
  normalize(ws);
  let wid = Object.keys(ws.tables.workspaces).find((k) => ws.tables.workspaces[k].path === cwd);
  if (!wid) {
    wid = uuid5('cwd:' + cwd);
    ws.tables.workspaces[wid] = {
      path: cwd,
      title: title || path.basename(cwd.replace(/[\\/]+$/, '')) || 'workspace',
      sessionIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (!ws.global.workspaceIds.includes(wid)) ws.global.workspaceIds.push(wid);
    if (!ws.global.defaultWorkspaceId) ws.global.defaultWorkspaceId = wid;
  }
  const w = ws.tables.workspaces[wid];
  const ref = `session-${sid}`;
  if (!w.sessionIds.includes(ref)) {
    w.sessionIds.push(ref);
    w.updatedAt = nowIso();
  }
  return wid;
}

export function saveWorkspaceJson(file, ws) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ws, null, 2), 'utf8');
}

/** True if a DSH web instance answers on a default port. */
export async function isDshRunning() {
  for (const port of [3080, 3081]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
      clearTimeout(timer);
      return true; // any HTTP answer means something is listening
    } catch { /* not listening */ }
  }
  return false;
}

/** Copy sessions + storages into a timestamped backup folder. */
export function backupDsh(dshHome, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const dest = path.join(dshHome, 'backups', `wb2dsh-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['sessions', 'storages']) {
    const src = path.join(dshHome, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, name), { recursive: true });
  }
  return dest;
}
