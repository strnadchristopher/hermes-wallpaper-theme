// Wallpaper Theme has no web-dashboard UI; the theme is the Desktop plugin in
// desktop/plugin.js and this package only exists to mount plugin_api.py.
// The dashboard loads every manifest's entry, so register an empty component
// for the hidden tab instead of leaving a missing-bundle error in the console.
(function () {
  var plugins = window.__HERMES_PLUGINS__;
  if (plugins && typeof plugins.register === 'function') {
    plugins.register('wallpaper-theme', function () { return null; });
  }
})();
