// QLM Lead Search — Netlify serverless function
// Single Anthropic call with web_search tool (no agentic loop).
// Netlify sync functions time out at 10s, so we cannot loop.
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
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: { message: 'Invalid JSON' } }) }; }

  const prompt = body.prompt || '';
  if (!prompt) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ error: { message: 'prompt field required' } })
  };

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 2,
        }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await resp.json();
    if (data.error) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: data.error }) };
    }

    let text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // The model sometimes narrates its search instead of returning JSON —
    // especially when a site blocks it. One fast follow-up (no tools) forces
    // structured output from whatever it did find.
    if (text && text.indexOf('[') === -1 && text.indexOf('{') === -1) {
      try {
        const retry = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            messages: [
              { role: 'user', content: prompt },
              { role: 'assistant', content: text },
              { role: 'user', content:
                'Output ONLY the raw JSON now, starting with [ or {. No preamble, no explanation, no markdown. ' +
                'Use whatever you found above, even if it is partial or low confidence. ' +
                'If you genuinely found nothing usable, return an empty array: []' },
            ],
          }),
        });
        const rd = await retry.json();
        const rt = (rd.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
        if (rt) text = rt;
      } catch (e) { /* keep the original text */ }
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text }] }),
    };
  } catch (e) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: { message: e.message } })
    };
  }
}
