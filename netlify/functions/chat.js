// QLM AI Chat — Netlify serverless function
// Proxies to Anthropic API, forces Haiku model, handles CORS
export async function handler(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const key = process.env.ANTHROPIC_KEY;
  if (!key) return {
    statusCode: 500, headers: CORS,
    body: JSON.stringify({ error: { message: 'ANTHROPIC_KEY not set in Netlify environment variables.' } })
  };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'Invalid JSON' } }) }; }

  // Always force Haiku — cheapest model
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
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: e.message } }) };
  }
}
