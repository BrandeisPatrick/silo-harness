/*
 * Silo Harness mod kit: the `harness` object (protocol 1). Served on every mod origin as /@harness/harness.js.
 * A classic script, no build. docs/mods.md is the reference; this file is a thin layer over the wire protocol
 * (JSON-RPC 2.0 over window.parent.postMessage) described at the end of it.
 */
(function () {
  'use strict';
  if (window.harness) return;

  var PROTOCOL = 1;
  var TIMEOUT_MS = 30000;
  var ERROR_CODES = { '-32601': 'unknown-method', '-32602': 'bad-params', '4003': 'permission', '4004': 'unavailable', '4008': 'timeout' };

  var host = window.parent && window.parent !== window ? window.parent : null;
  var nextId = 1;
  var pending = {}; // id -> { resolve, reject, timer, method }
  var handlers = {}; // event name -> array of handlers
  var info = null;
  var markReady;
  var ready = new Promise(function (resolve) { markReady = resolve; });

  // ---------- wire ----------

  function clean(params) {
    if (!params || typeof params !== 'object') return params;
    var out = {};
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined) out[k] = params[k];
    return out;
  }

  function makeError(err, method) {
    err = err || {};
    var e = new Error(err.message || 'Request failed' + (method ? ': ' + method : ''));
    e.code = ERROR_CODES[String(err.code)] || 'error';
    e.rpcCode = typeof err.code === 'number' ? err.code : 4000;
    if (err.data !== undefined) e.data = err.data;
    if (e.code === 'permission') e.permission = err.data && err.data.permission;
    if (method) e.method = method;
    return e;
  }

  function send(method, params, opts) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var msg = { jsonrpc: '2.0', id: id, method: method };
      if (params !== undefined) msg.params = clean(params);
      var entry = { resolve: resolve, reject: reject, method: method, timer: null };
      if (!(opts && opts.noTimeout)) {
        entry.timer = setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(makeError({ code: 4008, message: 'Timed out after ' + TIMEOUT_MS / 1000 + ' s: ' + method }, method));
        }, TIMEOUT_MS);
      }
      pending[id] = entry;
      try {
        host.postMessage(msg, '*');
      } catch (e) {
        delete pending[id];
        if (entry.timer) clearTimeout(entry.timer);
        reject(makeError({ code: 4000, message: String((e && e.message) || e) }, method));
      }
    });
  }

  /** A call: waits for the hello answer, then goes out. */
  function call(method, params, opts) {
    if (!host) return ready.then(function () { return send(method, params, opts); });
    if (info) return send(method, params, opts);
    return ready.then(function () { return send(method, params, opts); });
  }

  function onMessage(ev) {
    if (!host || ev.source !== host) return;
    var m = ev.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.method === 'event') {
      var p = m.params || {};
      dispatch(p.name, p.data);
      return;
    }
    if (m.method === 'hook' && m.id !== undefined && m.id !== null) {
      answerHook(m.id, m.params || {});
      return;
    }
    if (m.id === undefined || m.id === null) return;
    var entry = pending[m.id];
    if (!entry) return;
    delete pending[m.id];
    if (entry.timer) clearTimeout(entry.timer);
    if (m.error) entry.reject(makeError(m.error, entry.method));
    else entry.resolve(m.result);
  }

  // ---------- events ----------

  function dispatch(name, data) {
    var list = handlers[name];
    if (!list) return;
    list.slice().forEach(function (fn) {
      try { fn(data); } catch (e) { report(e); }
    });
  }

  function on(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') throw new TypeError('harness.on(event, handler)');
    var list = handlers[name] || (handlers[name] = []);
    list.push(fn);
    if (list.length === 1) {
      call('events.subscribe', { events: [name] }).catch(function (e) {
        console.warn('[harness] could not subscribe to "' + name + '": ' + e.message);
      });
    }
    var active = true;
    return function off() {
      if (!active) return;
      active = false;
      var l = handlers[name];
      if (!l) return;
      var i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) {
        delete handlers[name];
        call('events.unsubscribe', { events: [name] }).catch(function () {});
      }
    };
  }

  // ---------- hooks (the host asks, the page answers) ----------

  var hookHandlers = {}; // event name -> handler(input) returning an output object, a promise of one, or nothing

  function reply(id, msg) {
    msg.jsonrpc = '2.0';
    msg.id = id;
    try { host.postMessage(msg, '*'); } catch (e) { /* the window went away */ }
  }

  function answerHook(id, params) {
    var fn = hookHandlers[params.event];
    if (!fn) return reply(id, { result: null });
    var out;
    try {
      out = fn(params.input || {});
    } catch (e) {
      report(e);
      return reply(id, { error: { code: 4000, message: String((e && e.message) || e) } });
    }
    Promise.resolve(out).then(
      function (r) {
        // Only a plain object is an output; anything else decides nothing.
        reply(id, { result: r && typeof r === 'object' && !Array.isArray(r) ? r : null });
      },
      function (e) {
        report(e);
        reply(id, { error: { code: 4000, message: String((e && e.message) || e) } });
      }
    );
  }

  function hookOn(event, fn) {
    if (typeof event !== 'string' || typeof fn !== 'function') throw new TypeError('harness.hooks.on(event, handler)');
    var had = !!hookHandlers[event];
    hookHandlers[event] = fn;
    if (!had) {
      call('hooks.subscribe', { events: [event] }).catch(function (e) {
        console.warn('[harness] could not handle the "' + event + '" hook: ' + e.message);
      });
    }
    return function () { hookOff(event, fn); };
  }

  function hookOff(event, fn) {
    if (!hookHandlers[event] || (fn && hookHandlers[event] !== fn)) return Promise.resolve();
    delete hookHandlers[event];
    return call('hooks.unsubscribe', { events: [event] }).catch(function () {});
  }

  // ---------- theme ----------

  var appliedTokens = [];
  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement;
    if (theme.scheme === 'light' || theme.scheme === 'dark') {
      root.setAttribute('data-theme', theme.scheme);
      root.style.setProperty('color-scheme', theme.scheme);
    }
    var tokens = theme.tokens || {};
    var next = [];
    for (var k in tokens) {
      if (!Object.prototype.hasOwnProperty.call(tokens, k) || k.indexOf('--') !== 0) continue;
      root.style.setProperty(k, String(tokens[k]));
      next.push(k);
    }
    appliedTokens.forEach(function (k) { if (next.indexOf(k) < 0) root.style.removeProperty(k); });
    appliedTokens = next;
  }

  // ---------- size (rail and composer views) ----------

  var lastHeight = -1;
  var frameQueued = false;
  function measure() {
    var el = document.documentElement;
    var h = el.getBoundingClientRect ? el.getBoundingClientRect().height : el.scrollHeight;
    return Math.ceil(h || 0);
  }
  function reportSize(force) {
    var h = measure();
    if (!force && h === lastHeight) return Promise.resolve();
    lastHeight = h;
    return call('ui.resize', { height: h });
  }
  function scheduleSize() {
    if (frameQueued) return;
    frameQueued = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () {
      frameQueued = false;
      reportSize(false).catch(function () {});
    });
  }
  function watchSize() {
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(scheduleSize).observe(document.documentElement);
    } else {
      window.addEventListener('resize', scheduleSize);
    }
    window.addEventListener('load', scheduleSize);
    scheduleSize();
  }

  // ---------- errors ----------

  var reporting = false;
  function report(err, fallback) {
    if (reporting || !host) return;
    reporting = true;
    try {
      var message = (err && err.message) || (typeof err === 'string' ? err : fallback || String(err));
      var stack = err && err.stack ? String(err.stack) : undefined;
      call('log.error', { message: String(message), stack: stack }).catch(function () {});
    } finally {
      reporting = false;
    }
  }

  // ---------- model ----------

  var running = []; // requestIds of model.complete calls in progress
  var deltaRoutes = {};
  var deltaOff = null; // one model.delta subscription shared by every call in progress
  function routeDelta(d) {
    if (d && deltaRoutes[d.requestId]) deltaRoutes[d.requestId](d.text);
  }

  function complete(request, onDelta) {
    request = Object.assign({}, request || {});
    var id = request.requestId || 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    request.requestId = id;
    deltaRoutes[id] = function (text) {
      if (typeof onDelta !== 'function') return;
      try { onDelta(text); } catch (e) { report(e); }
    };
    running.push(id);
    if (!deltaOff) deltaOff = on('model.delta', routeDelta);
    function done() {
      delete deltaRoutes[id];
      var i = running.indexOf(id);
      if (i >= 0) running.splice(i, 1);
      if (!running.length && deltaOff) { deltaOff(); deltaOff = null; }
    }
    return call('model.complete', request, { noTimeout: true }).then(
      function (r) { done(); return r; },
      function (e) { done(); throw e; }
    );
  }

  function cancel() {
    if (!running.length) return Promise.resolve();
    return Promise.all(running.slice().map(function (id) { return call('model.cancel', { requestId: id }); })).then(function () {});
  }

  // ---------- Markdown (.h-md) ----------

  // harness.ui.markdown() returns the chat's markup. Inside an .h-md element its code blocks' Copy buttons copy the
  // block, and its links open in the browser: a sandboxed frame can do neither by itself.
  var COPIED_MS = 1500;
  function noop() {}
  function flipCopied(btn) {
    var label = btn.querySelector && btn.querySelector('span');
    if (btn.__hCopied) clearTimeout(btn.__hCopied.timer);
    else btn.__hCopied = { text: label ? label.textContent : '' };
    btn.classList.add('copied');
    if (label) label.textContent = 'Copied';
    btn.__hCopied.timer = setTimeout(function () {
      btn.classList.remove('copied');
      if (label) label.textContent = btn.__hCopied.text;
      btn.__hCopied = null;
    }, COPIED_MS);
  }
  function onMarkdownClick(ev) {
    var t = ev && ev.target;
    if (t && t.nodeType === 3) t = t.parentElement; // a click on text
    if (!t || typeof t.closest !== 'function' || !t.closest('.h-md')) return;
    var btn = t.closest('.code-copy');
    if (btn) {
      ev.preventDefault();
      var block = btn.closest('.code-block');
      var code = block && (block.querySelector('pre code') || block.querySelector('pre'));
      if (!code) return;
      harness.ui.copy(code.textContent).then(
        function () { flipCopied(btn); },
        function (e) { harness.ui.toast((e && e.message) || 'Could not copy', { kind: 'error' }).catch(noop); }
      );
      return;
    }
    var a = t.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return; // a jump within the page
    ev.preventDefault();
    var url = a.href || href;
    if (/^https?:\/\//i.test(url)) harness.ui.openExternal(url).catch(noop);
  }

  // ---------- the object ----------

  function storageApi(scope) {
    return {
      get: function (key, fallback) {
        return call('storage.get', { key: key, scope: scope }).then(function (r) {
          return r && r.value !== undefined ? r.value : fallback;
        });
      },
      set: function (key, value) { return call('storage.set', { key: key, value: value, scope: scope }); },
      remove: function (key) { return call('storage.remove', { key: key, scope: scope }); },
      keys: function () {
        return call('storage.keys', scope ? { scope: scope } : {}).then(function (r) { return (r && r.keys) || []; });
      },
    };
  }

  var storage = storageApi(undefined);
  storage.session = storageApi('session');

  var harness = {
    protocol: PROTOCOL,
    ready: ready,
    info: null,
    on: on,
    /** The raw bridge: any method by name, for calls this version of the kit does not wrap. */
    call: function (method, params) { return call(method, params, method === 'model.complete' ? { noTimeout: true } : undefined); },

    ui: {
      theme: function () { return call('ui.theme'); },
      resize: function (height) {
        if (typeof height === 'number') { lastHeight = Math.ceil(height); return call('ui.resize', { height: lastHeight }); }
        return reportSize(true);
      },
      setTitle: function (title) { return call('ui.setTitle', { title: String(title) }); },
      setBadge: function (badge) { return call('ui.setBadge', { badge: badge === undefined ? null : badge }); },
      toast: function (text, opts) { return call('ui.toast', { text: String(text), kind: opts && opts.kind }); },
      open: function (view) { return call('ui.open', view === undefined ? {} : { view: view }); },
      copy: function (text) { return call('ui.copy', { text: String(text) }); },
      openExternal: function (url) { return call('ui.openExternal', { url: String(url) }); },
      markdown: function (text) { return call('ui.markdown', { text: String(text == null ? '' : text) }); },
      openSettings: function (section) { return call('ui.openSettings', section === undefined ? {} : { section: String(section) }); },
      openPage: function (page, opts) { return call('ui.openPage', Object.assign({ page: String(page) }, opts && opts.form ? { form: String(opts.form) } : {})); },
    },

    storage: storage,

    settings: {
      get: function () { return call('settings.get'); },
    },

    session: {
      get: function () { return call('session.get'); },
      transcript: function (opts) { return call('session.transcript', { limit: opts && opts.limit }); },
      tasks: function () { return call('session.tasks'); },
      plan: function () { return call('session.plan'); },
      outputs: function () { return call('session.outputs'); },
      context: function () { return call('session.context'); },
      related: function () { return call('session.related'); },
      send: function (text) { return call('session.send', { text: String(text) }); },
      stop: function () { return call('session.stop'); },
      compact: function (focus) { return call('session.compact', focus === undefined ? {} : { focus: focus }); },
    },

    outputs: {
      open: function (o) { return call('outputs.open', { kind: o && o.kind, id: o && o.id }); },
    },

    composer: {
      insert: function (text) { return call('composer.insert', { text: String(text) }); },
    },

    sessions: {
      list: function () { return call('sessions.list'); },
      search: function (query, opts) { return call('sessions.search', { query: String(query), limit: opts && opts.limit }); },
      open: function (id) { return call('sessions.open', { id: id }); },
      create: function () { return call('sessions.create'); },
      spawn: function (o) { return call('sessions.spawn', { title: o && o.title, prompt: o && o.prompt }); },
      merge: function (id) { return call('sessions.merge', { id: id }); },
    },

    model: {
      complete: complete,
      cancel: cancel,
    },

    skills: {
      // docs/mods.md: skills.list() resolves with the array itself
      list: function () { return call('skills.list').then(function (r) { return (r && r.skills) || []; }); },
      usage: function (opts) {
        var scope = typeof opts === 'string' ? opts : (opts && opts.scope) || 'session';
        return call('skills.usage', { scope: scope });
      },
    },

    config: {
      get: function () { return call('config.get'); },
      set: function (patch) { return call('config.set', { patch: patch || {} }); },
    },

    project: {
      git: function () { return call('project.git'); },
    },

    schedules: {
      list: function () { return call('schedules.list'); },
      create: function (input) { return call('schedules.create', { input: input }); },
      update: function (id, patch) { return call('schedules.update', { id: id, patch: patch || {} }); },
      remove: function (id) { return call('schedules.remove', { id: id }); },
      runNow: function (id) { return call('schedules.runNow', { id: id }); },
    },

    remote: {
      status: function () { return call('remote.status'); },
      start: function () { return call('remote.start'); },
      stop: function () { return call('remote.stop'); },
    },

    hooks: {
      /** handler(input) gets what a command hook reads on stdin and returns what it would print (or nothing). */
      on: hookOn,
      off: function (event) { return hookOff(event); },
    },
  };

  window.harness = harness;

  if (!host) {
    console.warn('[harness] This page is not inside Silo Harness (no parent frame), so harness.ready stays pending and calls wait. Open it from the app or from modkit/playground.');
    return;
  }

  window.addEventListener('message', onMessage);
  document.addEventListener('click', onMarkdownClick);
  window.addEventListener('error', function (ev) {
    report(ev && ev.error, ev && ev.message ? ev.message + (ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ')' : '') : 'Script error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var isError = r && typeof r === 'object' && typeof r.message === 'string' && typeof r.stack === 'string';
    report(isError ? r : new Error('Unhandled rejection: ' + (r && r.message ? r.message : String(r))));
  });

  // Theme follows the app from the first moment: subscribe before hello resolves (the call waits for it).
  on('theme.changed', applyTheme);

  send('hello', { protocol: PROTOCOL }, { noTimeout: true }).then(
    function (result) {
      info = result || {};
      harness.info = info;
      applyTheme(info.theme);
      markReady(info);
      var seat = info.view && info.view.seat;
      if (seat === 'rail' || seat === 'composer') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchSize);
        else watchSize();
      }
    },
    function (e) {
      console.warn('[harness] hello was refused: ' + e.message + '. harness.ready stays pending.');
    }
  );
})();
