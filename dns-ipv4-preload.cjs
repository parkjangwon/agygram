// Optional DNS workaround: force IPv4 for Telegram hosts when IPv6 is broken.
//
// Usage (from the package root):
//   NODE_OPTIONS="--require ./dns-ipv4-preload.cjs" node src/index.js
//   # or via ecosystem.config.cjs / AGYGRAM_DNS_IPV4=1 (PM2)
//
// Not required for normal installs. Enable only when api.telegram.org fails
// over IPv6 on your network.
'use strict';

const dns = require('node:dns');
const path = require('node:path');

const origLookup = dns.lookup;

function isTelegramHost(hostname) {
  return hostname === 'api.telegram.org' || hostname.endsWith('.telegram.org');
}

dns.lookup = function patchedLookup(hostname, options, callback) {
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options ? { ...options } : {};

  if (isTelegramHost(hostname)) {
    options.family = 4;
  }

  return origLookup.call(dns, hostname, options, callback);
};

if (process.env.AGYGRAM_DNS_IPV4_VERBOSE === '1') {
  process.stderr.write(
    `[dns-ipv4-preload] Telegram hosts forced to IPv4 (loaded from ${path.resolve(__filename)})\n`,
  );
}
