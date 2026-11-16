// Keeps the log-call date on today in America/New_York.
// The server renders today's date, but a tab left open past midnight still
// shows that old value. This refreshes an untouched field at load, on focus,
// and when the tab becomes visible again. A date the user picked is kept,
// including a past date. On submit, an untouched field is sent as today.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CallDate = api;
  if (typeof document !== 'undefined') {
    var boot = function () { api.install(document); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var TZ = 'America/New_York';
  function today(now) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now || new Date());
  }
  function isManual(input) {
    return input.getAttribute('data-call-date') === 'manual';
  }
  function markManual(input) {
    input.setAttribute('data-call-date', 'manual');
  }
  function noteChange(input) {
    if (input.getAttribute('data-call-date') === 'manual') return;
    var auto = input.getAttribute('data-auto-value') || '';
    if ((input.value || '') !== auto) markManual(input);
  }
  function refresh(input, now) {
    if (!input || isManual(input)) return input ? (input.value || '') : '';
    var day = today(now);
    input.setAttribute('data-auto-value', day);
    if (input.value !== day) input.value = day;
    return day;
  }
  function submitValue(input, now) {
    if (isManual(input) && /^\d{4}-\d{2}-\d{2}$/.test(input.value || '')) return input.value;
    var day = today(now);
    if (input) {
      input.setAttribute('data-auto-value', day);
      input.value = day;
    }
    return day;
  }
  function install(doc) {
    if (!doc || doc.__callDateInstalled) return;
    doc.__callDateInstalled = true;
    var refreshAll = function () {
      doc.querySelectorAll('input[data-call-date]').forEach(function (el) { refresh(el); });
    };
    var bind = function (input) {
      if (input.getAttribute('data-call-date-bound') === '1') return;
      input.setAttribute('data-call-date-bound', '1');
      refresh(input);
      input.addEventListener('change', function () { noteChange(input); });
      input.addEventListener('focus', function () { refresh(input); });
      var form = input.form;
      if (form && form.getAttribute('data-call-date-bound') !== '1') {
        form.setAttribute('data-call-date-bound', '1');
        form.addEventListener('submit', function () {
          form.querySelectorAll('input[data-call-date]').forEach(function (el) {
            el.value = submitValue(el);
          });
        });
      }
    };
    doc.querySelectorAll('input[data-call-date]').forEach(bind);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') refreshAll();
    });
    if (doc.defaultView) {
      doc.defaultView.addEventListener('focus', refreshAll);
      doc.defaultView.addEventListener('pageshow', refreshAll);
    }
  }
  return { TZ: TZ, today: today, refresh: refresh, markManual: markManual, noteChange: noteChange, submitValue: submitValue, install: install };
});
