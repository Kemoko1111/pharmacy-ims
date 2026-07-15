// Applies dark/light before first paint. Lives as an external file (not
// inline) so the CSP can stay `script-src 'self'` with no unsafe-inline.
(function () {
  var saved = localStorage.getItem('pt-theme');
  var dark = saved
    ? saved === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
})();
