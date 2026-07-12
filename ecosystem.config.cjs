const path = require('node:path');

const root = __dirname;
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

module.exports = {
  apps: [
    {
      name: 'antigravity-bot',
      script: path.join(root, 'src', 'service', 'file-runner.js'),
      cwd: root,
      interpreter: process.execPath,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_memory_restart: '512M',
      time: true,
      // file-runner writes a private 10 MiB + one-generation rotated log.
      // Discard PM2's duplicate unbounded console files.
      out_file: nullDevice,
      error_file: nullDevice,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
