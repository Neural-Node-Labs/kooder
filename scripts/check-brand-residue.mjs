#!/usr/bin/env node
// xcoder:version 2 | xcoder:task task-a3052a | xcoder:updated 2026-10-17T13:08:46.302Z | xcoder:subtask code-st-b3a0c8
/**
 * Brand-residue gate (C9 / requirements 1.6).
 *
 * The rebrand is only done if `koober` survives nowhere except the documented
 * compatibility shims. This script makes that a CI-enforced fact instead of a
 * grep someone runs once.
 *
 *   node scripts/check-brand-residue.mjs
 *     exit 0  clean
 *     exit 1  residue found; prints `path:line: text` for every hit
 *
 * Every allowlist entry MUST carry a `reason`; the script fails if one is
 * missing, because an allowlist without reasons is how a rule rots.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-installer', '.git', '.kooder', '.koober', '.xcoder', 'coverage', '.reports', '.tmp']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yaml', '.yml']);
const PATTERN = /koober/i;

/**
 * Files/paths where the old brand is lawful, each with a mandatory reason.
 * A path entry matches the whole file; a `line` entry matches one line.
 */
const ALLOWLIST = [
  { path: 'src/config/env.ts', reason: 'KOOBER_* aliases are the documented read-fallback (C3/C5).' },
  { path: 'src/config/env.test.ts', reason: 'Tests the KOOBER_* alias tier and its deprecation notice.' },
  { path: 'src/util/kooder-paths.ts', reason: 'LEGACY_KOOBER_DIR is the documented .koober read-fallback (C4/C5).' },
  { path: 'src/util/kooder-paths.test.ts', reason: 'Tests the .koober fallback tier and its one-time notice.' },
  { path: 'src/agents/worker-only-architecture.test.ts', reason: 'The intent oracle must assert koober-paths.ts is gone (C7).' },
  { path: 'README.md', reason: 'Historical rebrand record plus the documented shim table (C5/C6).' },
  { path: 'scripts/check-brand-residue.mjs', reason: 'This gate names the residue it searches for.' },
  { path: 'src/config/loadConfig.test.ts', reason: 'Hermetic test setup deletes the ambient KOOBER_* alias tier.' },
  { path: 'src/llm/client.test.ts', reason: 'Hermetic test setup deletes the ambient KOOBER_* alias tier.' },
  { path: 'src/llm/factory-endpoint.test.ts', reason: 'Hermetic test setup deletes the ambient KOOBER_* alias tier.' },
  { path: 'src/util/output-paths.ts', reason: 'The CI-generated gitignore must ignore the .koober fallback tier too.' },
  { path: 'src/tools/workspace-index.ts', reason: 'The indexer must skip all three state-dir tiers, including .koober.' },
  { path: 'package-lock.json', reason: 'Generated lockfile; regenerated from package.json, not hand-edited.' },
];

const allowByPath = new Map(ALLOWLIST.map((e) => [e.path, e]));

for (const entry of ALLOWLIST) {
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    console.error(`allowlist entry ${entry.path} has no reason`);
    process.exit(1);
  }
}

const hits = [];

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full);
      continue;
    }
    if (!EXTS.has(path.extname(ent.name))) continue;

    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (allowByPath.has(rel)) continue;

    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
}

walk(ROOT);

if (hits.length > 0) {
  console.error(`Brand residue found (${hits.length} line(s)):\n`);
  for (const h of hits) console.error(h);
  console.error('\nIf a hit is a lawful compatibility shim, add it to ALLOWLIST with a reason.');
  process.exit(1);
}

console.log('check-brand-residue: clean');
