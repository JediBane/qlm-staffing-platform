// QLM — Admin user management
// Requires SUPABASE_SERVICE_KEY in Netlify env vars (Supabase → Project Settings
// → API → service_role). Never exposed to the browser; every call is verified
// against the caller's access token and their is_admin flag.

const SUPABASE_URL = 'https://dxnzrfpybveoqtrvzvhd.supabase.co';

export async function handler(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // Diagnostic: GET reports the shape of the configured key, never its value
  if (event.httpMethod === 'GET') {
    const k = process.env.SUPABASE_SERVICE_KEY || '';
    let kind = 'not set';
    if (k.startsWith('sb_secret_')) kind = 'service_role (new format) \u2713';
    else if (k.startsWith('sb_publishable_')) kind = 'PUBLISHABLE key \u2717 wrong key';
    else if (k.startsWith('eyJ')) {
      try {
        const role = JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString()).role;
        kind = role === 'service_role' ? 'service_role JWT \u2713' : 'JWT with role "' + role + '" \u2717 wrong key';
      } catch (e) { kind = 'unrecognised JWT'; }
    } else if (k) kind = 'unrecognised format';
    return json(200, CORS, { keyConfigured: !!k, keyLength: k.length, keyType: kind });
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SERVICE_KEY) {
    return json(200, CORS, {
      ok: false,
      needsSetup: true,
      error: 'SUPABASE_SERVICE_KEY is not configured in Netlify. Add it to enable inviting and removing users.'
    });
  }

  // ── Verify the caller is a signed-in admin ──
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, CORS, { ok: false, error: 'Not signed in' });

  let caller;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    caller = await r.json();
    if (!caller || !caller.id) throw new Error('Invalid session');
  } catch (e) {
    return json(401, CORS, { ok: false, error: 'Could not verify your session' });
  }

  // Confirm admin via the profiles table
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${caller.id}&select=is_admin`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const rows = await r.json();

    if (!r.ok) {
      return json(403, CORS, { ok: false,
        error: 'The configured SUPABASE_SERVICE_KEY was rejected by Supabase (' +
               (rows.message || rows.msg || r.status) + '). Make sure it is the service_role key, not the anon or publishable key.' });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return json(403, CORS, { ok: false,
        error: 'Your profile could not be read with the configured key. This usually means SUPABASE_SERVICE_KEY holds the anon/publishable key instead of the service_role key.' });
    }
    if (rows[0].is_admin !== true) {
      return json(403, CORS, { ok: false,
        error: 'Your account (' + (caller.email || caller.id) + ') is not marked as an administrator.' });
    }
  } catch (e) {
    return json(500, CORS, { ok: false, error: 'Permission check failed: ' + e.message });
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return json(400, CORS, { ok: false, error: 'Invalid request' }); }

  const admin = (path, opts = {}) =>
    fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });

  try {
    // ── INVITE ──
    if (body.action === 'invite') {
      const email = (body.email || '').trim().toLowerCase();
      if (!email) return json(400, CORS, { ok: false, error: 'Email address required' });

      const r = await admin('/auth/v1/invite', {
        method: 'POST',
        body: JSON.stringify({
          email,
          data: { full_name: body.full_name || email },
          redirect_to: (body.origin || '') + '/login.html',
        }),
      });
      const data = await r.json();
      if (!r.ok) return json(200, CORS, { ok: false, error: data.msg || data.message || 'Invite failed' });

      // Apply the requested role once the profile row exists
      if (body.is_admin && data.id) {
        await admin(`/rest/v1/profiles?id=eq.${data.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ is_admin: true, full_name: body.full_name || email }),
        });
      }
      return json(200, CORS, { ok: true, invited: email });
    }

    // ── DELETE ──
    if (body.action === 'delete') {
      const id = body.id;
      if (!id) return json(400, CORS, { ok: false, error: 'User id required' });
      if (id === caller.id) return json(400, CORS, { ok: false, error: 'You cannot remove your own account' });

      // Keep their work; just detach ownership
      for (const t of ['assessments', 'candidates', 'leads', 'activity', 'market_reports']) {
        await admin(`/rest/v1/${t}?owner_id=eq.${id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ owner_id: null }),
        });
      }
      await admin(`/rest/v1/assessment_invites?recruiter_id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ recruiter_id: null }),
      });

      await admin(`/rest/v1/profiles?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const r = await admin(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return json(200, CORS, { ok: false, error: d.msg || 'Could not remove the account' });
      }
      return json(200, CORS, { ok: true, deleted: id });
    }

    // ── RESEND INVITE / PASSWORD RESET ──
    if (body.action === 'reset') {
      const email = (body.email || '').trim().toLowerCase();
      const r = await admin('/auth/v1/recover', {
        method: 'POST',
        body: JSON.stringify({ email, redirect_to: (body.origin || '') + '/login.html' }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return json(200, CORS, { ok: false, error: d.msg || 'Could not send the reset email' });
      }
      return json(200, CORS, { ok: true, sent: email });
    }

    return json(400, CORS, { ok: false, error: 'Unknown action' });
  } catch (e) {
    return json(500, CORS, { ok: false, error: e.message });
  }
}

function json(status, headers, obj) {
  return { statusCode: status, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
