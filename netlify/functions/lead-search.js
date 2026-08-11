// QLM Lead Search — Netlify serverless function
// Runs agentic web search loop via Anthropic web_search_20250305 tool
// Netlify function timeout: 26 seconds — capped at 5 iterations to stay safe
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

  const prompt = body.prompt || '';
  if (!prompt) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ error: { message: 'prompt field required' } })
  };

  async function anthropicCall(messages) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      }),
    });
    return resp.json();
  }

  try {
    let msgs = [{ role: 'user', content: prompt }];
    let finalText = '';
    const MAX = 5;

    for (let i = 0; i < MAX; i++) {
      const resp = await anthropicCall(msgs);
      if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
      const content = resp.content || [];
      const texts = content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (texts) finalText = texts;
      if (resp.stop_reason === 'end_turn') break;
      const tools = content.filter(b => b.type === 'tool_use');
      if (!tools.length) break;
      msgs.push({ role: 'assistant', content });
      msgs.push({
        role: 'user',
        content: tools.map(t => ({ type: 'tool_result', tool_use_id: t.id, content: t.content || '' }))
      });
    }

    // If no JSON found, add one more turn demanding JSON output
    if (!finalText.match(/[\[{]/)) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: finalText || 'No results found.' }] });
      msgs.push({
        role: 'user',
        content: 'Output the results you found as a raw JSON array now. Include every company found, expand to nearby areas if local market is small. Start with [ and end with ]. No explanation — only the JSON array.'
      });
      const finalResp = await anthropicCall(msgs);
      const ft = (finalResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (ft) finalText = ft;
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: finalText }] }),
    };
  } catch(e) {
    console.error('Lead search error:', e.message);
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: { message: e.message } })
    };
  }
}
