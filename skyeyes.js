// skyeyes.js - Browser-side bridge for remote JS execution
// Injected into proxied GitHub Pages iframes by Nimbus server.
// Connects via WebSocket to allow Claude workers to execute JS in the page context.
(function () {
  "use strict";

  const scriptTag = document.currentScript;
  const page = scriptTag?.getAttribute("data-page") || "unknown";
  const wsUrl = `ws://${location.host}/skyeyes?page=${encodeURIComponent(page)}`;

  let ws = null;
  let reconnectTimer = null;
  const RECONNECT_DELAY = 2000;

  // Monkey-patch console to forward output
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  function forwardConsole(level, args) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const serialized = Array.from(args).map((a) => {
          try {
            return typeof a === "object" ? JSON.stringify(a) : String(a);
          } catch {
            return String(a);
          }
        });
        ws.send(JSON.stringify({ type: "skyeyes_console", level, args: serialized }));
      } catch {}
    }
  }

  ["log", "warn", "error", "info"].forEach((level) => {
    console[level] = function (...args) {
      originalConsole[level](...args);
      forwardConsole(level, args);
    };
  });

  // Capture uncaught errors
  window.addEventListener("error", (e) => {
    forwardConsole("error", [`Uncaught: ${e.message} at ${e.filename}:${e.lineno}`]);
  });

  window.addEventListener("unhandledrejection", (e) => {
    forwardConsole("error", [`Unhandled rejection: ${e.reason}`]);
  });

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      originalConsole.log(`[skyeyes] Connected as "${page}"`);
      ws.send(JSON.stringify({ type: "skyeyes_ready", page }));
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "eval") {
          executeEval(msg.id, msg.code);
        }
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to parse message:", err);
      }
    };

    ws.onclose = function () {
      originalConsole.log("[skyeyes] Disconnected, reconnecting...");
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY);
  }

  function executeEval(id, code) {
    let result = null;
    let error = null;

    try {
      // Execute in the page's global scope
      result = new Function(code)();

      // Handle promises
      if (result && typeof result.then === "function") {
        result
          .then((resolved) => {
            sendResult(id, serialize(resolved), null);
          })
          .catch((err) => {
            sendResult(id, null, String(err));
          });
        return;
      }

      result = serialize(result);
    } catch (err) {
      error = String(err);
    }

    sendResult(id, result, error);
  }

  function serialize(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof HTMLElement) return value.outerHTML.substring(0, 2000);
    if (value instanceof NodeList || value instanceof HTMLCollection) {
      return `[${Array.from(value).length} elements]`;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function sendResult(id, result, error) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "skyeyes_result", id, result, error }));
    }
  }

  // Connect on load
  connect();
})();
