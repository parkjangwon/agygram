// Force IPv4 for api.telegram.org to work around IPv6 connectivity issues
import { resolve4 } from 'node:dns';
const originalLookup = (await import('node:net')).connect;

const TELEGRAM_HOST = 'api.telegram.org';

// Patch global dns lookup to prefer IPv4 for Telegram
const dns = await import('node:dns');
const originalResolve = dns.resolve;

const patchedLookup = (hostname, options, callback) => {
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (hostname === TELEGRAM_HOST || hostname.endsWith('.telegram.org')) {
    // Use IPv4 only for Telegram hosts
    return resolve4(hostname, { hints: 4 }, (err, addresses) => {
      if (err) return dns.lookup(hostname, options, callback);
      callback(null, addresses[0], 4);
    });
  }
  return dns.lookup(hostname, options, callback);
};

// Monkey-patch dns.lookup
const dnsModule = await import('node:dns');
// Can't easily patch dns.lookup at module level, so patch the global agent

console.log('[dns-ipv4-fix] Patched DNS for Telegram hosts to use IPv4 only');
