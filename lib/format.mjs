/**
 * DSH (DeepSeek Harness) session format writer.
 *
 * Produces v4 session logs that DSH renders natively:
 *   - zstd multi-frame: frame #0 holds exactly one header line, later frames hold events.
 *   - project path layout: <root>/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd
 *   - surface events carry `surfaceOp: "append"`; every `turn/end` carries a `reason`.
 *
 * @module format
 */
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const zstdCompress = promisify(zlib.zstdCompress);
const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/** Fixed namespace for deterministic, idempotent session IDs. */
const UUID_NS = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Deterministic UUIDv5 from a name, so re-running the importer is idempotent. */
export function uuid5(name) {
  const ns = Buffer.from(UUID_NS.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Encode a cwd into DSH's project directory name.
 * Filesystem separators collapse to `-`; any other unsafe code unit is escaped as `~XXXX`.
 */
export function projectKey(cwd) {
  if (!cwd) throw new Error('projectKey: empty cwd');
  let out = '';
  let sepRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sepRun) out += '-';
      sepRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
      sepRun = false;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      sepRun = false;
    }
  }
  return `--${(out.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** Encode one path segment (session id) the same way DSH does. */
export function encodeSegment(raw) {
  if (!raw) throw new Error('encodeSegment: empty segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Turn a WorkBuddy/Claude content block into a render-safe DSH block. */
function toDshBlock(block) {
  if (!block || typeof block !== 'object') return { type: 'text', text: String(block ?? '') };
  if (block.type === 'text' || block.type === 'reasoning') return block;
  if (block.type === 'tool_use' || block.type === 'tool-call') {
    const input = block.input ?? block.arguments ?? {};
    const body = typeof input === 'string' ? input : JSON.stringify(input);
    return { type: 'text', text: `【调用工具 ${block.name || ''}】\n${body}` };
  }
  if (block.type === 'tool_result' || block.type === 'tool-result') {
    const c = block.content ?? '';
    return { type: 'text', text: `【工具结果】\n${typeof c === 'string' ? c : JSON.stringify(c)}` };
  }
  return { type: 'text', text: JSON.stringify(block) };
}

/** Build the assistant replay stream for one message. */
function assistantStream(blocks, baseTime, usage, replayState) {
  const stream = [];
  let t = baseTime;
  blocks.forEach((b, i) => {
    stream.push({ type: 'chunk', time: t, chunk: { type: 'block-start', index: i, blockType: b.type } });
    if (b.type === 'text' || b.type === 'reasoning') {
      stream.push({ type: b.type === 'reasoning' ? 'reasoning-chunks' : 'text-chunks', time0: t, index: i, dt: [0], texts: [b.text ?? ''] });
      stream.push({ type: 'chunk', time: t, chunk: { type: 'block-end', index: i, block: { type: b.type, text: b.text ?? '' } } });
    }
  });
  stream.push({ type: 'chunk', time: t, chunk: { type: 'usage', usage } });
  stream.push({ type: 'chunk', time: t, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState } });
  return stream;
}

/**
 * Build one v4 session.
 * @param {object} p
 * @param {string} p.cwd       Working directory (workspace path).
 * @param {string} p.title     Session title.
 * @param {string} p.sid       Session UUID (without the `session-` prefix).
 * @param {Array}  p.turns     [{ user: blocks[], assistant: blocks[], ts }]
 * @param {string} p.provider  Model provider id.
 * @param {string} p.model     Model id.
 * @returns {{header:object, events:object[]}}
 */
export function buildSession({ cwd, title, sid, turns, provider, model }) {
  const base = turns.find((x) => x.ts)?.ts || Date.now();
  let seq = 0;
  let time = base;
  const events = [];
  const push = (type, data, extra = {}) => {
    events.push({ type, seq: seq++, time: time++, data, ...extra });
  };

  const header = {
    type: 'session', version: 4, id: `session-${sid}`, createdAt: base,
    cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  };

  push('permission/preset', { preset: 'workspace-write' });
  push('sandbox/mode', { mode: 'workspace-write' });
  push('session/end-seed', {});
  push('model/selection', { provider, model });

  let turn = 0;
  let firstUserSeq = null;

  for (const t of turns) {
    const userBlocks = (t.user || []).map(toDshBlock);
    const asstBlocks = (t.assistant || []).map(toDshBlock);
    if (asstBlocks.length === 0 && userBlocks.length === 0) continue;
    turn++;
    if (t.ts) time = Math.max(time, t.ts);

    push('turn/start', { turn });
    if (userBlocks.length > 0) {
      const uSeq = seq;
      push('user/message', {
        content: userBlocks,
        source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
        role: 'user',
        id: randomUUID(),
      }, { surfaceOp: 'append' });
      if (firstUserSeq === null) firstUserSeq = uSeq;
    }
    push('step/start', { turn, step: 1 });

    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const replayState = {
      response: {
        kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider, model,
        responseModel: model, responseId: randomUUID(), stopReason: 'stop',
      },
      blocks: asstBlocks.map((b) => ({ type: b.type })),
    };
    const stream = assistantStream(asstBlocks, time, usage, replayState);
    push('assistant/message', {
      turn, step: 1,
      message: {
        role: 'assistant',
        content: asstBlocks,
        source: { kind: 'model', provider, model, replayState },
        id: randomUUID(),
      },
      usage, stream,
    }, { surfaceOp: 'append' });

    push('assistant/attempt', {
      turn, step: 1,
      stream: [
        { type: 'chunk', time, chunk: { type: 'usage', usage } },
        { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState } },
      ],
    });

    push('step/end', { turn, step: 1 });
    push('turn/end', { turn, reason: { kind: 'completed' } });
  }

  push('session/title', {
    title: title || '未命名会话',
    messageSeqs: firstUserSeq !== null ? [firstUserSeq] : [],
    source: { kind: 'fallback' },
  });

  return { header, events };
}

/** Split a buffer into zstd frames (used only for validation). */
export function frameCount(buf) {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { n++; i += 4; }
  return n;
}

/**
 * Serialize a session into DSH's multi-frame zstd layout.
 * Frame #0 = the header line; frame #1 = the remaining event lines.
 * @returns {Promise<Buffer>}
 */
export async function toZstdArtifact(header, events) {
  const headerText = JSON.stringify(header) + '\n';
  const bodyText = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const frame0 = await zstdCompress(Buffer.from(headerText, 'utf8'), ZSTD_OPTS);
  const frame1 = await zstdCompress(Buffer.from(bodyText, 'utf8'), ZSTD_OPTS);
  return Buffer.concat([frame0, frame1]);
}

/** Sanity check the produced artifact against DSH's reader expectations. */
export function validateArtifact(buf) {
  if (frameCount(buf) < 2) throw new Error('artifact must contain at least 2 zstd frames');
  const first = zlib.zstdDecompressSync(buf).toString('utf8');
  if (!first.endsWith('\n') || first.indexOf('\n') !== first.length - 1) {
    throw new Error('frame #0 must contain exactly one header line');
  }
  JSON.parse(first.slice(0, -1));
}
