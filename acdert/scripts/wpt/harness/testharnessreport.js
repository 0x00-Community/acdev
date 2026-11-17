setup({ output: false, explicit_timeout: true });
add_completion_callback(function (tests, status) {
  var clip = function (text) { return text == null ? null : String(text).slice(0, 2000); };
  window.__wpt = JSON.stringify({
    status: status.status,
    message: clip(status.message),
    stack: clip(status.stack),
    tests: tests.map(function (t) { return { name: String(t.name).slice(0, 500), status: t.status, message: clip(t.message) }; })
  });
});
