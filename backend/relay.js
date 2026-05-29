#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const root = __dirname;
const tscJs = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const build = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
});

if (build.status !== 0) process.exit(build.status || 1);

require(path.join(root, 'dist', 'relay.js'));
