// dns-ipv4-preload.cjs — Force IPv4 for api.telegram.org
// Load with: NODE_OPTIONS='--require /home/pjw/antigravity-telegram-cli/dns-ipv4-preload.cjs'
const dns = require('dns');
const origLookup = dns.lookup;

dns.lookup = function (hostname, options, callback) {
  // Handle overloaded arguments: lookup(hostname, callback) or lookup(hostname, options, callback)
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};
  
  // Only force IPv4 for Telegram — everything else resolves normally
  if (hostname === 'api.telegram.org' || hostname.endsWith('.telegram.org')) {
    options.family = 4;  // Force IPv4
  }
  
  return origLookup.call(dns, hostname, options, callback);
};

console.log('[dns-ipv4-preload] Patched dns.lookup — Telegram hosts forced to IPv4');
