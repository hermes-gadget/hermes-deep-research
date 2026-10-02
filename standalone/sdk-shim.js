/* Hermes plugin-SDK shim for the standalone Deep Research UI.
 *
 * Mirrors the dashboard contract that plugin bundles build against:
 *   window.__HERMES_PLUGIN_SDK__   — { React, hooks, sdkVersion }
 *   window.__HERMES_PLUGINS__      — { register, get, list, subscribe }
 * and renders the first registered component into #root.
 *
 * Load order in index.html: React UMD → ReactDOM UMD → this shim → dist/index.js
 */
(function () {
  "use strict";
  if (window.__HERMES_PLUGIN_SDK__ && window.__HERMES_PLUGINS__) return;

  var React = window.React;
  var ReactDOM = window.ReactDOM;
  if (!React || !ReactDOM) {
    showFatal("React failed to load (check /vendor/).");
    return;
  }

  var registered = new Map();
  var listeners = [];
  var mounted = false;

  function render() {
    if (mounted) return;
    var host = document.getElementById("root");
    var component = registered.get("deep-research") || registered.values().next().value;
    if (!host || !component) return;
    mounted = true;
    ReactDOM.createRoot(host).render(React.createElement(component));
  }

  function notify() {
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    render();
  }

  window.__HERMES_PLUGINS__ = window.__HERMES_PLUGINS__ || {
    register: function (name, component) { registered.set(name, component); notify(); },
    get: function (name) { return registered.get(name); },
    list: function () { return Array.from(registered.keys()); },
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };

  window.__HERMES_PLUGIN_SDK__ = window.__HERMES_PLUGIN_SDK__ || {
    sdkVersion: "standalone-shim-1",
    React: React,
    hooks: {
      useState: React.useState,
      useEffect: React.useEffect,
      useCallback: React.useCallback,
      useMemo: React.useMemo,
      useRef: React.useRef,
      useContext: React.useContext,
      createContext: React.createContext,
    },
  };

  function showFatal(msg) {
    var el = document.getElementById("boot-error");
    if (el) { el.textContent = msg; el.style.display = "block"; }
  }

  window.addEventListener("load", function () {
    setTimeout(function () {
      if (!registered.size) showFatal("Plugin bundle did not register (check that /dist/index.js loads).");
    }, 1500);
  });
})();
