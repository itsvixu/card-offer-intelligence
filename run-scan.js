#!/usr/bin/env node
// CLI entry point — the script the scheduled workflow runs twice a week (§8),
// and the command you run locally.
//
//   node run-scan.js                       # scan config/sources.json
//   node run-scan.js --dry-run             # scan + classify, store nothing
//   node run-scan.js --config config/sources.fixtures.json --db data/fixtures.sqlite
//
// Writes the store (data/snapshots.sqlite + data/captures/), and the run
// report as markdown (the email body) and JSON.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, exit, stdout } from 'node:process';
import { SnapshotStore } from './src/store.js';
import { runScan } from './src/pipeline.js';
import { fetchPage as plainFetch } from './src/fetch.js';
import { createRobotsChecker } from './src/robots.js';
import { buildRunReport, buildRunReportJson, summarizeRun } from './src/report.js';

function parseArgs(args) {
  const opts = {
    config: 'config/sources.json',
    db: 'data/snapshots.sqlite',
    captures: null, // defaults to <db dir>/captures
    out: 'output/run-report.md',
    outJson: 'output/run-report.json',
    dryRun: false,
    browser: true,
    delayMs: 1500,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config') opts.config = args[++i];
    else if (a === '--db') opts.db = args[++i];
    else if (a === '--captures') opts.captures = args[++i];
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--out-json') opts.outJson = args[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-browser') opts.browser = false;
    else if (a === '--delay') opts.delayMs = Number(args[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  opts.captures ??= join(dirname(opts.db), 'captures');
  return opts;
}

// Let config files reference local fixtures with relative `file:` URLs
// (resolved against the config's own directory). Real http(s) source URLs
// pass through untouched.
function resolveSourceUrl(url, baseDir) {
  if (url.startsWith('file:') && !url.startsWith('file://')) {
    const p = url.slice('file:'.length);
    return pathToFileURL(isAbsolute(p) ? p : resolve(baseDir, p)).href;
  }
  return url;
}

function captureSaver(capturesDir) {
  return async ({ sourceId, scanTimestamp, buffer }) => {
    const file = `${scanTimestamp.replace(/[:.]/g, '-')}.jpg`;
    mkdirSync(join(capturesDir, sourceId), { recursive: true });
    writeFileSync(join(capturesDir, sourceId, file), buffer);
    return `${sourceId}/${file}`; // stored relative to the captures directory
  };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    stdout.write(
      'Usage: node run-scan.js [--config path] [--db path] [--captures dir] [--dry-run]\n' +
        '                        [--no-browser] [--delay ms] [--out path] [--out-json path]\n'
    );
    return 0;
  }

  let sources;
  try {
    sources = JSON.parse(readFileSync(opts.config, 'utf8'));
  } catch (err) {
    stdout.write(`Could not read config "${opts.config}": ${err.message}\n`);
    return 1;
  }
  const baseDir = dirname(resolve(opts.config));
  sources = sources.map((s) => ({ ...s, url: resolveSourceUrl(s.url, baseDir) }));

  // The browser starts only if a source actually needs it, so fixture and
  // plain-HTTP runs work without Chromium installed.
  let browser = null;
  const fetchPage = async (url, fetchOpts = {}) => {
    const wantsBrowser = /^https?:/.test(url) && opts.browser && fetchOpts.render !== 'http';
    if (!wantsBrowser) return plainFetch(url, fetchOpts);
    if (!browser) {
      const { createBrowserFetcher } = await import('./src/browser.js');
      browser = await createBrowserFetcher();
    }
    const first = await browser.fetch(url, fetchOpts);
    // One retry for a slow page load: a single timeout is usually a blip, and
    // otherwise costs the card a whole scan cycle.
    if (first.ok || !/timeout/i.test(first.error ?? '')) return first;
    await new Promise((r) => setTimeout(r, 5000));
    return browser.fetch(url, fetchOpts);
  };

  if (!opts.dryRun) mkdirSync(dirname(resolve(opts.db)), { recursive: true });
  const store = new SnapshotStore(opts.dryRun ? ':memory:' : opts.db);
  try {
    const result = await runScan({
      sources,
      store,
      fetchPage,
      saveCapture: captureSaver(opts.captures),
      isAllowed: createRobotsChecker(),
      delayMs: opts.delayMs,
      persist: !opts.dryRun,
      log: (l) => stdout.write(l + '\n'),
    });

    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, buildRunReport(result));
    mkdirSync(dirname(resolve(opts.outJson)), { recursive: true });
    writeFileSync(opts.outJson, JSON.stringify(buildRunReportJson(result), null, 2));

    stdout.write(`\n${summarizeRun(result)}${opts.dryRun ? ' (dry run, nothing stored)' : ''}\n`);
    stdout.write(`Report: ${opts.out}\n`);
  } finally {
    store.close();
    if (browser) await browser.close();
  }
  return 0;
}

main().then((code) => exit(code));
