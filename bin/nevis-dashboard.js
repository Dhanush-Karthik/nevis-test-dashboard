#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const args = process.argv.slice(2);

const usage = `nevis-dashboard ${pkg.version}

Usage: nevis-dashboard [--root <dir>] [--port <n>] [--open]

  --root <dir>   The integration-test project (has integration_test.py and config/).
                 Default: the current directory.
  --port <n>     Port to listen on (default 4570, or DASHBOARD_PORT).
  --open         Open the dashboard in the default browser.
  -v, --version  Print the version.
  -h, --help     Show this help.

Environment: NEVIS_TESTS_ROOT, DASHBOARD_PORT, NEVIS_PYTEST (pytest binary; default <root>/.venv/bin/pytest),
SSH_HOST / SSH_USER / SSH_KEY (devtest cluster), TEMPO_URL, GRAFANA_URL.`;

let open = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) {
      console.error(`Missing value for ${a}\n\n${usage}`);
      process.exit(2);
    }
    i += 1;
    return args[i];
  };
  if (a === '-h' || a === '--help') {
    console.log(usage);
    process.exit(0);
  } else if (a === '-v' || a === '--version') {
    console.log(pkg.version);
    process.exit(0);
  } else if (a === '--root') process.env.NEVIS_TESTS_ROOT = path.resolve(next());
  else if (a === '--port') process.env.DASHBOARD_PORT = next();
  else if (a === '--open') open = true;
  else {
    console.error(`Unknown option: ${a}\n\n${usage}`);
    process.exit(2);
  }
}

if (!fs.existsSync(path.join(__dirname, '..', 'client', 'dist', 'index.html'))) {
  console.error('[dashboard] The web client is not built. Run `npm run build` in the dashboard folder first.');
  process.exit(1);
}

require('../server/index.js');

if (open) {
  const url = `http://localhost:${process.env.DASHBOARD_PORT || 4570}`;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  setTimeout(() => require('child_process').spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(), 600);
}
