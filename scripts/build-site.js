#!/usr/bin/env node
// Builds a static copy of the dashboard for GitHub Pages:
//
//   site/                  live data from data/snapshots.sqlite
//   site/demo/             the same cards with simulated change history
//   site/case-study.html   the project write-up
//
// The dashboard only ever reads api/overview.json and captures/, so a static
// build is just those files written to disk. The scheduled workflow runs this
// after every scan, so the published site stays current with no server.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildOverview } from '../src/overview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');
const sources = JSON.parse(readFileSync(join(ROOT, 'config/sources.json'), 'utf8'));

if (!existsSync(join(ROOT, 'data/snapshots.sqlite'))) {
  console.error('No scan data. Run `npm run scan` first.');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });

function writePage(dir, overview) {
  mkdirSync(join(dir, 'api'), { recursive: true });
  for (const f of ['index.html', 'styles.css', 'app.js']) cpSync(join(ROOT, 'dashboard', f), join(dir, f));
  writeFileSync(join(dir, 'api/overview.json'), JSON.stringify(overview));
}

// Live
writePage(
  OUT,
  buildOverview({
    dbPath: join(ROOT, 'data/snapshots.sqlite'),
    sources,
    links: { demo: 'demo/', caseStudy: 'case-study.html' },
  })
);
cpSync(join(ROOT, 'data/captures'), join(OUT, 'captures'), { recursive: true });

// Demo: rebuilt from the live store each time. Its screenshots are the live
// ones, so it points at ../captures/ rather than copying them.
execFileSync(process.execPath, [join(ROOT, 'scripts/seed-demo.js')], { stdio: 'inherit' });
writePage(
  join(OUT, 'demo'),
  buildOverview({
    dbPath: join(ROOT, 'data/demo/snapshots.sqlite'),
    sources,
    demo: true,
    captureBase: '../captures/',
    links: { live: '../', caseStudy: '../case-study.html' },
  })
);

// Case study and its images
// In the source file the images are ../docs/..., so the page also opens from
// disk and from the local server; in the built site docs/ sits beside it.
writeFileSync(
  join(OUT, 'case-study.html'),
  readFileSync(join(ROOT, 'dashboard/case-study.html'), 'utf8').replaceAll('src="../docs/', 'src="docs/')
);
cpSync(join(ROOT, 'docs'), join(OUT, 'docs'), { recursive: true });
writeFileSync(join(OUT, '.nojekyll'), '');

console.log(`Static site written to ${OUT}`);
