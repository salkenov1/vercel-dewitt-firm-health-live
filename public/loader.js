// Fetches the dashboard's data from /api/metrics, then starts app.js.
//
// app.js reads window.SAMPLE_DATA on its first line, so it cannot be loaded
// from index.html directly - the data has to be in place first. This file is
// the only script index.html loads; it injects app.js once the fetch resolves.
//
// It owns three states the original preview never needed: loading, empty and
// error. None of them silently show a zero.
(function () {
  var SINCE = '2025-01-01';
  var root = document.getElementById('dash-root');
  // This script runs at the end of <body>, so the dashboard markup is fully
  // parsed. Keep a copy before the spinner overwrites it, and put it back
  // before app.js runs - app.js expects every element index.html declared.
  var SHELL = root ? root.innerHTML : '';

  function panel(title, body, tone) {
    if (!root) return;
    root.innerHTML =
      '<div role="status" style="max-width:42rem;margin:16vh auto;padding:28px 30px;' +
      'border-radius:20px;background:var(--color-panel);' +
      'box-shadow:0 14px 36px -10px rgba(30,40,80,.22);' +
      'font-family:var(--font-anthropic-sans);color:var(--color-fg)">' +
      '<p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.04em;' +
      'text-transform:uppercase;color:' + (tone === 'bad' ? 'var(--color-bad)' : 'var(--color-fg-muted)') +
      '">DeWitt Law &middot; Firm Health</p>' +
      '<h1 style="margin:0 0 10px;font-size:23px;letter-spacing:-.02em">' + title + '</h1>' +
      '<p style="margin:0;color:var(--color-fg-muted);font-size:14px;line-height:1.55">' +
      body + '</p></div>';
  }

  function spinner() {
    panel('Loading the warehouse…',
      'Querying the gold tables in BigQuery. The first request after a quiet ' +
      'period takes a few seconds while the function wakes up.');
  }

  function badge(asOf, source) {
    var el = document.getElementById('fh-asof') || document.querySelector('.fh-sample');
    if (!el) return;
    el.textContent = asOf ? 'Live data · ' + asOf : 'Live data';
    if (source) el.title = 'Source: ' + source;
  }

  function boot() {
    var s = document.createElement('script');
    s.src = 'app.js';
    s.onerror = function () {
      panel('Could not start', 'The dashboard code (app.js) failed to load.', 'bad');
    };
    document.body.appendChild(s);
  }

  spinner();

  fetch('/api/metrics?since=' + encodeURIComponent(SINCE), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
    .then(function (r) {
      return r.text().then(function (t) {
        var d;
        try {
          d = JSON.parse(t);
        } catch (e) {
          // The access gate answers with HTML, not JSON, once the cookie expires.
          throw new Error(r.status === 401
            ? 'Your session expired. Reload the page and sign in again.'
            : 'The server replied with something that was not data (HTTP ' + r.status + ').');
        }
        if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    })
    .then(function (d) {
      if (d._empty || !d.metrics_daily || !d.metrics_daily.length) {
        panel('No data yet',
          (d._message || 'The warehouse returned no rows.') +
          '<br><br>This usually means the nightly Dataform run has not finished, ' +
          'or the date range starts after the last loaded day.');
        return;
      }
      window.SAMPLE_DATA = d;
      window.FH_AS_OF = d._as_of || '';
      window.FH_SOURCE = d._source || '';
      if (root) root.innerHTML = SHELL;   // restore the real markup
      badge(window.FH_AS_OF, window.FH_SOURCE);
      boot();
    })
    .catch(function (e) {
      panel('Data unavailable',
        (e && e.message ? e.message : 'Unknown error') +
        '<br><br>The dashboard reads BigQuery through /api/metrics on every load. ' +
        'Nothing is cached in the page, so there is no stale copy to fall back to.',
        'bad');
    });
})();
