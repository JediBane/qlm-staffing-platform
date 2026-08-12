// QLM — Contact extractor
// Fetches a company's public pages (and the job posting) server-side and pulls
// real email addresses and phone numbers out of the HTML. No guessing: every
// result carries the URL it was found on.

const UA = 'Mozilla/5.0 (compatible; QLM-Research/1.0; +https://myqlm.com)';
const PAGE_TIMEOUT = 2500;
const MAX_PAGES = 7;

export async function handler(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // GET: browser-testable. /.netlify/functions/find-contact?company=Acme&website=https://acme.com
  let body;
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (!q.company && !q.website) {
      return json(200, CORS, {
        ok: true,
        usage: 'Add ?company=Some+Company or ?website=https://example.com to test extraction',
        anthropicKey: !!process.env.ANTHROPIC_KEY,
      });
    }
    body = { company: q.company || '', website: q.website || '', location: q.location || '', jobUrl: q.jobUrl || '' };
  } else if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body); }
    catch (e) { return json(400, CORS, { error: 'Invalid JSON' }); }
  } else {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  const company = (body.company || '').trim();
  let website = (body.website || '').trim();
  const jobUrl = (body.jobUrl || '').trim();

  // ── Work out the company domain if we were not given one ──
  if (!website) {
    const key = process.env.ANTHROPIC_KEY;
    if (key) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
            messages: [{ role: 'user', content:
              'What is the official company website for "' + company + '"' +
              (body.location ? ' in ' + body.location : '') + '? ' +
              'It is a construction or trades company. Reply with ONLY the root URL, nothing else. ' +
              'If you cannot find it, reply with the single word NONE.' }],
          }),
        });
        const d = await r.json();
        const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
        const m = t.match(/https?:\/\/[^\s"'<>)]+/);
        if (m) website = m[0];
      } catch (e) { /* carry on without a site */ }
    }
  }

  // ── Build the list of pages worth checking ──
  const pages = [];
  if (jobUrl) pages.push(jobUrl);                 // postings often name a recruiter
  if (website) {
    let root;
    try { root = new URL(website).origin; } catch (e) { root = null; }
    if (root) {
      pages.push(root);
      ['/contact', '/contact-us', '/about', '/team', '/careers', '/our-team', '/leadership']
        .forEach(p => pages.push(root + p));
    }
  }

  const seen = new Set();
  const targets = pages.filter(u => { if (seen.has(u)) return false; seen.add(u); return true; }).slice(0, MAX_PAGES);

  // ── Fetch them all in parallel with a short timeout ──
  const results = await Promise.all(targets.map(u => fetchPage(u)));

  const emails = new Map();   // address -> { address, source, kind }
  const phones = new Map();   // digits  -> { display, source, kind }
  const people = [];
  let structured = {};

  for (const r of results) {
    if (!r || !r.html) continue;
    const html = r.html;

    // mailto: links are the highest-confidence source
    for (const m of html.matchAll(/mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/gi)) {
      addEmail(emails, m[1], r.url, 'mailto link');
    }
    // plain text addresses
    for (const m of html.matchAll(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g)) {
      addEmail(emails, m[0], r.url, 'page text');
    }
    // tel: links
    for (const m of html.matchAll(/tel:\+?([0-9().\-\s]{7,})/gi)) {
      addPhone(phones, m[1], r.url, 'tel link');
    }
    // visible US phone numbers
    const text = stripTags(html);
    for (const m of text.matchAll(/(?:\+?1[\s.\-]?)?\(?([2-9][0-8][0-9])\)?[\s.\-]?([2-9][0-9]{2})[\s.\-]?([0-9]{4})\b/g)) {
      addPhone(phones, m[0], r.url, 'page text');
    }
    // schema.org / JSON-LD blocks carry clean contact data
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const obj = JSON.parse(m[1].trim());
        const flat = JSON.stringify(obj);
        if (/"telephone"/.test(flat) || /"email"/.test(flat)) {
          structured = Object.assign(structured, pickStructured(obj));
        }
      } catch (e) { /* ignore malformed blocks */ }
    }
    // names next to a title, e.g. "Mike Johnson, Operations Manager"
    for (const m of text.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+)\s*[,\-–]\s*(Owner|President|Vice President|General Manager|Operations Manager|Project Manager|Superintendent|Recruiter|Talent Acquisition|Human Resources|HR Manager|Estimator|Foreman)\b/g)) {
      if (!people.some(p => p.name === m[1])) people.push({ name: m[1], title: m[2], source: r.url });
    }
  }

  // ── Rank what we found ──
  const emailList = [...emails.values()].sort((a, b) => rankEmail(b) - rankEmail(a)).slice(0, 8);
  const phoneList = [...phones.values()].sort((a, b) => rankPhone(b) - rankPhone(a)).slice(0, 6);

  // If we have a personal address, the pattern is evidence, not a guess
  let pattern = '';
  const personal = emailList.find(e => e.kind === 'personal');
  if (personal) {
    const local = personal.address.split('@')[0];
    const domain = personal.address.split('@')[1];
    if (/^[a-z]+\.[a-z]+$/i.test(local)) pattern = 'first.last@' + domain;
    else if (/^[a-z]\.?[a-z]+$/i.test(local)) pattern = 'flast@' + domain;
    else if (/^[a-z]+$/i.test(local)) pattern = 'first@' + domain;
  }

  return json(200, CORS, {
    company,
    website: website || null,
    pagesChecked: results.filter(r => r && r.html).map(r => r.url),
    pagesFailed: results.filter(r => r && !r.html).map(r => ({ url: r.url, why: r.why || 'unknown' })),
    domainLookup: website ? 'resolved' : 'could not determine company website',
    emails: emailList,
    phones: phoneList,
    people,
    structured,
    emailPattern: pattern,
  });
}

// ── helpers ──
async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(t);
    if (!r.ok) return { url, html: null, why: 'HTTP ' + r.status };
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html')) return { url, html: null, why: 'not html (' + ct.split(';')[0] + ')' };
    const html = (await r.text()).slice(0, 400000);
    return { url, html };
  } catch (e) {
    clearTimeout(t);
    return { url, html: null, why: e.name === 'AbortError' ? 'timed out' : e.message };
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

const JUNK_EMAIL = /(example|sentry|wixpress|godaddy|squarespace|\.png|\.jpg|\.gif|\.svg|@2x|domain\.com|email\.com|yourcompany)/i;
const ROLE_PREFIX = /^(info|contact|admin|office|sales|support|hello|hr|jobs|careers|recruiting|apply|estimating|service|dispatch)@/i;

function addEmail(map, addr, source, how) {
  addr = addr.trim().toLowerCase().replace(/[.,;]+$/, '');
  if (JUNK_EMAIL.test(addr)) return;
  if (map.has(addr)) return;
  const isRole = ROLE_PREFIX.test(addr);
  const hiring = /^(hr|jobs|careers|recruiting|apply)@/i.test(addr);
  map.set(addr, {
    address: addr,
    source,
    how,
    kind: hiring ? 'hiring' : isRole ? 'general' : 'personal',
  });
}

function addPhone(map, raw, source, how) {
  const digits = String(raw).replace(/[^0-9]/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) return;
  if (/^(0|1)/.test(digits)) return;
  if (map.has(digits)) return;
  const display = '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  map.set(digits, { display, digits, source, how });
}

function rankEmail(e) {
  let s = 0;
  if (e.kind === 'personal') s += 10;
  if (e.kind === 'hiring') s += 8;
  if (e.kind === 'general') s += 4;
  if (e.how === 'mailto link') s += 2;
  return s;
}
function rankPhone(p) {
  return (p.how === 'tel link' ? 2 : 0);
}

function pickStructured(obj) {
  const out = {};
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.telephone && !out.telephone) out.telephone = String(o.telephone);
    if (o.email && !out.email) out.email = String(o.email);
    if (o.name && o['@type'] && /Organization|LocalBusiness/i.test(o['@type']) && !out.name) out.name = String(o.name);
    if (o.address && !out.address) {
      const a = o.address;
      out.address = typeof a === 'string' ? a :
        [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', ');
    }
    Object.values(o).forEach(walk);
  };
  walk(obj);
  return out;
}

function json(status, headers, obj) {
  return { statusCode: status, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
