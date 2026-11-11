/*
 * mod.json rules from docs/mods.md, as one function that runs in Node (the playground server, test/modkit.js) and in
 * the browser. validateManifest(raw, { folder, exists }) → [{ level: 'error' | 'warning', message }].
 * `exists(relPath)` says whether a file is in the mod's folder; leave it out to skip file checks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModValidate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PERMISSIONS = ['session:read', 'session:send', 'session:control', 'sessions:read', 'model', 'skills:read', 'config:read', 'config:write', 'schedules', 'remote', 'network', 'hooks'];
  var SEATS = ['rail', 'tab', 'composer', 'background', 'worker'];
  var HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];
  var RESERVED_SEATS = ['transcript', 'status', 'sidebar'];
  var LOOK_TARGETS = ['conversation', 'composer'];
  var SETTING_TYPES = ['boolean', 'string', 'number', 'select'];
  // src/renderer/icons.ts, plus the names docs/mods.md lists that icons.ts does not have yet (gauge, message, clock)
  var ICONS = ['panel-left', 'plus', 'search', 'settings', 'trash', 'git-branch', 'globe', 'arrow-up', 'arrow-down', 'square', 'chevron-right', 'chevron-down', 'copy', 'check', 'refresh', 'arrow-left', 'arrow-right', 'external-link', 'x', 'folder', 'terminal', 'file', 'file-text', 'file-plus', 'pencil', 'list', 'search-code', 'sparkles', 'eye', 'mouse-pointer', 'keyboard', 'scroll', 'camera', 'code', 'circle-alert', 'info', 'shield-check', 'zap', 'more', 'lightbulb', 'files', 'file-check', 'clipboard', 'shield-off', 'triangle-alert', 'file-diff', 'undo', 'paperclip', 'image', 'plug', 'fold', 'rotate-ccw', 'list-checks', 'circle', 'arrow-filled', 'circle-check', 'server', 'download', 'gauge', 'message', 'clock'];
  var ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
  var VERSION_RE = /^\d+\.\d+\.\d+$/;
  var COMMAND_RE = /^[a-z0-9-]+$/;

  function isStr(v) { return typeof v === 'string' && v.trim() !== ''; }
  function safePath(p) { return typeof p === 'string' && p !== '' && !/^([a-z]+:|\/|\\)/i.test(p) && p.split(/[\\/]/).indexOf('..') < 0; }

  function validateManifest(raw, opts) {
    opts = opts || {};
    var problems = [];
    var err = function (m) { problems.push({ level: 'error', message: m }); };
    var warn = function (m) { problems.push({ level: 'warning', message: m }); };
    var m = raw;
    if (typeof raw === 'string') {
      try { m = JSON.parse(raw); } catch (e) { err('mod.json is not valid JSON: ' + e.message); return problems; }
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) { err('mod.json must be a JSON object'); return problems; }
    var exists = typeof opts.exists === 'function' ? opts.exists : null;
    var checkFile = function (p, what) {
      if (!safePath(p)) { err(what + ' "' + p + '" must be a relative path inside the mod'); return; }
      if (exists && !exists(p)) err(what + ' "' + p + '" does not exist');
    };

    if (m.protocol !== 1) err('protocol must be 1' + (m.protocol === undefined ? ' (missing)' : ', not ' + JSON.stringify(m.protocol)));
    if (typeof m.id !== 'string') err('id is required');
    else {
      if (!ID_RE.test(m.id)) err('id "' + m.id + '" must be 2 to 40 lower-case letters, digits and -, starting with a letter');
      if (opts.folder && m.id !== opts.folder) err('id "' + m.id + '" must match the folder name "' + opts.folder + '"');
    }
    if (!isStr(m.name)) err('name is required');
    if (typeof m.version !== 'string') err('version is required');
    else if (!VERSION_RE.test(m.version)) err('version "' + m.version + '" must be major.minor.patch');
    if (m.description !== undefined) {
      if (typeof m.description !== 'string') err('description must be a string');
      else if (/\n/.test(m.description)) warn('description should be one line');
    }
    ['author', 'homepage', 'license'].forEach(function (k) { if (m[k] !== undefined && typeof m[k] !== 'string') err(k + ' must be a string'); });
    var checkIcon = function (icon, where) {
      if (icon === undefined) return;
      if (typeof icon !== 'string' || !icon) { err(where + 'icon must be a string'); return; }
      if (/\.svg$/i.test(icon)) checkFile(icon, where + 'icon');
      else if (ICONS.indexOf(icon) < 0) warn(where + 'icon "' + icon + '" is not a built-in icon name');
    };
    checkIcon(m.icon, '');
    // A picture of a look or a background for its card in Settings (optional)
    var checkPreview = function (pic, where) {
      if (pic === undefined) return;
      if (typeof pic !== 'string' || !pic) { err(where + 'preview must be the path of a picture in the mod'); return; }
      if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(pic)) err(where + 'preview "' + pic + '" must be a PNG, JPEG, WebP, GIF or SVG file');
      else checkFile(pic, where + 'preview');
    };

    if (m.permissions !== undefined) {
      if (!Array.isArray(m.permissions)) err('permissions must be an array');
      else {
        var seenP = {};
        m.permissions.forEach(function (p) {
          if (typeof p !== 'string') err('permissions: every entry must be a string');
          else if (PERMISSIONS.indexOf(p) < 0) warn('permission "' + p + '" is not part of protocol 1 and will not be granted');
          else if (seenP[p]) warn('permission "' + p + '" is listed twice');
          seenP[p] = true;
        });
      }
    }

    var c = m.contributes;
    if (c === undefined) { warn('contributes nothing: no views, styles, looks, commands or settings'); return problems; }
    if (!c || typeof c !== 'object' || Array.isArray(c)) { err('contributes must be an object'); return problems; }

    var viewIds = {};
    if (c.views !== undefined) {
      if (!Array.isArray(c.views)) err('contributes.views must be an array');
      else c.views.forEach(function (v, i) {
        var at = 'views[' + i + ']' + (v && typeof v.id === 'string' ? ' "' + v.id + '"' : '') + ': ';
        if (!v || typeof v !== 'object') { err(at + 'must be an object'); return; }
        if (!isStr(v.id)) err(at + 'id is required');
        else if (viewIds[v.id]) err(at + 'id is used twice');
        else viewIds[v.id] = true;
        if (!isStr(v.title)) err(at + 'title is required');
        if (!isStr(v.entry)) err(at + 'entry is required');
        else checkFile(v.entry, at + 'entry');
        if (RESERVED_SEATS.indexOf(v.seat) >= 0) warn(at + 'seat "' + v.seat + '" is reserved for a later protocol version; the view is ignored');
        else if (SEATS.indexOf(v.seat) < 0) err(at + 'seat must be one of ' + SEATS.join(', '));
        if (v.order !== undefined && (typeof v.order !== 'number' || !isFinite(v.order))) err(at + 'order must be a number');
        if (v.maxHeight !== undefined && (typeof v.maxHeight !== 'number' || !(v.maxHeight > 0))) err(at + 'maxHeight must be a positive number');
        if ((v.order !== undefined || v.maxHeight !== undefined) && v.seat !== 'rail' && SEATS.indexOf(v.seat) >= 0) warn(at + 'order and maxHeight only apply to the rail seat');
        checkIcon(v.icon, at);
        checkPreview(v.preview, at);
      });
    }

    if (c.styles !== undefined) {
      if (!Array.isArray(c.styles)) err('contributes.styles must be an array');
      else c.styles.forEach(function (s) {
        if (typeof s !== 'string') err('styles: every entry must be a file name');
        else { checkFile(s, 'styles'); if (!/\.css$/i.test(s)) warn('styles "' + s + '" is not a .css file'); }
      });
    }

    if (c.looks !== undefined) {
      if (!Array.isArray(c.looks)) err('contributes.looks must be an array');
      else {
        var lookIds = {};
        c.looks.forEach(function (l, i) {
          var at = 'looks[' + i + ']: ';
          if (!l || typeof l !== 'object') { err(at + 'must be an object'); return; }
          if (typeof l.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(l.id)) err(at + 'id must be lower-case letters, digits and -');
          else if (lookIds[l.id]) err(at + 'id "' + l.id + '" is used twice');
          else lookIds[l.id] = true;
          if (!isStr(l.title)) err(at + 'title is required');
          if (typeof l.target !== 'string') err(at + 'target must be one of ' + LOOK_TARGETS.join(', '));
          else if (LOOK_TARGETS.indexOf(l.target) < 0) warn(at + 'target "' + l.target + '" is not a region this version knows; the look is ignored');
          if (!Array.isArray(l.styles) || !l.styles.length) err(at + 'styles must be a non-empty array of CSS files');
          else l.styles.forEach(function (f) {
            if (typeof f !== 'string') err(at + 'styles: every entry must be a file name');
            else { checkFile(f, 'looks[' + i + '].styles'); if (!/\.css$/i.test(f)) err(at + 'styles "' + f + '" is not a .css file'); }
          });
          checkPreview(l.preview, at);
        });
      }
    }

    if (c.commands !== undefined) {
      if (!Array.isArray(c.commands)) err('contributes.commands must be an array');
      else {
        var names = {};
        c.commands.forEach(function (cmd, i) {
          var at = 'commands[' + i + ']: ';
          if (!cmd || typeof cmd !== 'object') { err(at + 'must be an object'); return; }
          if (typeof cmd.name !== 'string' || !COMMAND_RE.test(cmd.name)) err(at + 'name must be lower-case letters, digits and - (no slash)');
          else if (names[cmd.name]) err(at + 'name "' + cmd.name + '" is used twice');
          else names[cmd.name] = true;
          if (!isStr(cmd.description)) err(at + 'description is required');
          if (cmd.view !== undefined && !viewIds[cmd.view]) err(at + 'view "' + cmd.view + '" is not one of the mod\'s views');
        });
      }
    }

    if (c.settings !== undefined) {
      if (!Array.isArray(c.settings)) err('contributes.settings must be an array');
      else {
        var keys = {};
        c.settings.forEach(function (s, i) {
          var at = 'settings[' + i + ']' + (s && typeof s.key === 'string' ? ' "' + s.key + '"' : '') + ': ';
          if (!s || typeof s !== 'object') { err(at + 'must be an object'); return; }
          if (!isStr(s.key)) err(at + 'key is required');
          else if (keys[s.key]) err(at + 'key is used twice');
          else keys[s.key] = true;
          if (!isStr(s.title)) err(at + 'title is required');
          if (SETTING_TYPES.indexOf(s.type) < 0) { err(at + 'type must be one of ' + SETTING_TYPES.join(', ')); return; }
          if (s.type === 'select') {
            if (!Array.isArray(s.options) || !s.options.length || s.options.some(function (o) { return typeof o !== 'string'; })) err(at + 'options must be a non-empty array of strings');
            else if (s.default !== undefined && s.options.indexOf(s.default) < 0) err(at + 'default must be one of the options');
          } else if (s.default !== undefined && typeof s.default !== s.type) err(at + 'default must be a ' + s.type);
          if (s.type === 'number') ['min', 'max', 'step'].forEach(function (k) { if (s[k] !== undefined && typeof s[k] !== 'number') err(at + k + ' must be a number'); });
        });
      }
    }

    if (c.hooks !== undefined) {
      if (!Array.isArray(c.hooks)) err('contributes.hooks must be an array of event names');
      else {
        if (c.hooks.length && !(Array.isArray(m.permissions) && m.permissions.indexOf('hooks') >= 0)) err('contributes.hooks needs the "hooks" permission');
        c.hooks.forEach(function (h, i) {
          var ev = typeof h === 'string' ? h : h && typeof h === 'object' ? h.event : undefined;
          if (typeof ev !== 'string') err('hooks[' + i + ']: must be an event name or { "event", "timeout" }');
          else if (HOOK_EVENTS.indexOf(ev) < 0) warn('hooks[' + i + ']: "' + ev + '" is not a hook event this app fires; it is ignored');
          if (h && typeof h === 'object' && h.timeout !== undefined && (typeof h.timeout !== 'number' || !(h.timeout > 0) || h.timeout > 600)) err('hooks[' + i + ']: timeout must be a number of seconds from 1 to 600');
        });
      }
    }

    // Themes (CSS for the whole app) were removed: the app loads the field and ignores it
    if (c.styles !== undefined) warn('Themes were removed; contributes.styles is ignored.');
    var views = Array.isArray(c.views) ? c.views.length : 0;
    var looks = Array.isArray(c.looks) ? c.looks.length : 0;
    var cmds = Array.isArray(c.commands) ? c.commands.length : 0;
    var sets = Array.isArray(c.settings) ? c.settings.length : 0;
    if (!views && !looks && !cmds && !sets) warn('contributes nothing: no views, looks, commands or settings');
    return problems;
  }

  /** Settings with their defaults filled in (what harness.settings.get() returns before the user changes anything). */
  function defaultSettings(m) {
    var out = {};
    var list = (m && m.contributes && Array.isArray(m.contributes.settings)) ? m.contributes.settings : [];
    list.forEach(function (s) {
      if (!s || typeof s.key !== 'string') return;
      if (s.default !== undefined) out[s.key] = s.default;
      else out[s.key] = s.type === 'boolean' ? false : s.type === 'number' ? (typeof s.min === 'number' ? s.min : 0) : s.type === 'select' ? (s.options || [])[0] : '';
    });
    return out;
  }

  return { validateManifest: validateManifest, defaultSettings: defaultSettings, PERMISSIONS: PERMISSIONS, SEATS: SEATS, LOOK_TARGETS: LOOK_TARGETS, ICONS: ICONS };
});
