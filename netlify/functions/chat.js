// QLM AI Chat — Netlify serverless function
export async function handler(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const rawKey = process.env.ANTHROPIC_KEY;

  // Diagnostic: GET /.netlify/functions/chat  → reports key status, never the key itself
  if (event.httpMethod === 'GET') {
    const names = Object.keys(process.env).filter(n => /ANTHROPIC|CLAUDE|API/i.test(n));
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyPresent: !!rawKey,
        keyLength: rawKey ? rawKey.length : 0,
        keyPrefix: rawKey ? rawKey.slice(0, 10) : null,
        keySuffix: rawKey ? rawKey.slice(-4) : null,
        hasWhitespace: rawKey ? rawKey !== rawKey.trim() : false,
        hasQuotes: rawKey ? (rawKey.startsWith('"') || rawKey.startsWith("'")) : false,
        matchingEnvNames: names,
      }, null, 2),
    };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  // Strip whitespace and stray quotes that break auth
  const key = rawKey ? rawKey.trim().replace(/^["']|["']$/g, '') : null;
  if (!key) return {
    statusCode: 500, headers: CORS,
    body: JSON.stringify({ error: { message: 'ANTHROPIC_KEY not set in Netlify environment variables.' } })
  };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'Invalid JSON' } }) }; }

  body.model = 'claude-haiku-4-5-20251001';
  if (!body.max_tokens) body.max_tokens = 2000;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    return {
      statusCode: resp.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
}
