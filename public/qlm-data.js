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

  // Hide anything marked admin-only from non-admin users
  async function applyRoleVisibility(){
    var admin = false;
    try { admin = await isAdmin(); } catch(e) {}
    if(admin) return;
    var sel = '.admin-only, [data-admin-only], a[href="/qlm-dashboard.html"], a[href="qlm-dashboard.html"]';
    document.querySelectorAll(sel).forEach(function(el){ el.style.display = 'none'; });
  }

  async function enforceAuth(){
    if(!window.QLM_REQUIRE_AUTH && !window.QLM_REQUIRE_ADMIN) return;
    showGate();
    if(!init()){
      // SDK missing — fail closed
      location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }
    var u = null;
    try { u = await getUser(); } catch(e) {}
    if(!u){
      location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
      return;
    }

    // Admin-only pages
    if(window.QLM_REQUIRE_ADMIN){
      var ok = false;
      try { ok = await isAdmin(); } catch(e) {}
      if(!ok){
        showGate('This page is limited to administrators. Redirecting\u2026');
        setTimeout(function(){ location.replace('/?denied=admin'); }, 1400);
        return;
      }
    }

    hideGate();
    applyRoleVisibility();
    mountNavMenu();
  }


  // ─── NAV MENU (hamburger) ──────────────────────────────────
  // Collapses the tool links into a slide-in drawer. Only mounts
  // for signed-in users, so public pages stay clean.
  var NAV_ITEMS = [
    { href:'/',                            icon:'\uD83C\uDFE0', label:'Home',           group:'' },
    { href:'/qlm-lead-generator.html',     icon:'\uD83C\uDFAF', label:'Lead Generator', group:'Win the Business' },
    { href:'/qlm-hiring-insights.html',    icon:'\uD83D\uDCCA', label:'Hiring Insights',group:'Win the Business' },
    { href:'/qlm-candidates.html',         icon:'\uD83D\uDC65', label:'Candidates',     group:'Source & Screen' },
    { href:'/qlm-trades-assessment.html',  icon:'\u26A1',       label:'Assessment',     group:'Source & Screen' },
    { href:'/talent-card.html',            icon:'\uD83D\uDCC4', label:'Talent Card',    group:'Source & Screen' },
    { href:'/qlm-intake.html',             icon:'\uD83D\uDCCB', label:'Intake Form',    group:'Source & Screen' },
    { href:'/qlm-dashboard.html',          icon:'\uD83D\uDCC8', label:'Admin Dashboard',group:'Measure', admin:true }
  ];

  async function mountNavMenu(){
    var nav = document.querySelector('.tool-nav');
    if(!nav || document.getElementById('qlm-menu-btn')) return;

    var u = null;
    try { u = await getUser(); } catch(e) {}
    if(!u) return;                       // public pages keep a clean header

    var admin = false;
    try { admin = await isAdmin(); } catch(e) {}

    // Hide the inline links; the drawer replaces them
    nav.querySelectorAll('a.tnav').forEach(function(a){ a.style.display = 'none'; });

    var css = document.createElement('style');
    css.textContent =
      '#qlm-menu-btn{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);color:#fff;' +
        'width:38px;height:34px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;' +
        'justify-content:center;flex-direction:column;gap:4px;padding:0;flex-shrink:0;transition:background .2s;}' +
      '#qlm-menu-btn:hover{background:rgba(0,153,216,.35);}' +
      '#qlm-menu-btn span{display:block;width:17px;height:2px;background:#fff;border-radius:2px;}' +
      '#qlm-drawer-bg{position:fixed;inset:0;background:rgba(0,26,38,.55);z-index:9998;opacity:0;' +
        'pointer-events:none;transition:opacity .22s;}' +
      '#qlm-drawer-bg.open{opacity:1;pointer-events:auto;}' +
      '#qlm-drawer{position:fixed;top:0;right:0;height:100%;width:290px;max-width:86vw;background:#003a52;' +
        'z-index:9999;transform:translateX(100%);transition:transform .24s ease;overflow-y:auto;' +
        'box-shadow:-8px 0 34px rgba(0,0,0,.35);}' +
      '#qlm-drawer.open{transform:translateX(0);}' +
      '#qlm-drawer .dh{padding:18px 20px 14px;border-bottom:1px solid rgba(0,153,216,.25);' +
        'display:flex;align-items:center;justify-content:space-between;}' +
      '#qlm-drawer .dh .badge{background:#0099d8;color:#fff;font-weight:700;font-size:.78rem;letter-spacing:2.5px;' +
        'padding:5px 12px;border-radius:5px;}' +
      '#qlm-drawer .dclose{background:none;border:none;color:#b8dff0;font-size:1.5rem;cursor:pointer;line-height:1;padding:0 4px;}' +
      '#qlm-drawer .dgroup{font-size:.6rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
        'color:#4a7a95;padding:16px 20px 7px;}' +
      '#qlm-drawer a.ditem{display:flex;align-items:center;gap:12px;padding:11px 20px;color:#b8dff0;' +
        'text-decoration:none;font-size:.92rem;border-left:3px solid transparent;transition:all .15s;}' +
      '#qlm-drawer a.ditem:hover{background:rgba(0,153,216,.14);color:#fff;}' +
      '#qlm-drawer a.ditem.active{background:rgba(0,153,216,.20);color:#fff;border-left-color:#0099d8;font-weight:600;}' +
      '#qlm-drawer .dicon{font-size:1.05rem;width:22px;text-align:center;}' +
      '#qlm-drawer .dfoot{border-top:1px solid rgba(0,153,216,.25);margin-top:14px;padding:16px 20px 26px;}' +
      '#qlm-drawer .duser{font-size:.78rem;color:#b8dff0;margin-bottom:10px;word-break:break-all;}' +
      '#qlm-drawer .dsignout{width:100%;background:none;border:1px solid rgba(255,255,255,.25);color:#b8dff0;' +
        'padding:8px;border-radius:7px;cursor:pointer;font-size:.8rem;font-family:inherit;}' +
      '#qlm-drawer .dsignout:hover{border-color:#0099d8;color:#fff;}';
    document.head.appendChild(css);

    var btn = document.createElement('button');
    btn.id = 'qlm-menu-btn';
    btn.setAttribute('aria-label','Open tools menu');
    btn.innerHTML = '<span></span><span></span><span></span>';
    nav.appendChild(btn);

    var here = location.pathname.replace(/\/index\.html$/, '/');
    var groups = [], seen = {};
    NAV_ITEMS.forEach(function(it){
      if(it.admin && !admin) return;
      if(!seen[it.group]){ seen[it.group] = []; groups.push(it.group); }
      seen[it.group].push(it);
    });

    var profile = null;
    try { profile = await getProfile(); } catch(e) {}
    var who = (profile && profile.full_name) || u.email;

    var html = '<div class="dh"><span class="badge">QLM</span>' +
               '<button class="dclose" aria-label="Close menu">&times;</button></div>';
    groups.forEach(function(g){
      if(g) html += '<div class="dgroup">' + g + '</div>';
      seen[g].forEach(function(it){
        var on = (here === it.href) || (it.href !== '/' && here.indexOf(it.href) > -1);
        html += '<a class="ditem' + (on ? ' active' : '') + '" href="' + it.href + '">' +
                  '<span class="dicon">' + it.icon + '</span><span>' + it.label + '</span></a>';
      });
    });
    html += '<div class="dfoot"><div class="duser">' + who +
            (admin ? ' &middot; <strong style="color:#0099d8;">Admin</strong>' : '') + '</div>' +
            '<button class="dsignout">Sign out</button></div>';

    var bg = document.createElement('div');   bg.id = 'qlm-drawer-bg';
    var dr = document.createElement('div');   dr.id = 'qlm-drawer';   dr.innerHTML = html;
    document.body.appendChild(bg);
    document.body.appendChild(dr);

    function open(){ bg.classList.add('open'); dr.classList.add('open'); }
    function close(){ bg.classList.remove('open'); dr.classList.remove('open'); }
    btn.addEventListener('click', open);
    bg.addEventListener('click', close);
    dr.querySelector('.dclose').addEventListener('click', close);
    dr.querySelector('.dsignout').addEventListener('click', function(){ signOutAndReload(); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') close(); });
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
    mountNavMenu: mountNavMenu,
    enforceAuth: enforceAuth,
    applyRoleVisibility: applyRoleVisibility,
    lsGet: lsGet,
    lsSet: lsSet
  };

  // Auto-init when the Supabase SDK is present
  function boot(){ init(); enforceAuth(); setTimeout(mountNavMenu, 400); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
