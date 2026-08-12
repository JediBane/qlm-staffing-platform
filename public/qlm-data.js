/* ══════════════════════════════════════════════════════════════
   QLM Data Layer — shared across all tools
   Handles: auth, cloud sync, localStorage fallback
   Load with:  <script src="/qlm-data.js"></script>
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://dxnzrfpybveoqtrvzvhd.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_zYltVHBvWu-RIFFAtYuzRQ_cBAXRvaR';

  var sb = null;
  var currentUser = null;
  var currentProfile = null;

  // ─── INIT ──────────────────────────────────────────────────
  function init() {
    if (!window.supabase) return false;
    if (sb) return true;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return true;
  }

  function ready() { return !!sb; }

  // ─── AUTH ──────────────────────────────────────────────────
  async function getUser() {
    if (!init()) return null;
    if (currentUser) return currentUser;
    try {
      var res = await sb.auth.getUser();
      currentUser = res.data ? res.data.user : null;
      return currentUser;
    } catch (e) { return null; }
  }

  async function getProfile() {
    var u = await getUser();
    if (!u) return null;
    if (currentProfile) return currentProfile;
    try {
      var res = await sb.from('profiles').select('*').eq('id', u.id).single();
      currentProfile = res.data || null;
      return currentProfile;
    } catch (e) { return null; }
  }

  async function isAdmin() {
    var p = await getProfile();
    return !!(p && p.is_admin);
  }

  async function signIn(email, password) {
    if (!init()) throw new Error('Auth unavailable');
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    if (res.error) throw new Error(res.error.message);
    currentUser = res.data.user; currentProfile = null;
    return res.data.user;
  }

  async function signUp(email, password, fullName) {
    if (!init()) throw new Error('Auth unavailable');
    var res = await sb.auth.signUp({
      email: email, password: password,
      options: {
        data: { full_name: fullName || email },
        emailRedirectTo: location.origin + '/qlm-candidates.html'
      }
    });
    if (res.error) throw new Error(res.error.message);
    return res.data.user;
  }

  async function signOut() {
    if (!init()) return;
    await sb.auth.signOut();
    currentUser = null; currentProfile = null;
  }

  // ─── LOCAL FALLBACK ────────────────────────────────────────
  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function lsPush(key, row, cap) {
    var arr = lsGet(key);
    arr.unshift(row);
    lsSet(key, arr.slice(0, cap || 500));
  }

  // ─── GENERIC SAVE (cloud first, local always) ──────────────
  async function save(table, row, localKey) {
    if (localKey) lsPush(localKey, Object.assign({ _local: true }, row));
    var u = await getUser();
    if (!u || !sb) return { cloud: false, row: row };
    try {
      var payload = Object.assign({ owner_id: u.id }, row);
      var res = await sb.from(table).insert(payload).select().single();
      if (res.error) throw new Error(res.error.message);
      return { cloud: true, row: res.data };
    } catch (e) {
      console.warn('[qlm] cloud save failed for ' + table + ':', e.message);
      return { cloud: false, row: row, error: e.message };
    }
  }

  // ─── GENERIC LIST (cloud if signed in, else local) ─────────
  async function list(table, localKey, opts) {
    opts = opts || {};
    var u = await getUser();
    if (u && sb) {
      try {
        var q = sb.from(table).select('*').order('created_at', { ascending: false });
        if (opts.limit) q = q.limit(opts.limit);
        if (opts.mine) q = q.eq('owner_id', u.id);
        var res = await q;
        if (res.error) throw new Error(res.error.message);
        return res.data || [];
      } catch (e) {
        console.warn('[qlm] cloud list failed for ' + table + ':', e.message);
      }
    }
    return localKey ? lsGet(localKey) : [];
  }

  async function update(table, id, patch) {
    var u = await getUser();
    if (!u || !sb) return false;
    try {
      var res = await sb.from(table).update(patch).eq('id', id);
      return !res.error;
    } catch (e) { return false; }
  }

  async function remove(table, id) {
    var u = await getUser();
    if (!u || !sb) return false;
    try {
      var res = await sb.from(table).delete().eq('id', id);
      return !res.error;
    } catch (e) { return false; }
  }

  // ─── ACTIVITY LOG ──────────────────────────────────────────
  async function logActivity(type, payload) {
    payload = payload || {};
    lsPush('qlm_activity', Object.assign({ type: type, date: new Date().toISOString() }, payload));
    var u = await getUser();
    if (!u || !sb) return;
    try {
      await sb.from('activity').insert({
        owner_id: u.id,
        type: type,
        label: payload.name || payload.label || null,
        trade: payload.trade || null,
        city: payload.city || payload.location || null,
        meta: payload
      });
    } catch (e) {}
  }


  // ─── PAGE ACCESS GUARD ─────────────────────────────────────
  // Pages opt in with:  window.QLM_REQUIRE_AUTH = true
  // Candidate assessment links (?invite=) opt out automatically.
  function showGate(msg){
    var g = document.getElementById('qlm-gate');
    if(g) return;
    g = document.createElement('div');
    g.id = 'qlm-gate';
    g.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#003a52;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;font-family:system-ui,-apple-system,sans-serif;';
    g.innerHTML =
      '<div style="background:#0099d8;color:#fff;font-weight:700;font-size:.9rem;letter-spacing:3px;padding:7px 16px;border-radius:5px;">QLM</div>' +
      '<div style="color:#b8dff0;font-size:.9rem;">' + (msg || 'Checking access\u2026') + '</div>';
    document.documentElement.appendChild(g);
  }
  function hideGate(){
    var g = document.getElementById('qlm-gate');
    if(g) g.remove();
  }

  async function enforceAuth(){
    if(!window.QLM_REQUIRE_AUTH) return;
    showGate();
    if(!init()){
      // SDK missing — fail closed
      location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }
    var u = null;
    try { u = await getUser(); } catch(e) {}
    if(u){ hideGate(); return; }
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
  }

  // ─── AUTH BAR (drop-in UI) ─────────────────────────────────
  function mountAuthBar(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;

    getUser().then(function (u) {
      if (u) {
        getProfile().then(function (p) {
          var name = (p && p.full_name) || u.email;
          var admin = !!(p && p.is_admin);
          var initials = name.split(/[\s@.]+/).filter(Boolean).map(function(w){return w[0];}).slice(0,2).join('').toUpperCase();
          el.innerHTML =
            '<span title="' + name + (admin ? ' \u00b7 Admin' : '') + '" style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);padding:2px 8px 2px 3px;border-radius:20px;">' +
              '<span style="width:20px;height:20px;border-radius:50%;background:' + (admin ? '#0099d8' : '#4a7a95') + ';color:#fff;font-size:.58rem;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">' + initials + '</span>' +
              '<span style="font-size:.62rem;color:#b8dff0;letter-spacing:.3px;">' + (admin ? 'ADMIN' : 'RECRUITER') + '</span>' +
              '<button onclick="QLM.signOutAndReload()" title="Sign out" style="background:none;border:none;color:#7ba8bd;cursor:pointer;font-size:.7rem;padding:0 2px;line-height:1;">\u23FB</button>' +
            '</span>';
        });
      } else {
        el.innerHTML =
          '<a href="/login.html" style="display:inline-flex;align-items:center;gap:5px;background:#0099d8;color:#fff;padding:4px 11px;border-radius:20px;text-decoration:none;font-size:.64rem;font-weight:700;letter-spacing:.5px;">SIGN IN</a>';
      }
    });
  }

  async function signOutAndReload() {
    await signOut();
    location.reload();
  }

  // ─── PUBLIC API ────────────────────────────────────────────
  window.QLM = {
    init: init,
    ready: ready,
    client: function () { return sb; },
    getUser: getUser,
    getProfile: getProfile,
    isAdmin: isAdmin,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    signOutAndReload: signOutAndReload,
    save: save,
    list: list,
    update: update,
    remove: remove,
    logActivity: logActivity,
    mountAuthBar: mountAuthBar,
    enforceAuth: enforceAuth,
    lsGet: lsGet,
    lsSet: lsSet
  };

  // Auto-init when the Supabase SDK is present
  function boot(){ init(); enforceAuth(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
