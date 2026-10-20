/**
 * Parsers for chat-history sources that share the Claude-Code JSONL lineage:
 *   - WorkBuddy (CN / INTL):  ~/.workbuddy{,-ai}/projects/<project>/<session>.jsonl
 *   - Claude Code:            ~/.claude/projects/<project>/<session>.jsonl
 *
 * Every parser returns the same canonical shape:
 *   { cwd, title, turns: [{ user: Block[], assistant: Block[], ts }] }
 * where a Block is one of { type:'text'|'reasoning', text } /
 * { type:'tool_use', id, name, input } / { type:'tool_result', tool_use_id, content }.
 *
 * @module parse
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;
const SYSTEM_REMINDER = /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g;

function blocksText(blocks) {
  if (typeof blocks === 'string') return blocks;
  const out = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'image_blob_ref' || b.type === 'image') out.push('[image]');
  }
  return out.join('\n').trim();
}

function cleanUserText(text) {
  const m = USER_QUERY.exec(text);
  if (m) return m[1].trim();
  return text.replace(SYSTEM_REMINDER, '').trim();
}

function toolResultText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return blocksText(output);
  if (output && typeof output === 'object') return JSON.stringify(output);
  return '';
}

/** Parse one session file (auto-detects WorkBuddy vs Claude Code line shape). */
export function parseSessionFile(file) {
  const items = []; // { side, block } | { side:'user', text } ...
  let cwd = null;
  let title = null;
  let firstTs = 0;

  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }

    if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
    if (o.timestamp && !firstTs) firstTs = o.timestamp;
    const ts = o.timestamp || o.message?.timestamp || 0;

    const type = o.type;

    // ---- WorkBuddy shape ----
    if (type === 'ai-title') { title = o.title || o.text || title; continue; }
    if (type === 'message') {
      const role = o.role;
      const txt = blocksText(o.content);
      if (role === 'user') {
        const t = cleanUserText(txt);
        if (t) items.push({ side: 'user', block: { type: 'text', text: t }, ts });
      } else if (role === 'assistant') {
        const pd = o.providerData || {};
        if (pd.error || /使用量已超出频率限制/.test(txt)) continue;
        if (txt) items.push({ side: 'assistant', block: { type: 'text', text: txt }, ts });
      }
      continue;
    }
    if (type === 'function_call') {
      let input;
      try { input = JSON.parse(o.arguments || '{}'); } catch { input = { raw: o.arguments }; }
      items.push({ side: 'assistant', block: { type: 'tool_use', id: o.callId || ('toolu_' + Math.random().toString(36).slice(2)), name: o.name || 'unknown', input }, ts });
      continue;
    }
    if (type === 'function_call_result') {
      items.push({ side: 'user', block: { type: 'tool_result', tool_use_id: o.callId || o.parentId || '', content: toolResultText(o.output) }, ts });
      continue;
    }

    // ---- Claude Code shape ----
    if (type === 'user' || type === 'assistant') {
      const msg = o.message || {};
      const content = msg.content;
      if (typeof content === 'string') {
        const t = type === 'user' ? cleanUserText(content) : content.trim();
        if (t) items.push({ side: type, block: { type: 'text', text: t }, ts });
        continue;
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          const t = type === 'user' ? cleanUserText(b.text || '') : (b.text || '').trim();
          if (t) items.push({ side: type, block: { type: 'text', text: t }, ts });
        } else if (b.type === 'tool_use') {
          items.push({ side: 'assistant', block: { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }, ts });
        } else if (b.type === 'tool_result') {
          items.push({ side: 'user', block: { type: 'tool_result', tool_use_id: b.tool_use_id, content: toolResultText(b.content) }, ts });
        }
      }
      continue;
    }
    // other Claude Code lines (summary, file-history-snapshot, ...) are ignored
  }

  if (items.length === 0) return null;
  if (!cwd) cwd = 'C:\\Users\\WorkBuddy';
  if (/^[a-z]:/.test(cwd)) cwd = cwd[0].toUpperCase() + cwd.slice(1);

  // Merge consecutive same-side items, then pair into turns.
  const messages = [];
  for (const it of items) {
    const last = messages[messages.length - 1];
    if (last && last.side === it.side) last.blocks.push(it.block);
    else messages.push({ side: it.side, blocks: [it.block], ts: it.ts });
  }

  const turns = [];
  let pending = null;
  for (const m of messages) {
    if (m.side === 'user') {
      if (pending) pending.blocks.push(...m.blocks);
      else pending = { blocks: [...m.blocks], ts: m.ts };
    } else {
      turns.push({ user: pending ? pending.blocks : [], assistant: m.blocks, ts: m.ts || pending?.ts || firstTs });
      pending = null;
    }
  }
  if (pending) turns.push({ user: pending.blocks, assistant: [], ts: pending.ts || firstTs });

  if (!title) {
    const firstUser = turns.flatMap((t) => t.user).find((b) => b.type === 'text');
    title = ((firstUser?.text || '').slice(0, 60).replace(/\n/g, ' ')) || path.basename(file, '.jsonl');
  }
  return { cwd, title, turns };
}

/** Resolve default source roots for the current user. */
export function defaultSources() {
  const home = os.homedir();
  return [
    { id: 'workbuddy-cn', dir: path.join(home, '.workbuddy', 'projects') },
    { id: 'workbuddy-intl', dir: path.join(home, '.workbuddy-ai', 'projects') },
    { id: 'claude-code', dir: path.join(home, '.claude', 'projects') },
  ];
}

/** Yield every parsed session across the given source roots. */
export function* scanSources(sources) {
  for (const src of sources) {
    if (!fs.existsSync(src.dir)) continue;
    for (const project of fs.readdirSync(src.dir)) {
      const pdir = path.join(src.dir, project);
      if (!fs.statSync(pdir).isDirectory()) continue;
      for (const name of fs.readdirSync(pdir)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(pdir, name);
        const parsed = parseSessionFile(file);
        if (!parsed) continue;
        yield { source: src.id, file, origId: path.basename(name, '.jsonl'), ...parsed };
      }
    }
  }
}
