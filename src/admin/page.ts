/**
 * Self-contained admin dashboard for the feedback board, served same-origin from
 * the backend at GET /admin (no CORS, no separate deploy). Auth = email/password →
 * JWT; every data call is gated by User.isAdmin server-side. All user-supplied
 * content is inserted via textContent (never innerHTML) → XSS-safe.
 *
 * Inline script/style only, so keep the JS free of backticks and ${...} (this file
 * is itself a template literal).
 */
export const adminPageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>WeLockIn · Feedback admin</title>
<style>
  :root{
    --paper:#efeae0; --card:#faf7f1; --ink:#1a1714; --soft:#3a352d; --muted:#8a8175;
    --line:rgba(0,0,0,0.10); --line-soft:rgba(0,0,0,0.06); --red:#a42b1b; --redbg:#fbede9;
    --green:#1f8a5b; --amber:#c98a00; --grey:#b0a89a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;}
  .wrap{max-width:820px;margin:0 auto;padding:22px 16px 80px}
  .brand{font-weight:800;font-size:20px;letter-spacing:-0.4px}
  .brand .red{color:var(--red)}
  .sub{color:var(--muted);font-size:13px;margin-top:2px}
  .sub2{color:var(--muted);font-weight:600;font-size:13px}
  /* auth */
  .login{min-height:80vh;display:flex;align-items:center;justify-content:center}
  .auth{width:100%;max-width:340px;display:flex;flex-direction:column;gap:10px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
  input{height:46px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font-size:15px;
    background:#fff;color:var(--ink);width:100%}
  input:focus{outline:none;border-color:var(--red)}
  .btn{height:46px;border-radius:12px;border:1px solid transparent;font-size:14.5px;font-weight:700;
    cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
  .btn.primary{background:var(--red);color:#fff}
  .btn.ghost{background:transparent;border-color:var(--line);color:var(--soft)}
  .btn.small{height:36px;padding:0 14px;font-size:13px}
  .btn[disabled]{opacity:.55;cursor:default}
  .msg{font-size:13px;line-height:1.4;min-height:18px;color:var(--muted);padding:2px 2px}
  .msg.err{color:var(--red)}
  .msg.ok{color:var(--green)}
  /* board */
  .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
  .actions{display:flex;gap:8px}
  .item{background:var(--card);border:1px solid var(--line-soft);border-radius:14px;padding:14px 15px;margin-bottom:10px}
  .item.hidden{opacity:.6;border-style:dashed}
  .row1{display:flex;align-items:flex-start;gap:9px}
  .dot{width:8px;height:8px;border-radius:99px;margin-top:6px;flex:0 0 auto}
  .title{font-weight:700;font-size:15.5px;flex:1;min-width:0;line-height:1.3}
  .body{color:var(--soft);font-size:13.5px;line-height:1.45;margin:6px 0 0 17px}
  .badges{display:flex;gap:6px;flex:0 0 auto}
  .badge{font-size:11px;font-weight:700;border-radius:99px;padding:3px 8px}
  .badge.rep{background:var(--redbg);color:var(--red)}
  .badge.hid{background:#eee;color:var(--muted)}
  .badge.vote{background:#efe9dd;color:var(--soft)}
  .controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 0 17px}
  select{height:36px;border:1px solid var(--line);border-radius:10px;padding:0 10px;font-size:13px;
    background:#fff;color:var(--ink)}
  .link{background:none;border:none;color:var(--soft);font-size:13px;font-weight:600;cursor:pointer;padding:6px 6px}
  .link.danger{color:var(--red)}
  .empty{color:var(--muted);text-align:center;padding:50px 0;font-size:14px}
</style>
</head>
<body>
<div class="wrap">
  <!-- login -->
  <div id="login" class="login">
    <form id="authForm" class="auth" autocomplete="on">
      <div>
        <div class="brand">welock<span class="red">.in</span></div>
        <div class="sub">Feedback admin</div>
      </div>
      <div class="card auth">
        <input id="email" type="email" placeholder="Email" autocomplete="username" />
        <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
        <button id="loginBtn" type="submit" class="btn primary">Sign in</button>
        <button id="registerBtn" type="button" class="btn ghost">Create account</button>
        <div id="authMsg" class="msg"></div>
      </div>
    </form>
  </div>

  <!-- board -->
  <div id="board" hidden>
    <div class="topbar">
      <div class="brand">welock<span class="red">.in</span> <span class="sub2">feedback</span></div>
      <div class="actions">
        <button id="refreshBtn" class="btn small ghost">Refresh</button>
        <button id="logoutBtn" class="btn small ghost">Sign out</button>
      </div>
    </div>
    <div id="boardMsg" class="msg"></div>
    <div id="list"></div>
  </div>
</div>

<script>
(function(){
  var TOKEN_KEY = 'welockin.admin.token';
  var STATUSES = ['open','planned','in_progress','done','declined'];
  var LABEL = { open:'Under review', planned:'Planned', in_progress:'In progress', done:'Shipped', declined:'Not planned' };
  var DOT = { open:'#b0a89a', planned:'#c98a00', in_progress:'#a42b1b', done:'#1f8a5b', declined:'#b0a89a' };

  function $(id){ return document.getElementById(id); }
  function token(){ return localStorage.getItem(TOKEN_KEY); }
  function setToken(t){ localStorage.setItem(TOKEN_KEY, t); }
  function clearToken(){ localStorage.removeItem(TOKEN_KEY); }

  async function api(path, opts){
    opts = opts || {};
    var headers = { 'Content-Type':'application/json' };
    var t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var text = await res.text();
    var data = text ? JSON.parse(text) : null;
    if (!res.ok){
      var err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function show(view){
    $('login').hidden = (view !== 'login');
    $('board').hidden = (view !== 'board');
  }
  function setMsg(el, text, kind){
    el.textContent = text || '';
    el.className = 'msg' + (kind ? (' ' + kind) : '');
  }

  // ---- auth ----
  async function doAuth(kind){
    var email = $('email').value.trim();
    var password = $('password').value;
    if (!email || !password){ setMsg($('authMsg'), 'Enter email and password.', 'err'); return; }
    $('loginBtn').disabled = true; $('registerBtn').disabled = true;
    setMsg($('authMsg'), kind === 'register' ? 'Creating account…' : 'Signing in…', '');
    try {
      var r = await api(kind === 'register' ? '/api/auth/register' : '/api/auth/login',
        { method:'POST', body:{ email: email, password: password } });
      setToken(r.token);
      await enterBoard();
    } catch (e){
      if (kind === 'register' && e.status === 409){
        setMsg($('authMsg'), 'That email already has an account — sign in instead.', 'err');
      } else {
        setMsg($('authMsg'), e.message || 'Failed.', 'err');
      }
    } finally {
      $('loginBtn').disabled = false; $('registerBtn').disabled = false;
    }
  }

  async function enterBoard(){
    try {
      await load();
      show('board');
    } catch (e){
      if (e.status === 403){
        // Authenticated but not an admin yet.
        setMsg($('authMsg'),
          'Signed in, but this account is not an admin yet. On the server run: npm run feedback:set-admin -- --email ' + ($('email').value.trim() || '<email>') + '  then reload.',
          'err');
        show('login');
      } else if (e.status === 401){
        clearToken(); show('login');
      } else {
        setMsg($('authMsg'), e.message || 'Failed to load.', 'err'); show('login');
      }
    }
  }

  // ---- board ----
  async function load(){
    setMsg($('boardMsg'), 'Loading…', '');
    var data = await api('/api/feedback/admin');
    render(data.requests || []);
    setMsg($('boardMsg'), (data.requests || []).length + ' requests · most-reported first', '');
  }

  function badge(cls, text){
    var b = document.createElement('span');
    b.className = 'badge ' + cls;
    b.textContent = text;
    return b;
  }

  function item(fr){
    var el = document.createElement('div');
    el.className = 'item' + (fr.hidden ? ' hidden' : '');

    var row1 = document.createElement('div'); row1.className = 'row1';
    var dot = document.createElement('span'); dot.className = 'dot';
    dot.style.background = DOT[fr.status] || '#b0a89a';
    var title = document.createElement('span'); title.className = 'title'; title.textContent = fr.title;
    var badges = document.createElement('span'); badges.className = 'badges';
    badges.appendChild(badge('vote', String(fr.voteCount) + ' \\u25B2'));
    if (fr.reportCount > 0) badges.appendChild(badge('rep', String(fr.reportCount) + ' reports'));
    if (fr.hidden) badges.appendChild(badge('hid', 'hidden'));
    row1.appendChild(dot); row1.appendChild(title); row1.appendChild(badges);
    el.appendChild(row1);

    if (fr.body){
      var body = document.createElement('div'); body.className = 'body'; body.textContent = fr.body;
      el.appendChild(body);
    }

    var controls = document.createElement('div'); controls.className = 'controls';

    var sel = document.createElement('select');
    STATUSES.forEach(function(s){
      var o = document.createElement('option'); o.value = s; o.textContent = LABEL[s]; sel.appendChild(o);
    });
    sel.value = fr.status;
    sel.onchange = function(){ changeStatus(fr, sel.value, el); };
    controls.appendChild(sel);

    var hideBtn = document.createElement('button');
    hideBtn.className = 'link';
    hideBtn.textContent = fr.hidden ? 'Un-hide' : 'Hide';
    hideBtn.onclick = function(){ toggleHidden(fr, !fr.hidden, el); };
    controls.appendChild(hideBtn);

    var delBtn = document.createElement('button');
    delBtn.className = 'link danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = function(){ removeItem(fr, el); };
    controls.appendChild(delBtn);

    el.appendChild(controls);
    return el;
  }

  function render(list){
    var root = $('list');
    root.textContent = '';
    if (!list.length){
      var empty = document.createElement('div'); empty.className = 'empty';
      empty.textContent = 'No feature requests yet.';
      root.appendChild(empty); return;
    }
    list.forEach(function(fr){ root.appendChild(item(fr)); });
  }

  async function changeStatus(fr, status, el){
    try {
      await api('/api/feedback/' + fr.id + '/status', { method:'PATCH', body:{ status: status } });
      fr.status = status;
      var dot = el.querySelector('.dot'); if (dot) dot.style.background = DOT[status] || '#b0a89a';
    } catch (e){ handleErr(e); }
  }

  async function toggleHidden(fr, hidden, el){
    try {
      await api('/api/feedback/' + fr.id + '/hidden', { method:'PATCH', body:{ hidden: hidden } });
      await load();
    } catch (e){ handleErr(e); }
  }

  async function removeItem(fr, el){
    if (!window.confirm('Delete this request for everyone? This cannot be undone.')) return;
    try {
      await api('/api/feedback/' + fr.id, { method:'DELETE' });
      el.parentNode && el.parentNode.removeChild(el);
    } catch (e){ handleErr(e); }
  }

  function handleErr(e){
    if (e.status === 401){ clearToken(); show('login'); setMsg($('authMsg'), 'Session expired — sign in again.', 'err'); return; }
    setMsg($('boardMsg'), e.message || 'Action failed.', 'err');
  }

  // ---- wire up ----
  $('authForm').addEventListener('submit', function(ev){ ev.preventDefault(); doAuth('login'); });
  $('registerBtn').addEventListener('click', function(){ doAuth('register'); });
  $('refreshBtn').addEventListener('click', function(){ load().catch(handleErr); });
  $('logoutBtn').addEventListener('click', function(){ clearToken(); show('login'); });

  // Resume a stored session.
  if (token()) enterBoard(); else show('login');
})();
</script>
</body>
</html>`;
