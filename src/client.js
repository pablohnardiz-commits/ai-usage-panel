/* Lógica del panel en el navegador. `summarize` se inyecta desde src/aggregate.mjs. */
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('usage-data').textContent);
  var TOOLS = ['claude', 'codex'];
  var NAMES = { claude: 'Claude Code', codex: 'Codex' };
  var state = { range: '30', metric: 'total' };
  try {
    var saved = JSON.parse(localStorage.getItem('usage-panel') || '{}');
    if (saved.range) state.range = saved.range;
    if (saved.metric) state.metric = saved.metric;
    if (saved.theme) document.documentElement.setAttribute('data-theme', saved.theme);
  } catch (e) { /* sin almacenamiento */ }

  var $ = function (id) { return document.getElementById(id); };
  var fmtFull = new Intl.NumberFormat('es-ES');
  var fmtCompact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
  var full = function (n) { return fmtFull.format(Math.round(n)); };
  var compact = function (n) { return Math.abs(n) < 10000 ? full(n) : fmtCompact.format(n); };
  var pct = function (a, b) { return b ? (100 * a / b).toFixed(a / b < 0.1 ? 1 : 0).replace('.', ',') + ' %' : '—'; };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function save() {
    try {
      localStorage.setItem('usage-panel', JSON.stringify({ range: state.range, metric: state.metric, theme: document.documentElement.getAttribute('data-theme') || '' }));
    } catch (e) { /* sin almacenamiento */ }
  }

  // Fechas como AAAA-MM-DD en horario local.
  function parseDay(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dayStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(s, n) { var d = parseDay(s); d.setDate(d.getDate() + n); return dayStr(d); }
  var MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function dayLabel(s) { var d = parseDay(s); return d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function dayLong(s) {
    var d = parseDay(s);
    return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function currentRange() {
    var to = DATA.today;
    if (state.range === 'all') {
      var first = DATA.rows.length ? DATA.rows[0].date : to;
      if (DATA.git && DATA.git.length && DATA.git[0].date < first) first = DATA.git[0].date;
      var last = DATA.rows.length ? DATA.rows[DATA.rows.length - 1].date : to;
      return { from: null, to: null, axisFrom: first, axisTo: last > to ? last : to };
    }
    var from = addDays(to, -(+state.range - 1));
    return { from: from, to: to, axisFrom: from, axisTo: to };
  }

  // ---------- Tooltip ----------
  var tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.classList.add('on');
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = x + 14, top = y - h - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 16;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { tip.classList.remove('on'); }

  // ---------- Gráfico de barras apiladas por día ----------
  function niceMax(v) {
    if (v <= 0) return { max: 1, step: 1 };
    var raw = v / 4;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10];
    var step = mag;
    for (var i = 0; i < steps.length; i++) { if (steps[i] * mag >= raw) { step = steps[i] * mag; break; } }
    return { max: Math.ceil(v / step) * step, step: step };
  }
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
  }

  function stackedChart(el, days, range, valueOf, unit, tipExtra) {
    var map = {};
    days.forEach(function (d) { map[d.date] = d; });
    var list = [];
    for (var s = range.axisFrom; s <= range.axisTo; s = addDays(s, 1)) {
      var d = map[s];
      list.push({ date: s, v: TOOLS.map(function (t) { return d ? valueOf(d[t]) : 0; }), raw: d });
      if (list.length > 3000) break;
    }
    var maxV = 0;
    list.forEach(function (it) { maxV = Math.max(maxV, it.v[0] + it.v[1]); });
    if (!maxV) {
      el.innerHTML = '<div class="empty-chart">Sin datos en este rango</div>';
      return;
    }
    var W = Math.max(280, el.clientWidth || 600), H = W < 500 ? 200 : 240;
    var m = { l: 44, r: 8, t: 10, b: 24 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    var nm = niceMax(maxV);
    var band = pw / list.length;
    var bw = Math.max(1, Math.min(24, band * 0.72));
    var gap = band > 4 ? 2 : 0;
    var y = function (v) { return m.t + ph - (v / nm.max) * ph; };
    var out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(el.getAttribute('data-label')) + '">'];
    for (var t = 0; t <= nm.max + 1e-9; t += nm.step) {
      var yy = Math.round(y(t)) + 0.5;
      out.push('<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(' + (t === 0 ? '--axis' : '--grid') + ')" stroke-width="1"/>');
      out.push('<text x="' + (m.l - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + compact(t) + '</text>');
    }
    var every = Math.max(1, Math.ceil(list.length / Math.floor(pw / 56)));
    list.forEach(function (it, i) {
      var cx = m.l + band * i + band / 2;
      if ((list.length - 1 - i) % every === 0) {
        out.push('<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + dayLabel(it.date) + '</text>');
      }
      var base = 0;
      var top = it.v[1] > 0 ? 1 : 0;
      TOOLS.forEach(function (tool, k) {
        var v = it.v[k];
        if (v <= 0) return;
        var y0 = y(base), y1 = y(base + v);
        var h = y0 - y1 - (base > 0 ? gap : 0);
        if (h < 1) h = 1;
        var x = cx - bw / 2;
        if (k === top) out.push('<path d="' + topRounded(x, y0 - (base > 0 ? gap : 0) - h, bw, h, 4) + '" fill="var(--' + tool + ')"/>');
        else out.push('<rect x="' + x + '" y="' + (y0 - h) + '" width="' + bw + '" height="' + h + '" fill="var(--' + tool + ')"/>');
        base += v;
      });
      out.push('<rect class="hit" data-i="' + i + '" x="' + (m.l + band * i) + '" y="' + m.t + '" width="' + band + '" height="' + ph + '" fill="transparent"/>');
    });
    out.push('</svg>');
    el.innerHTML = out.join('');
    var svg = el.firstChild;
    var hl = null;
    function onMove(ev) {
      var target = ev.target;
      if (!target.classList || !target.classList.contains('hit')) { hideTip(); return; }
      var it = list[+target.getAttribute('data-i')];
      if (hl && hl !== target) hl.setAttribute('fill', 'transparent');
      target.setAttribute('fill', 'var(--wash)');
      hl = target;
      var html = '<b>' + esc(dayLong(it.date)) + '</b>';
      TOOLS.forEach(function (tool, k) {
        html += '<div class="row"><span><i class="key ' + tool + '"></i>' + NAMES[tool] + '</span><span>' + full(it.v[k]) + '</span></div>';
        if (tipExtra && it.raw) html += tipExtra(it.raw[tool]);
      });
      html += '<div class="row muted"><span>Total</span><span>' + full(it.v[0] + it.v[1]) + ' ' + unit + '</span></div>';
      showTip(html, ev.clientX, ev.clientY);
    }
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerdown', onMove);
    svg.addEventListener('pointerleave', function () { if (hl) hl.setAttribute('fill', 'transparent'); hideTip(); });
  }

  // ---------- Render ----------
  function metricKey() { return state.metric === 'total' ? 'tokens' : 'tokensNoCache'; }
  function metricName() { return state.metric === 'total' ? 'Tokens totales (con caché)' : 'Tokens sin caché (entrada nueva + salida)'; }

  function renderCards(S) {
    var hasGit = !!DATA.git;
    TOOLS.forEach(function (tool) {
      var t = S.totals[tool];
      var git = hasGit
        ? '<span class="plus">+' + full(t.gitAdded) + '</span> / −' + full(t.gitRemoved) + ' <small>(' + full(t.commits) + ' commits)</small>'
        : '<small>usa --repo</small>';
      var reasoning = tool === 'codex' ? ' <small>(' + compact(t.reasoning) + ' razon.)</small>' : '';
      $('card-' + tool).innerHTML =
        '<div class="card-head"><h2><i class="key ' + tool + '"></i>' + NAMES[tool] + '</h2><span class="muted num">' + full(t.requests) + ' respuestas</span></div>' +
        '<div class="hero-label">' + esc(metricName()) + '</div>' +
        '<div class="hero" title="' + full(t[metricKey()]) + '">' + compact(t[metricKey()]) + '</div>' +
        '<dl class="stats">' +
        '<div><dt>Entrada nueva</dt><dd>' + compact(t.input) + '</dd></div>' +
        '<div><dt>Salida</dt><dd>' + compact(t.output) + reasoning + '</dd></div>' +
        '<div><dt>Caché leída</dt><dd>' + compact(t.cacheRead) + '</dd></div>' +
        '<div><dt>Caché escrita</dt><dd>' + (tool === 'codex' ? '<small>no la informa</small>' : compact(t.cacheWrite)) + '</dd></div>' +
        '<div><dt>Sesiones</dt><dd>' + full(t.sessions) + '</dd></div>' +
        '<div><dt>Días activos</dt><dd>' + full(t.activeDays) + '</dd></div>' +
        '<div><dt>Líneas escritas (est.)</dt><dd><span class="plus">+' + full(t.added) + '</span> / −' + full(t.removed) + '</dd></div>' +
        '<div><dt>Líneas en commits</dt><dd>' + git + '</dd></div>' +
        '</dl>';
    });
  }

  function renderModels(S) {
    var key = metricKey();
    var list = S.models.filter(function (m) { return m[key] > 0; }).sort(function (a, b) { return b[key] - a[key]; });
    var total = list.reduce(function (a, m) { return a + m[key]; }, 0);
    var el = $('models');
    if (!total) { el.innerHTML = '<div class="empty-chart">Sin datos en este rango</div>'; return; }
    if (list.length > 8) {
      var rest = list.slice(7);
      list = list.slice(0, 7);
      var other = { model: 'Otros (' + rest.length + ')', tool: null };
      other[key] = rest.reduce(function (a, m) { return a + m[key]; }, 0);
      list.push(other);
    }
    var max = list[0][key];
    el.innerHTML = list.map(function (m) {
      var color = m.tool ? 'var(--' + m.tool + ')' : 'var(--muted)';
      return '<div class="model-row"><div class="model-name" title="' + esc(m.model) + '"><i class="key ' + (m.tool || '') + '" style="background:' + color + '"></i>' + esc(m.model) +
        (m.tool ? ' <span class="muted">· ' + NAMES[m.tool] + '</span>' : '') + '</div>' +
        '<div class="model-bar"><i style="width:' + Math.max(0.5, 100 * m[key] / max) + '%;background:' + color + '"></i></div>' +
        '<div class="model-val">' + compact(m[key]) + ' · ' + pct(m[key], total) + '</div></div>';
    }).join('');
  }

  function renderProjects(S) {
    var key = metricKey();
    var tk = state.metric === 'total' ? 'total' : 'totalNoCache';
    var list = S.projects.slice().sort(function (a, b) { return b[tk] - a[tk] || (b.claude.added + b.codex.added) - (a.claude.added + a.codex.added); }).slice(0, 12);
    var body = list.map(function (p) {
      return '<tr><td class="trunc" title="' + esc(p.project) + '">' + esc(p.project) + '</td>' +
        '<td class="r">' + compact(p.claude[key]) + '</td><td class="r">' + compact(p.codex[key]) + '</td>' +
        '<td class="r">+' + full(p.claude.added) + ' / −' + full(p.claude.removed) + '</td>' +
        '<td class="r">+' + full(p.codex.added) + ' / −' + full(p.codex.removed) + '</td></tr>';
    }).join('');
    $('projects').innerHTML = list.length
      ? '<table><thead><tr><th>Proyecto</th><th class="r">Tokens Claude</th><th class="r">Tokens Codex</th><th class="r">Líneas Claude</th><th class="r">Líneas Codex</th></tr></thead><tbody>' + body + '</tbody></table>'
      : '<div class="empty-chart">Sin datos en este rango</div>';
  }

  function duration(a, b) {
    var ms = Date.parse(b) - Date.parse(a);
    if (!(ms > 0)) return '—';
    var min = Math.round(ms / 60000);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60);
    return h + ' h ' + String(min % 60).padStart(2, '0') + ' min';
  }

  function renderSessions(S) {
    var key = metricKey();
    var list = S.sessions.slice(0, 15);
    var body = list.map(function (s) {
      var when = new Date(s.end).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return '<tr><td class="num">' + esc(when) + '</td><td><i class="key ' + s.tool + '"></i>' + NAMES[s.tool] + '</td>' +
        '<td class="trunc" title="' + esc(s.project) + '">' + esc(s.project) + '</td>' +
        '<td class="trunc" title="' + esc(s.models.join(', ')) + '">' + esc(s.models.join(', ')) + '</td>' +
        '<td class="r">' + compact(s[key]) + '</td>' +
        '<td class="r">+' + full(s.added) + ' / −' + full(s.removed) + '</td>' +
        '<td class="r">' + duration(s.start, s.end) + '</td></tr>';
    }).join('');
    $('sessions').innerHTML = list.length
      ? '<table><thead><tr><th>Última actividad</th><th>Herramienta</th><th>Proyecto</th><th>Modelo</th><th class="r">Tokens</th><th class="r">Líneas (est.)</th><th class="r">Duración</th></tr></thead><tbody>' + body + '</tbody></table>'
      : '<div class="empty-chart">Sin sesiones en este rango</div>';
  }

  function render() {
    var r = currentRange();
    var S = summarize(DATA, r.from, r.to);
    document.querySelectorAll('[data-range]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-range') === state.range)); });
    document.querySelectorAll('[data-metric]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-metric') === state.metric)); });
    $('range-text').textContent = state.range === 'all'
      ? 'Todo el historial' + (DATA.since ? ' desde ' + dayLong(DATA.since) : '')
      : dayLong(r.from) + ' – ' + dayLong(r.to);
    $('tokens-title').textContent = state.metric === 'total' ? 'Tokens por día (con caché)' : 'Tokens por día (sin caché)';
    renderCards(S);
    var key = metricKey();
    stackedChart($('chart-tokens'), S.days, r, function (d) { return d[key]; }, 'tokens');
    stackedChart($('chart-lines'), S.days, r, function (d) { return d.added; }, 'líneas', function (d) {
      return d && d.removed ? '<div class="row muted"><span>&nbsp;&nbsp;eliminadas</span><span>−' + full(d.removed) + '</span></div>' : '';
    });
    renderModels(S);
    renderProjects(S);
    renderSessions(S);
  }

  document.querySelectorAll('[data-range]').forEach(function (b) {
    b.addEventListener('click', function () { state.range = b.getAttribute('data-range'); save(); render(); });
  });
  document.querySelectorAll('[data-metric]').forEach(function (b) {
    b.addEventListener('click', function () { state.metric = b.getAttribute('data-metric'); save(); render(); });
  });
  var themeBtn = $('theme');
  function themeLabel() {
    var t = document.documentElement.getAttribute('data-theme');
    themeBtn.textContent = t === 'dark' ? 'Tema: oscuro' : t === 'light' ? 'Tema: claro' : 'Tema: automático';
  }
  themeBtn.addEventListener('click', function () {
    var t = document.documentElement.getAttribute('data-theme');
    var next = t === 'light' ? 'dark' : t === 'dark' ? '' : 'light';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    themeLabel();
    save();
  });
  themeLabel();

  var resizeTimer;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 120); });
  window.addEventListener('scroll', hideTip, { passive: true });
  render();
})();
