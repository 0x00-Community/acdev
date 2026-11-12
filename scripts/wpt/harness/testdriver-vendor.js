(function () {
  var seq = 0;
  var pending = {};
  var bridge = {
    queue: [],
    done: function (id, error) {
      var p = pending[id];
      if (!p) return;
      delete pending[id];
      if (error) p.reject(new Error(error));
      else p.resolve();
    }
  };
  window.__wptdrv = bridge;

  function request(body) {
    var id = ++seq;
    body.id = id;
    bridge.queue.push(body);
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }

  function center(element) {
    var rect = element.getClientRects()[0];
    if (!rect) throw new Error("element has no client rects");
    var left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
    var top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
  }

  function resolveActions(actions) {
    var pointers = {};
    return actions.map(function (source) {
      var out = { type: source.type, id: source.id, parameters: source.parameters, actions: [] };
      source.actions.forEach(function (action) {
        var copy = {};
        for (var key in action) copy[key] = action[key];
        if ((action.type === "pointerMove" || action.type === "scroll") && action.origin && typeof action.origin === "object") {
          var c = center(action.origin);
          copy.x = c.x + (action.x || 0);
          copy.y = c.y + (action.y || 0);
          copy.origin = "viewport";
        }
        out.actions.push(copy);
      });
      return out;
    });
  }

  var internal = window.test_driver_internal;
  internal.in_automation = true;
  internal.click = function (element, coords) {
    return request({ kind: "click", x: coords.x, y: coords.y });
  };
  internal.send_keys = function (element, keys) {
    if (document.activeElement !== element) {
      element.focus();
      if (element.setSelectionRange && typeof element.value === "string") {
        try { element.setSelectionRange(element.value.length, element.value.length); } catch (e) {}
      }
    }
    return request({ kind: "keys", keys: keys });
  };
  internal.action_sequence = function (actions, context) {
    if (context && context !== window) return Promise.reject(new Error("action_sequence: other browsing contexts are not supported"));
    var resolved;
    try { resolved = resolveActions(actions); } catch (e) { return Promise.reject(e); }
    return request({ kind: "actions", actions: resolved });
  };
})();
