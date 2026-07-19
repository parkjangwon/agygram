const path = require('node:path');

const root = __dirname;
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const dnsPreload = path.join(root, 'dns-ipv4-preload.cjs');

// Optional IPv4-only DNS workaround for broken IPv6 routes to Telegram.
// Enable with AGYGRAM_DNS_IPV4=1 (or "true"/"yes") in the process environment.
const enableDnsIpv4 = /^(1|true|yes)$/i.test(String(process.env.AGYGRAM_DNS_IPV4 || ''));

const env = {
  NODE_ENV: 'production',
};

if (enableDnsIpv4) {
  const existing = process.env.NODE_OPTIONS || '';
  const requireFlag = `--require ${dnsPreload}`;
  env.NODE_OPTIONS = existing.includes(dnsPreload)
    ? existing
    : [existing, requireFlag].filter(Boolean).join(' ').trim();
}

module.exports = {
  apps: [
    {
      name: 'agygram',
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
      env,
    },
  ],
};
