#!/usr/bin/env node
/**
 * wb2dsh — import WorkBuddy / Claude Code chat history into a DeepSeek Harness
 * session library, as native, UI-renderable v4 sessions.
 *
 * Usage:
 *   wb2dsh [--dry-run] [--force] [--no-backup]
 *          [--dsh-home <dir>] [--sources <id:dir,...>]
 *          [--provider <id>] [--model <id>]
 *
 * @module bin/wb2dsh
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSession, toZstdArtifact, validateArtifact, projectKey, encodeSegment, uuid5 } from '../lib/format.mjs';
import { defaultSources, scanSources } from '../lib/parse.mjs';
import { loadWorkspaceJson, ensureWorkspace, saveWorkspaceJson, isDshRunning, backupDsh } from '../lib/workspace.mjs';

const VERSION = '1.0.0';

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, backup: true, provider: 'makie', model: 'global:deepseek-v4.1-flash' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--no-backup') opts.backup = false;
    else if (a === '--dsh-home') opts.dshHome = argv[++i];
    else if (a === '--sources') opts.sources = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--list-sources') opts.listSources = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`wb2dsh ${VERSION} — import WorkBuddy / Claude Code history into DeepSeek Harness

Options:
  --dsh-home <dir>   DSH home directory (default: ~/.dsh)
  --sources <list>   Comma-separated source roots: id:dir,id:dir
                     (default: ~/.workbuddy/projects, ~/.workbuddy-ai/projects, ~/.claude/projects)
  --provider <id>    Model provider to record (default: makie)
  --model <id>       Model id to record (default: global:deepseek-v4.1-flash)
  --dry-run          Scan only, write nothing
  --no-backup        Skip the automatic .dsh backup
  --force            Proceed even if a DSH instance appears to be running
  --list-sources     Print the resolved source roots and exit
  --help, --version

Notes:
  * Stop DSH before importing (it rewrites workspace.json while running).
  * Re-running is idempotent: existing sessions are skipped.
  * Produces native v4 sessions that DSH opens and renders directly.`);
}

function resolveDshHome(o) {
  return path.resolve(o.dshHome || path.join(os.homedir(), '.dsh'));
}

function resolveSources(o) {
  if (!o.sources) return defaultSources();
  return o.sources.split(',').map((s) => {
    const idx = s.indexOf(':');
    if (idx < 0) return { id: 'custom', dir: path.resolve(s) };
    return { id: s.slice(0, idx), dir: path.resolve(s.slice(idx + 1)) };
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();
  if (opts.version) return console.log(`wb2dsh ${VERSION}`);

  if (typeof globalThis.zlib?.zstdCompressSync !== 'function' && !process.versions.node.match(/^v(2[2-9]|[3-9])\./)) {
    // runtime check is best-effort; Node >= 22.15 is required for node:zlib zstd
  }

  const dshHome = resolveDshHome(opts);
  const sessionsDir = path.join(dshHome, 'sessions');
  const workspaceFile = path.join(dshHome, 'storages', 'workspace.json');
  const sources = resolveSources(opts);

  if (opts.listSources) {
    for (const s of sources) console.log(`${s.id}\t${s.dir}\t${fs.existsSync(s.dir) ? 'ok' : 'missing'}`);
    return;
  }

  console.log(`wb2dsh ${VERSION}`);
  console.log(`  dsh-home: ${dshHome}`);
  for (const s of sources) console.log(`  source:   ${s.id} -> ${s.dir} ${fs.existsSync(s.dir) ? '' : '(missing)'}`);

  if (!opts.dryRun) {
    if (await isDshRunning() && !opts.force) {
      console.error('\nA DSH instance is running on port 3080/3081.');
      console.error('Stop it first, or pass --force (workspace.json edits may be overwritten while it runs).');
      process.exitCode = 2;
      return;
    }
  }

  const ws = opts.dryRun ? null : loadWorkspaceJson(workspaceFile);
  let written = 0, skipped = 0, failed = 0, total = 0;
  const byWorkspace = new Map();

  for (const s of scanSources(sources)) {
    total++;
    const cwd = s.cwd;
    const sid = uuid5(`${s.source}|${s.origId}|${cwd}`);
    const targetDir = path.join(sessionsDir, projectKey(cwd), encodeSegment(`session-${sid}`));
    const targetFile = path.join(targetDir, 'session.v4.jsonl.zstd');
    const turns = s.turns.filter((t) => (t.user.length + t.assistant.length) > 0);

    if (fs.existsSync(targetFile)) {
      skipped++;
      // Always keep the registry complete, even for already-imported sessions.
      if (!opts.dryRun) ensureWorkspace(ws, cwd, path.basename(cwd), sid);
      continue;
    }
    if (opts.dryRun) { written++; byWorkspace.set(cwd, (byWorkspace.get(cwd) || 0) + 1); continue; }

    try {
      const { header, events } = buildSession({ cwd, title: s.title, sid, turns, provider: opts.provider, model: opts.model });
      const artifact = await toZstdArtifact(header, events);
      validateArtifact(artifact);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(targetFile, artifact);
      ensureWorkspace(ws, cwd, path.basename(cwd), sid);
      written++;
      byWorkspace.set(cwd, (byWorkspace.get(cwd) || 0) + 1);
    } catch (err) {
      failed++;
      console.error(`  ! ${s.file}: ${err.message}`);
    }
  }

  if (!opts.dryRun) {
    if (opts.backup) {
      const dest = backupDsh(dshHome);
      console.log(`\n  backup: ${dest}`);
    }
    saveWorkspaceJson(workspaceFile, ws);
  }

  console.log('\nSummary');
  console.log(`  sessions scanned : ${total}`);
  console.log(`  ${opts.dryRun ? 'would write' : 'written'}      : ${written}`);
  console.log(`  skipped (exists) : ${skipped}`);
  console.log(`  failed           : ${failed}`);
  console.log(`  workspaces       : ${byWorkspace.size}`);
  if (opts.dryRun) console.log('\n  (dry run — nothing written)');
  else console.log('\nDone. Restart DSH to see the imported sessions.');
}

main().catch((e) => {
  console.error('wb2dsh: ' + e.message);
  process.exitCode = 1;
});
