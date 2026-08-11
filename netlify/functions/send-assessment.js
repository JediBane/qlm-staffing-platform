// QLM — Email assessment results to the recruiter
// Uses Resend (https://resend.com). Set RESEND_API_KEY in Netlify env vars.
// Optional: RESEND_FROM (defaults to onboarding@resend.dev for testing)

export async function handler(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, skipped: true, error: 'RESEND_API_KEY not configured' }),
    };
  }

  const FROM = process.env.RESEND_FROM || 'QLM Assessments <onboarding@resend.dev>';

  let p;
  try { p = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const to = (p.to || '').trim();
  if (!to) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, error: 'Recipient email required' }) };
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const score = p.score != null ? p.score : '—';
  const verdict = (p.verdict || '').toUpperCase();
  const verdictColor =
    verdict.includes('PASS') ? '#15803d' :
    verdict.includes('FAIL') ? '#b91c1c' : '#a16207';
  const verdictBg =
    verdict.includes('PASS') ? '#f0fdf4' :
    verdict.includes('FAIL') ? '#fef2f2' : '#fefce8';

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
  <div style="max-width:620px;margin:0 auto;padding:24px 16px;">

    <div style="background:#003a52;border-radius:12px 12px 0 0;padding:22px 26px;">
      <div style="display:inline-block;background:#0099d8;color:#fff;font-weight:700;font-size:13px;letter-spacing:3px;padding:6px 14px;border-radius:5px;">QLM</div>
      <div style="color:#b8dff0;font-size:12px;letter-spacing:1px;margin-top:8px;">QUALITY LABOR MANAGEMENT</div>
      <div style="color:#fff;font-size:21px;font-weight:700;margin-top:12px;">Assessment Completed</div>
    </div>

    <div style="background:#fff;padding:26px;border-left:1px solid #b8dff0;border-right:1px solid #b8dff0;">

      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#2a4a5a;">
        <tr><td style="padding:7px 0;color:#64748b;width:130px;">Candidate</td><td style="padding:7px 0;font-weight:700;color:#003a52;">${esc(p.candidate)}</td></tr>
        <tr><td style="padding:7px 0;color:#64748b;">Trade</td><td style="padding:7px 0;font-weight:600;">${esc(p.trade)}</td></tr>
        ${p.level ? `<tr><td style="padding:7px 0;color:#64748b;">Level</td><td style="padding:7px 0;">${esc(p.level)}</td></tr>` : ''}
        ${p.yoe ? `<tr><td style="padding:7px 0;color:#64748b;">Experience</td><td style="padding:7px 0;">${esc(p.yoe)}</td></tr>` : ''}
        ${p.certs ? `<tr><td style="padding:7px 0;color:#64748b;">Certifications</td><td style="padding:7px 0;">${esc(p.certs)}</td></tr>` : ''}
        <tr><td style="padding:7px 0;color:#64748b;">Completed</td><td style="padding:7px 0;">${esc(p.date || new Date().toLocaleDateString())}</td></tr>
      </table>

      <div style="display:flex;gap:12px;margin:22px 0;">
        <div style="flex:1;background:#e0f4fc;border:1px solid #b8dff0;border-radius:10px;padding:16px;text-align:center;">
          <div style="font-size:32px;font-weight:700;color:#003a52;line-height:1;">${esc(score)}</div>
          <div style="font-size:11px;color:#0077a8;letter-spacing:1px;margin-top:4px;">SCORE / 100</div>
        </div>
        <div style="flex:1;background:${verdictBg};border:1px solid ${verdictColor}40;border-radius:10px;padding:16px;text-align:center;">
          <div style="font-size:19px;font-weight:700;color:${verdictColor};line-height:1.2;padding-top:6px;">${esc(p.verdict || '—')}</div>
          <div style="font-size:11px;color:${verdictColor};letter-spacing:1px;margin-top:6px;">VERDICT</div>
        </div>
      </div>

      ${p.fullReport ? `
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#0077a8;margin:22px 0 8px;">FULL REPORT</div>
      <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:13px;line-height:1.7;color:#2a4a5a;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:0;">${esc(p.fullReport)}</pre>` : ''}

    </div>

    <div style="background:#fff;border:1px solid #b8dff0;border-top:none;border-radius:0 0 12px 12px;padding:16px 26px;text-align:center;">
      <div style="font-size:12px;color:#94a3b8;">Safety &middot; Productivity &middot; Quality</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:4px;">myqlm.com &middot; 855-756-9675</div>
    </div>

  </div>
</body></html>`;

  const subject = `QLM Assessment: ${p.candidate || 'Candidate'} — ${p.trade || ''} — ${p.verdict || ''} (${score})`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: subject,
        html: html,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: data.message || 'Email send failed' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, id: data.id }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: e.message }),
    };
  }
}
