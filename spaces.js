'use strict';
// A small S3 client for DigitalOcean Spaces (1.20.173) — PUT, LIST and DELETE signed with AWS Signature V4, using only
// Node's own https / crypto, so a deploy needs no `npm install` (scripts/deploy.sh copies files, it does not install).
//
//   const S = require('./spaces')({ key, secret, bucket, region: 'sfo3' });
//   await S.putFile('nova/files/hr-files/12/contract.pdf', '/opt/axiom-ai/hr-files/12/contract.pdf');
//   await S.list('nova/db/')          → [{ key, size, modified }]
//   await S.del('nova/db/users-2026-07-01.db.gz')
//
// Files are streamed twice (once to hash, once to send), never held in memory, so a 300 MB recording costs no RAM.
// Objects are written private (x-amz-acl: private) — Spaces never makes them public unless asked.
// The signing region is the datacenter slug (sfo3); some Spaces setups want 'us-east-1' instead — on a signature
// complaint the client tries the other once and keeps whichever worked.
const https = require('https'), http = require('http'), crypto = require('crypto'), fs = require('fs');

module.exports = function spaces(opt) {
  const key = opt.key, secret = opt.secret, bucket = opt.bucket, slug = opt.region;
  if (!key || !secret || !bucket || !slug) throw new Error('Spaces needs key, secret, bucket and region');
  // endpoint override (tests / another S3 host): path-style https://host/bucket/key
  const base = opt.endpoint ? new URL(opt.endpoint) : null;
  let signRegion = opt.signRegion || slug, triedOther = false;

  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  // RFC 3986: everything but A-Z a-z 0-9 - _ . ~ is %-encoded; '/' kept in paths
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const encPath = (p) => p.split('/').map(enc).join('/');
  const fileHash = (file) => new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });

  function target(objKey, query) {
    const host = base ? base.hostname : bucket + '.' + slug + '.digitaloceanspaces.com';
    const path = (base ? '/' + enc(bucket) : '') + '/' + encPath(objKey || '');
    const q = Object.keys(query || {}).sort().map(k => enc(k) + '=' + enc(String(query[k]))).join('&');
    return { host, path, q, proto: base ? base.protocol : 'https:', port: base ? base.port : '' };
  }

  // AWS Signature V4 (s3 flavour: the path is encoded once, the payload hash goes in x-amz-content-sha256)
  function sign(method, t, headers, payloadHash, when) {
    const now = when || new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
    const h = Object.assign({}, headers, { host: t.host + (t.port ? ':' + t.port : ''), 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate });
    const names = Object.keys(h).map(n => n.toLowerCase()).sort();
    const lower = {}; for (const n of Object.keys(h)) lower[n.toLowerCase()] = String(h[n]).trim().replace(/\s+/g, ' ');
    const canonHeaders = names.map(n => n + ':' + lower[n] + '\n').join('');
    const signed = names.join(';');
    const canon = [method, t.path, t.q, canonHeaders, signed, payloadHash].join('\n');
    const scope = day + '/' + signRegion + '/s3/aws4_request';
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canon)].join('\n');
    const kSign = hmac(hmac(hmac(hmac('AWS4' + secret, day), signRegion), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
    h.authorization = 'AWS4-HMAC-SHA256 Credential=' + key + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + sig;
    return h;
  }

  function send(method, objKey, { query, headers, body, file, size, hash } = {}) {
    const t = target(objKey, query);
    const payloadHash = hash || sha(body || '');
    const h = sign(method, t, headers || {}, payloadHash);
    h['content-length'] = file ? size : Buffer.byteLength(body || '');
    const lib = t.proto === 'http:' ? http : https;
    return new Promise((res, rej) => {
      const req = lib.request({ method, host: t.host, port: t.port || undefined, path: t.path + (t.q ? '?' + t.q : ''), headers: h, timeout: 120000 }, (r) => {
        const chunks = []; r.on('data', c => chunks.push(c));
        r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new Error('Spaces did not answer in 120 s')));
      req.on('error', rej);
      if (file) fs.createReadStream(file).on('error', e => req.destroy(e)).pipe(req);
      else req.end(body || '');
    });
  }
  const errOf = (r) => { const code = (r.body.match(/<Code>([^<]+)<\/Code>/) || [])[1]; const msg = (r.body.match(/<Message>([^<]+)<\/Message>/) || [])[1]; return 'HTTP ' + r.status + (code ? ' ' + code : '') + (msg ? ': ' + msg : ''); };
  const regionComplaint = (r) => r.status === 403 && /SignatureDoesNotMatch|AuthorizationHeaderMalformed|InvalidRegion/.test(r.body) || r.status === 400 && /AuthorizationHeaderMalformed/.test(r.body);

  // one request, with a single retry on a dropped connection / 5xx, and the one-time region swap
  async function call(method, objKey, o) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      let r;
      try { r = await send(method, objKey, o); } catch (e) { lastErr = e; await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      if (r.status >= 200 && r.status < 300) return r;
      if (regionComplaint(r) && !triedOther) { triedOther = true; signRegion = signRegion === 'us-east-1' ? slug : 'us-east-1'; continue; }
      if (r.status >= 500 && i < 2) { lastErr = new Error(errOf(r)); await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
      const e = new Error(errOf(r)); e.status = r.status; throw e;
    }
    throw lastErr || new Error('Spaces request failed');
  }

  async function putFile(objKey, file, contentType) {
    const size = fs.statSync(file).size;
    const hash = await fileHash(file);
    await call('PUT', objKey, { file, size, hash, headers: { 'x-amz-acl': 'private', 'content-type': contentType || 'application/octet-stream' } });
    return { key: objKey, size };
  }
  async function list(prefix) {
    const out = []; let token = null;
    do {
      const query = { 'list-type': 2, prefix: prefix || '', 'max-keys': 1000 }; if (token) query['continuation-token'] = token;
      const r = await call('GET', '', { query });
      const re = /<Contents>([\s\S]*?)<\/Contents>/g; let m;
      while ((m = re.exec(r.body))) {
        const g = (t) => ((m[1].match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] || '');
        out.push({ key: g('Key').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), size: +g('Size') || 0, modified: g('LastModified') });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(r.body) ? ((r.body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null) : null;
    } while (token);
    return out;
  }
  const del = (objKey) => call('DELETE', objKey);
  // a cheap "can we write?" — used by the admin row's check
  async function ping() { await call('GET', '', { query: { 'list-type': 2, 'max-keys': 1 } }); return true; }

  return { putFile, list, del, ping, _sign: sign, _target: target, get signRegion() { return signRegion; } };
};
