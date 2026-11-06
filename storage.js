/* Field Measure — storage layer.
 *
 * This is the ONLY file that knows where measurements are kept. The app talks to
 * window.FMStore and nothing else, so swapping Supabase for something else later
 * means rewriting this file and leaving the app alone.
 *
 * It is written to never block the app. If the network is down, the library fails
 * to load, or nobody is signed in, the app keeps working off its local copy and
 * the header just says so.
 */
(function () {
  'use strict';

  var CFG = window.FM_CONFIG || {};
  var client = null;          // supabase client, once the library is up
  var session = null;         // current auth session, or null
  var onStatus = function () {};
  var onRemote = function () {};
  var onReady = function () {};   // signed in and the server copy is read
  var pushTimer = null;
  var pushing = false;
  var lastPushed = '';
  var pending = null;         // newest payload waiting to go out
  var ready = false;
  var pulled = false;         // has the first read from the server finished?

  function status(mode) { try { onStatus(mode); } catch (e) {} }

  /* ---------- sign-in sheet ---------------------------------------------- */
  /* Kept in here rather than index.html so the whole auth story lives in one
     file. Styled off the app's existing CSS variables so it matches. */
  function sheet(html) {
    var w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.5);' +
      'display:flex;align-items:flex-end';
    w.innerHTML = '<div style="width:100%;background:var(--surface,#fff);color:var(--ink,#111);' +
      'border-radius:14px 14px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));' +
      'display:flex;flex-direction:column;gap:11px;font-family:var(--body,system-ui)">' + html + '</div>';
    document.body.appendChild(w);
    return w;
  }

  function askToSignIn() {
    if (!client) {
      var n = sheet('<div style="font-size:15px;line-height:1.5">No connection right now, so ' +
        'signing in will have to wait. Your measurements are saving to this phone and will ' +
        'sync once you are back online.</div>' +
        '<button id="fmok" style="border:none;border-radius:9px;padding:13px;background:var(--surface-2,#eee);' +
        'color:var(--ink,#111);font-family:var(--display,system-ui);font-size:16px;letter-spacing:.06em;' +
        'text-transform:uppercase;font-weight:700">Close</button>' +
        '<div id="fmdiag" style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;' +
        'color:var(--ink-2,#666);word-break:break-word;border-top:1px solid var(--line,#ccc);' +
        'padding-top:9px">checking offline support...</div>');
      n.querySelector('#fmok').onclick = function () { n.remove(); };
      offlineReport(n.querySelector('#fmdiag'));
      return;
    }
    if (session) {
      var s = sheet('<div style="font-family:var(--display,system-ui);font-size:19px;letter-spacing:.06em;' +
        'text-transform:uppercase;font-weight:700">Signed in</div>' +
        '<div style="font-size:14px;color:var(--ink-2,#666)">' + esc(session.user.email) + '</div>' +
        '<button id="fmout" style="border:none;border-radius:9px;padding:13px;background:var(--surface-2,#eee);' +
        'color:var(--ink,#111);font-family:var(--display,system-ui);font-size:16px;letter-spacing:.06em;' +
        'text-transform:uppercase;font-weight:700">Sign out</button>' +
        '<button id="fmcx" style="border:none;border-radius:9px;padding:11px;background:none;' +
        'color:var(--ink-2,#666);font-size:14px">Cancel</button>' +
        '<div id="fmdiag" style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;' +
        'color:var(--ink-2,#666);word-break:break-word;border-top:1px solid var(--line,#ccc);' +
        'padding-top:9px">checking offline support...</div>');
      s.querySelector('#fmcx').onclick = function () { s.remove(); };
      s.querySelector('#fmout').onclick = function () {
        s.remove();
        client.auth.signOut().then(function () { session = null; status('local'); });
      };
      offlineReport(s.querySelector('#fmdiag'));
      return;
    }

    /* Email and password, typed straight into the app. No email is sent, so
       nothing here can be rate limited, and nothing has to redirect back from
       Safari into the home-screen app. */
    var btn = 'border:none;border-radius:9px;padding:13px;font-family:var(--display,system-ui);' +
      'font-size:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700';
    var fld = 'font-size:16px;padding:12px;border:2px solid var(--line,#ccc);border-radius:9px;' +
      'background:var(--surface-2,#f4f4f4);color:var(--ink,#111);width:100%';

    var box = sheet('<div id="fmtitle" style="font-family:var(--display,system-ui);font-size:19px;' +
      'letter-spacing:.06em;text-transform:uppercase;font-weight:700">Sign in to sync</div>' +
      '<div style="font-size:13.5px;line-height:1.5;color:var(--ink-2,#666)">Measurements save to this ' +
      'phone either way. Signing in is what gets them off it.</div>' +
      '<input id="fmem" type="email" inputmode="email" autocomplete="username" ' +
      'autocapitalize="none" autocorrect="off" placeholder="you@example.com" style="' + fld + '">' +
      '<input id="fmpw" type="password" autocomplete="current-password" ' +
      'placeholder="password" style="' + fld + '">' +
      '<input id="fmpw2" type="password" autocomplete="new-password" ' +
      'placeholder="type the password again" style="' + fld + ';display:none">' +
      '<div id="fmmsg" style="font-size:13px;line-height:1.45;min-height:18px;color:var(--ink-2,#666)"></div>' +
      '<button id="fmgo" style="' + btn + ';background:var(--accent,#ff5a1f);' +
      'color:var(--accent-ink,#fff)">Sign in</button>' +
      '<button id="fmswap" style="border:none;border-radius:9px;padding:11px;background:none;' +
      'color:var(--ink-2,#666);font-size:14px;text-decoration:underline">Create an account instead</button>' +
      '<button id="fmcx" style="border:none;border-radius:9px;padding:11px;background:none;' +
      'color:var(--ink-2,#666);font-size:14px">Not now</button>' +
      '<div id="fmdiag" style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;' +
      'color:var(--ink-2,#666);word-break:break-word;border-top:1px solid var(--line,#ccc);' +
      'padding-top:9px">checking offline support...</div>');

    offlineReport(box.querySelector('#fmdiag'));
    var msg = box.querySelector('#fmmsg');
    var go = box.querySelector('#fmgo');
    var title = box.querySelector('#fmtitle');
    var swap = box.querySelector('#fmswap');
    var pw = box.querySelector('#fmpw');
    var pw2 = box.querySelector('#fmpw2');
    var creating = false;

    swap.onclick = function () {
      creating = !creating;
      title.textContent = creating ? 'Create an account' : 'Sign in to sync';
      go.textContent = creating ? 'Create account' : 'Sign in';
      swap.textContent = creating ? 'I already have an account' : 'Create an account instead';
      pw.setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
      pw2.style.display = creating ? '' : 'none';
      pw2.value = '';
      msg.textContent = creating ? 'Pick something at least 8 characters, and type it twice.' : '';
    };

    box.querySelector('#fmcx').onclick = function () { box.remove(); };

    function submit() {
      var email = (box.querySelector('#fmem').value || '').trim();
      var pass = pw.value || '';
      if (!email || !pass) { msg.textContent = 'Fill in both boxes.'; return; }
      if (creating && pass.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      if (creating && pass !== (pw2.value || '')) { msg.textContent = 'The two passwords don’t match. Type them again.'; pw2.value = ''; pw2.focus(); return; }
      go.disabled = true;
      msg.textContent = creating ? 'Creating...' : 'Signing in...';

      var call = creating
        ? client.auth.signUp({ email: email, password: pass })
        : client.auth.signInWithPassword({ email: email, password: pass });

      call.then(function (r) {
        go.disabled = false;
        if (r.error) {
          var m = (r.error.message || '').toLowerCase();
          if (m.indexOf('already registered') !== -1) {
            msg.textContent = 'That email already has an account. Sign in instead.';
          } else if (m.indexOf('invalid login') !== -1) {
            msg.textContent = 'Email or password not right.';
          } else {
            msg.textContent = r.error.message || 'That did not go through.';
          }
          return;
        }
        if (!r.data || !r.data.session) {
          /* Only happens if the project still requires email confirmation. */
          msg.textContent = 'Account made, but it needs confirming by email first.';
          return;
        }
        box.remove();
      }, function () {
        go.disabled = false;
        msg.textContent = 'Could not reach the server.';
      });
    }

    go.onclick = submit;
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !creating) submit(); });
    pw2.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  /* Offline diagnostics. Reports what the service worker and cache are actually
     doing, rather than leaving it to be inferred from whether the app loads. */
  function offlineReport(el) {
    if (!('serviceWorker' in navigator)) {
      el.textContent = 'Offline: not supported by this browser.';
      return;
    }
    var bits = [];
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      if (!regs.length) { bits.push('worker: none registered'); return null; }
      var r = regs[0];
      bits.push('worker: ' + (r.active ? 'active' : (r.installing ? 'installing' : (r.waiting ? 'waiting' : 'unknown'))));
      bits.push('controlling: ' + (navigator.serviceWorker.controller ? 'yes' : 'no'));
      return null;
    }).catch(function (e) {
      bits.push('worker: error (' + (e && e.name) + ')');
    }).then(function () {
      if (!window.caches) { bits.push('cache: unavailable'); return null; }
      return caches.keys().then(function (keys) {
        bits.push('caches: ' + (keys.length ? keys.join(', ') : 'none'));
        if (!keys.length) return null;
        return caches.open(keys[0]).then(function (c) {
          return c.keys().then(function (reqs) {
            bits.push('files cached: ' + reqs.length);
            var hasPage = reqs.some(function (q) {
              return q.url.indexOf('index.html') !== -1 || /\/field-measure\/$/.test(q.url);
            });
            bits.push('app page cached: ' + (hasPage ? 'yes' : 'NO'));
          });
        });
      }).catch(function (e) { bits.push('cache: error (' + (e && e.name) + ')'); });
    }).then(function () {
      el.textContent = bits.join(' | ');
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- pulling and pushing ---------------------------------------- */
  function pull() {
    if (!client || !session) return Promise.resolve(null);
    return client.from(CFG.table)
      .select('payload,updated')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(function (r) {
        if (r.error) return null;
        if (!r.data || !r.data.payload) return null;
        var p = r.data.payload;
        return (typeof p === 'string') ? JSON.parse(p) : p;
      }, function () { return null; });
  }

  var noTeam = false;
  function noTeamNote(st) {
    var n = sheet('<div style="font-family:var(--display,system-ui);font-size:19px;letter-spacing:.06em;' +
      'text-transform:uppercase;font-weight:700">' + (st.invite ? 'Set up your team first' : 'No invite yet') + '</div>' +
      '<div style="font-size:14px;line-height:1.5">' + (st.invite
        ? 'Open <b>Job Book</b> once and sign in there to set up your team. Until then, measurements save on this phone only, and sync after.'
        : 'This email has no invite yet, so measurements save on this phone only. Ask the person who shared the app to invite this email address.') + '</div>' +
      '<a href="../job-book/" style="display:block;text-align:center;border-radius:9px;padding:13px;background:var(--accent,#ff5a1f);' +
      'color:var(--accent-ink,#fff);font-family:var(--display,system-ui);font-size:16px;letter-spacing:.06em;text-transform:uppercase;' +
      'font-weight:700;text-decoration:none">Open Job Book</a>' +
      '<button id="fmntok" style="border:none;border-radius:9px;padding:11px;background:none;color:var(--ink-2,#666);font-size:14px">Not now</button>');
    n.querySelector('#fmntok').onclick = function () { n.remove(); };
  }

  function pushNow() {
    if (!client || !session || pushing) return Promise.resolve(false);
    if (noTeam) { status('local'); return Promise.resolve(false); }
    /* Never write before the first read has come back — see handlePulled. */
    if (!pulled) return Promise.resolve(false);
    var db = pending;
    if (!db) return Promise.resolve(false);
    var body = JSON.stringify(db);
    if (body === lastPushed) { status('ok'); return Promise.resolve(true); }
    pushing = true;
    status('saving');
    return client.from(CFG.table).upsert({
      user_id: session.user.id,
      payload: db,
      updated: db.updated || Date.now()
    }, { onConflict: 'user_id' }).then(function (r) {
      pushing = false;
      if (r.error) { status('err'); return false; }
      lastPushed = body;
      status('ok');
      return true;
    }, function () { pushing = false; status('err'); return false; });
  }

  /* ---------- Job Book: the one list of jobs ------------------------------ */
  /* Job Book (shared with Receipt Run) holds every Roberts & Associates job.
     Field Measure picks its jobs from that list and adds new ones to it, so a
     job started here shows up in Job Book and Receipt Run too. The list is
     kept on the phone so the picker still works with no signal. */
  var JB_KEY = 'fieldmeasure.jobbook.v1';
  function jbCached() {
    try { return JSON.parse(localStorage.getItem(JB_KEY) || '[]') || []; } catch (e) { return []; }
  }
  /* The team's job book: the book marked takesJobs (Roberts & Associates for
     Stephen's team, the first book of a new team). The database only ever
     returns the signed-in person's own team's books. */
  var jobBookId = null;
  function jbBook() {
    if (jobBookId) return Promise.resolve(jobBookId);
    return client.from('jobbook_books').select('id,data').then(function (r) {
      var rows = (r && r.data) || [];
      var pick = rows.filter(function (b) { return b.data && b.data.takesJobs; })[0] || null;
      jobBookId = pick ? pick.id : null;
      return jobBookId;
    }, function () { return null; });
  }
  function jbFetch() {
    if (!client || !session) return Promise.resolve(jbCached());
    return jbBook().then(function (book) {
      if (!book) return { data: [] };
      return client.from('jobbook_jobs').select('id,data').eq('book_id', book);
    }).then(function (r) {
      if (r.error || !r.data) return jbCached();
      var list = r.data.map(function (row) {
        var d = row.data || {};
        return { id: row.id, name: d.name || '', status: d.status || '', archived: !!d.archived,
                 folder: d.folder || '', code: d.code || '' };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      try { localStorage.setItem(JB_KEY, JSON.stringify(list)); } catch (e) {}
      return list;
    }, function () { return jbCached(); });
  }
  function jbAdd(name) {
    if (!client || !session) return Promise.resolve(null);
    var id = 'fm' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    return jbBook().then(function (book) {
      if (!book) return { error: { message: 'no job book' } };
      var data = { name: name, bookId: book, status: 'prospect', archived: false, waiting: false,
                   createdAt: new Date().toISOString(), createdIn: 'Field Measure' };
      return client.from('jobbook_jobs').insert({ id: id, data: data });
    }).then(function (r) {
      if (r.error) return null;
      var list = jbCached(); list.push({ id: id, name: name, status: 'prospect', archived: false, folder: '', code: '' });
      try { localStorage.setItem(JB_KEY, JSON.stringify(list)); } catch (e) {}
      return id;
    }, function () { return null; });
  }

  /* ---------- public interface ------------------------------------------- */
  window.FMStore = {

    /* Called once at startup. opts.onStatus(mode) drives the header text;
       opts.onRemote(db) is handed a newer copy from the server, if there is one. */
    init: function (opts) {
      opts = opts || {};
      onStatus = opts.onStatus || onStatus;
      onRemote = opts.onRemote || onRemote;
      onReady = opts.onReady || onReady;
      status('connecting');

      if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) {
        ready = true; status('local'); return Promise.resolve();
      }
      try {
        client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        });
      } catch (e) { ready = true; status('local'); return Promise.resolve(); }

      client.auth.onAuthStateChange(function (_e, s) {
        var was = !!session;
        session = s || null;
        if (!session) { pulled = false; status('local'); return; }
        if (!was) {
          /* The library runs this callback while holding its own lock. Calling
             the database from inside it can deadlock, and the read simply never
             comes back. Stepping outside the callback first avoids that. */
          setTimeout(function () { pull().then(handlePulled); }, 0);
        }
      });

      return client.auth.getSession().then(function (r) {
        session = (r && r.data && r.data.session) || null;
        ready = true;
        if (!session) { status('local'); return; }
        return pull().then(handlePulled);
      }, function () { ready = true; status('local'); });

      function handlePulled(remote) {
        /* No team yet (a new account): measurements stay on this phone, and
           the person is pointed at Job Book, where a team is set up. */
        client.rpc('my_team_status').then(function (r) {
          var st = r && r.data;
          if (st && !st.team) { noTeam = true; status('local'); noTeamNote(st); }
          else noTeam = false;
        }, function () {});
        if (remote && remote.jobs && remote.jobs.length) {
          try { onRemote(remote); } catch (e) {}
        }
        /* Only now is it safe to write. Before this point the app is holding
           whatever is on the phone, which on a new phone is nothing — pushing
           that would wipe the real measurements on the server. */
        pulled = true;
        /* now it's safe to tie jobs to Job Book (it may write) */
        setTimeout(function () { try { onReady(); } catch (e) {} }, 0);
        if (pending) return pushNow();
        status('ok');
      }
    },

    /* Called by the app's save(). Debounced — rapid taps make one write. */
    push: function (db) {
      pending = db;
      if (!client || !session) { status(ready ? 'local' : 'connecting'); return; }
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 1200);
    },

    /* Force an immediate write — used when the app is being backgrounded. */
    flush: function () { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } return pushNow(); },

    /* Job Book jobs: jobBook() refreshes from the server (falls back to the
       phone's copy), jobBookCached() is the phone's copy right now, and
       addToJobBook(name) creates a prospect there and resolves to its id, or
       null if it couldn't (no signal, not signed in). */
    jobBook: jbFetch,
    jobBookCached: jbCached,
    addToJobBook: jbAdd,

    /* the database connection, for the shared Feedback button (feedback.js) */
    client: function () { return client; },

    signedIn: function () { return !!session; },
    email: function () { return session ? session.user.email : null; },
    prompt: askToSignIn
  };

  /* Retry a failed write when the connection comes back, and save on the way out. */
  addEventListener('online', function () { if (session && pending) pushNow(); });
  addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && session && pending) pushNow();
  });
})();
