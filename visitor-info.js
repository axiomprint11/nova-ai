'use strict';
// Who is chatting, for the team's Conversations view (never sent to the model):
//   device(ua, client)   -> { type, os, browser, app, screen, lang, tz, label }
//   source(visit, ua)    -> { label, kind, detail } — how they reached axiomprint.com
//   cleanVisit(body)     -> the visit/device object the chat sends, trimmed to known fields
// The visit comes from the website header script (public/client-embed.js): the first page of
// the visit, the site that sent them (document.referrer) and campaign tags (UTM, ad click ids).

const TAGS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'gbraid', 'wbraid',
  'gad_source', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid', 'srsltid', 'yclid', 'ref', 'source'];
const SECRET = /token|pass|secret|auth|key|sig|session|code|^k$/i;

function cleanUrl(u, max) {
  try {
    const x = new URL(String(u || '').slice(0, 1000));
    if (!/^https?:$/.test(x.protocol)) return '';
    Array.from(x.searchParams.keys()).forEach(k => { if (SECRET.test(k)) x.searchParams.delete(k); });
    return x.toString().slice(0, max || 500);
  } catch (e) { return ''; }
}
function cleanOne(v) {
  if (!v || typeof v !== 'object') return null;
  const tags = {};
  if (v.tags && typeof v.tags === 'object') TAGS.forEach(k => { if (v.tags[k]) tags[k] = String(v.tags[k]).replace(/[\u0000-\u001f]/g, '').slice(0, 120); });
  const at = String(v.at || '').slice(0, 30);
  return { landing: cleanUrl(v.landing), referrer: cleanUrl(v.referrer, 300), tags: tags, at: /^\d{4}-\d\d-\d\dT/.test(at) ? at : '' };
}
function cleanVisit(visit, dev) {
  const out = {};
  if (visit && typeof visit === 'object') {
    const v = cleanOne(visit.visit), f = cleanOne(visit.first);
    if (v) out.visit = v;
    if (f && (!v || f.at !== v.at)) out.first = f;
  }
  if (dev && typeof dev === 'object') {
    out.device = {
      screen: /^\d{2,5}x\d{2,5}$/.test(String(dev.screen || '')) ? String(dev.screen) : '',
      dpr: Math.round(Math.min(8, Math.max(0, Number(dev.dpr) || 0)) * 100) / 100 || undefined,
      lang: String(dev.lang || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20),
      tz: String(dev.tz || '').replace(/[^A-Za-z0-9_\/+-]/g, '').slice(0, 50),
      touch: Math.min(20, Math.max(0, parseInt(dev.touch) || 0)),
      mobile: typeof dev.mobile === 'boolean' ? dev.mobile : undefined,
      platform: dev.platform ? String(dev.platform).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 30) : undefined
    };
  }
  return Object.keys(out).length ? out : null;
}

// ---- device, from the browser's user agent (+ what the chat page measured) ----
function device(ua, client) {
  ua = String(ua || '');
  client = client || {};
  let os = '', type = 'Desktop', browser = '', app = '', m;
  if ((m = ua.match(/iPhone OS (\d+)[_.](\d+)/)) || /iPhone/.test(ua)) { os = 'iPhone' + (m ? ' · iOS ' + m[1] + '.' + m[2] : ''); type = 'Phone'; }
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && Number(client.touch) > 1)) { m = ua.match(/OS (\d+)[_.](\d+)/); os = 'iPad' + (m ? ' · iPadOS ' + m[1] + '.' + m[2] : ''); type = 'Tablet'; }
  else if ((m = ua.match(/Android (\d+(?:\.\d+)?)/))) {
    type = /Mobile/.test(ua) ? 'Phone' : 'Tablet';
    const model = (ua.match(/Android [^;)]*;\s*(?:[a-z]{2}-[a-z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/i) || [])[1];
    os = 'Android ' + m[1] + (model && !/^(K|wv|Linux|U)$/.test(model.trim()) ? ' · ' + model.trim() : '');
  }
  else if ((m = ua.match(/Windows NT (\d+\.\d+)/))) os = 'Windows' + ({ '10.0': ' 10/11', '6.3': ' 8.1', '6.1': ' 7' }[m[1]] || '');
  else if (/Mac OS X/.test(ua)) os = 'Mac';            // browsers freeze the macOS version at 10.15, so it says nothing
  else if (/CrOS/.test(ua)) os = 'Chromebook';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (client.mobile === true && type === 'Desktop') type = 'Phone';
  // Apps that open links in their own browser say which app the visitor came from.
  const apps = [[/Instagram/, 'Instagram app'], [/FBAN|FBAV|FB_IAB/, 'Facebook app'], [/LinkedInApp/, 'LinkedIn app'],
    [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok app'], [/Snapchat/, 'Snapchat app'], [/Pinterest/, 'Pinterest app'],
    [/Twitter|XApp/, 'X (Twitter) app'], [/\bGSA\//, 'Google app'], [/Yelp/i, 'Yelp app'], [/Nextdoor/i, 'Nextdoor app'], [/Line\//, 'LINE app'],
    [/WhatsApp/i, 'WhatsApp'], [/ChatGPT/i, 'ChatGPT app']];
  apps.some(([re, name]) => { if (re.test(ua)) { app = name; return true; } return false; });
  const b = [[/EdgA?\/(\d+)|EdgiOS\/(\d+)/, 'Edge'], [/OPR\/(\d+)|OPiOS\/(\d+)/, 'Opera'], [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/CriOS\/(\d+)/, 'Chrome'], [/FxiOS\/(\d+)/, 'Firefox'], [/Firefox\/(\d+)/, 'Firefox'], [/DuckDuckGo\/(\d+)/, 'DuckDuckGo'],
    [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+(?:\.\d+)?).*Safari/, 'Safari']];
  for (const [re, name] of b) { const x = ua.match(re); if (x) { browser = name + ' ' + (x[1] || x[2] || ''); break; } }
  if (!browser && /Safari/.test(ua)) browser = 'Safari';
  browser = browser.trim();
  const screen = client.screen || '';
  const label = [type === 'Desktop' ? (os || 'Computer') : os || type, app || browser].filter(Boolean).join(' · ');
  return { type: type, os: os, browser: browser, app: app, screen: screen, lang: client.lang || '', tz: client.tz || '', label: label || (ua ? 'Unknown device' : '') };
}

// ---- traffic source ----
const HOSTS = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)openai\.com$/, 'ChatGPT', 'AI assistant'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity', 'AI assistant'], [/^gemini\.google\.com$|^bard\.google\.com$/, 'Gemini', 'AI assistant'],
  [/(^|\.)claude\.ai$/, 'Claude', 'AI assistant'], [/^copilot\.microsoft\.com$/, 'Copilot', 'AI assistant'],
  [/(^|\.)you\.com$|(^|\.)phind\.com$|(^|\.)meta\.ai$|(^|\.)deepseek\.com$|(^|\.)grok\.com$/, null, 'AI assistant'],
  [/(^|\.)google\.[a-z.]+$/, 'Google', 'Search'], [/(^|\.)bing\.com$/, 'Bing', 'Search'], [/(^|\.)yahoo\.com$/, 'Yahoo', 'Search'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo', 'Search'], [/(^|\.)ecosia\.org$|(^|\.)brave\.com$|(^|\.)yandex\.[a-z]+$|(^|\.)baidu\.com$/, null, 'Search'],
  [/(^|\.)yelp\.[a-z.]+$/, 'Yelp', 'Directory / reviews'], [/(^|\.)nextdoor\.com$/, 'Nextdoor', 'Directory / reviews'],
  [/(^|\.)thumbtack\.com$|(^|\.)angi\.com$|(^|\.)bbb\.org$|(^|\.)mapquest\.com$|(^|\.)tripadvisor\.[a-z.]+$|(^|\.)apple\.com$/, null, 'Directory / reviews'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/, 'Facebook', 'Social'], [/(^|\.)instagram\.com$/, 'Instagram', 'Social'],
  [/(^|\.)tiktok\.com$/, 'TikTok', 'Social'], [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/, 'LinkedIn', 'Social'],
  [/(^|\.)x\.com$|(^|\.)twitter\.com$|^t\.co$/, 'X (Twitter)', 'Social'], [/(^|\.)pinterest\.[a-z.]+$/, 'Pinterest', 'Social'],
  [/(^|\.)reddit\.com$/, 'Reddit', 'Social'], [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube', 'Social'],
  [/mail\.google\.com$|(^|\.)outlook\.(live|office)\.com$|mail\.yahoo\.com$/, 'Email', 'Email']
];
const SOURCE_NAMES = { google: 'Google', 'google.com': 'Google', bing: 'Bing', chatgpt: 'ChatGPT', 'chatgpt.com': 'ChatGPT', openai: 'ChatGPT',
  perplexity: 'Perplexity', 'perplexity.ai': 'Perplexity', gemini: 'Gemini', claude: 'Claude', copilot: 'Copilot', yelp: 'Yelp',
  facebook: 'Facebook', fb: 'Facebook', instagram: 'Instagram', ig: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn',
  twitter: 'X (Twitter)', x: 'X (Twitter)', pinterest: 'Pinterest', youtube: 'YouTube', nextdoor: 'Nextdoor', reddit: 'Reddit',
  gmb: 'Google Business Profile', gbp: 'Google Business Profile', google_business: 'Google Business Profile', 'google-business': 'Google Business Profile',
  newsletter: 'Email', email: 'Email', mailchimp: 'Email', klaviyo: 'Email', sendgrid: 'Email', sms: 'Text message' };
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
function source(v, ua) {
  if (!v) return null;
  const t = v.tags || {}, host = hostOf(v.referrer);
  const medium = String(t.utm_medium || '').toLowerCase();
  const paid = /cpc|ppc|paid|cpm|display|ads?$|retarget/.test(medium);
  const kindFromMedium = paid ? 'Paid ad' : /email|newsletter/.test(medium) ? 'Email' : /social/.test(medium) ? 'Social'
    : /organic/.test(medium) ? 'Search' : /referral/.test(medium) ? 'Referral' : /sms|text/.test(medium) ? 'Text message' : '';
  const detail = [t.utm_campaign && 'campaign "' + t.utm_campaign + '"', t.utm_term && 'term "' + t.utm_term + '"'].filter(Boolean).join(', ');
  if (t.gclid || t.gbraid || t.wbraid || t.gad_source) return { label: 'Google Ads', kind: 'Paid ad', detail: detail };
  if (t.msclkid) return { label: 'Microsoft Ads', kind: 'Paid ad', detail: detail };
  if (t.ttclid) return { label: 'TikTok Ads', kind: 'Paid ad', detail: detail };
  if (t.li_fat_id) return { label: 'LinkedIn Ads', kind: 'Paid ad', detail: detail };
  const us = String(t.utm_source || t.source || t.ref || '').toLowerCase().trim();
  if (us) {
    const name = SOURCE_NAMES[us] || SOURCE_NAMES[us.replace(/^www\./, '')] ||
      (HOSTS.find(h => h[0].test(us)) || [])[1] || t.utm_source || t.source || t.ref;
    const hostKind = (HOSTS.find(h => h[0].test(us) || (h[1] && h[1].toLowerCase() === String(name).toLowerCase())) || [])[2];
    return { label: name, kind: (name === 'Google Business Profile' ? 'Google Maps / Business Profile' : '') || kindFromMedium ||
      (t.fbclid ? 'Social' : hostKind) || 'Campaign link', detail: detail };
  }
  if (t.fbclid) return { label: host && /instagram/.test(host) ? 'Instagram' : 'Facebook / Instagram', kind: 'Social', detail: '' };
  if (t.srsltid) return { label: 'Google', kind: 'Free product listing (Shopping)', detail: '' };
  if (host) {
    const h = HOSTS.find(x => x[0].test(host));
    if (h) return { label: h[1] || host, kind: h[2], detail: '' };
    return { label: host, kind: 'Referral (link on another site)', detail: '' };
  }
  const app = device(ua).app;
  if (app) return { label: app.replace(/ app$/, ''), kind: 'Opened from the app', detail: '' };
  return { label: 'Direct', kind: 'Typed the address, a bookmark, or the source was hidden', detail: '' };
}

// Everything the Conversations view shows about the visitor.
function visitor(chat) {
  let v = null;
  try { v = chat && chat.visit ? JSON.parse(chat.visit) : null; } catch (e) { v = null; }
  const ua = chat ? chat.user_agent : '';
  const dev = device(ua, v && v.device);
  const ip = String((chat && chat.ip) || '');
  const local = /^(::1|127\.|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return {
    device: dev,
    ip: ip && !local ? ip : '',
    ip_note: ip && local ? 'not recorded — the web server is not passing visitors\u2019 addresses to Nova yet (it saw ' + ip + ')' : '',
    source: v && v.visit ? source(v.visit, ua) : null,
    landing: v && v.visit ? v.visit.landing : '',
    referrer: v && v.visit ? v.visit.referrer : '',
    tags: v && v.visit ? v.visit.tags : {},
    arrived: v && v.visit ? v.visit.at : '',
    first: v && v.first ? { source: source(v.first, ua), landing: v.first.landing, referrer: v.first.referrer, tags: v.first.tags, at: v.first.at } : null
  };
}

module.exports = { cleanVisit, device, source, visitor, hostOf };
