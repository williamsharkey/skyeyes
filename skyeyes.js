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
  let isConnecting = false;
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
    if (isConnecting) {
      return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    isConnecting = true;
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      isConnecting = false;
      originalConsole.log(`[skyeyes] Connected as "${page}"`);
      ws.send(JSON.stringify({ type: "skyeyes_ready", page }));
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "eval") {
          executeEval(msg.id, msg.code, msg.timeout);
        } else if (msg.type === "terminal_exec") {
          executeTerminalCommand(msg.id, msg.command, msg.timeout);
        } else if (msg.type === "terminal_read") {
          readTerminalOutput(msg.id);
        } else if (msg.type === "terminal_status") {
          getTerminalStatus(msg.id);
        }
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to parse message:", err);
      }
    };

    ws.onclose = function () {
      isConnecting = false;
      originalConsole.log("[skyeyes] Disconnected, reconnecting...");
      scheduleReconnect();
    };

    ws.onerror = function () {
      isConnecting = false;
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

  function executeEval(id, code, timeout) {
    let result = null;
    let error = null;

    try {
      // Execute in the page's global scope
      result = new Function(code)();

      // Handle promises with optional timeout
      if (result && typeof result.then === "function") {
        const timeoutMs = timeout || 30000; // Default 30s timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs);
        });

        Promise.race([result, timeoutPromise])
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

  // Terminal command execution with timeout and exit code detection
  let terminalState = {
    lastCommand: null,
    lastOutput: '',
    lastError: '',
    exitCode: null,
    isReady: true,
    startTime: null,
  };

  async function executeTerminalCommand(id, command, timeout) {
    const timeoutMs = timeout || 30000; // Default 30s timeout
    terminalState.lastCommand = command;
    terminalState.lastOutput = '';
    terminalState.lastError = '';
    terminalState.exitCode = null;
    terminalState.isReady = false;
    terminalState.startTime = Date.now();

    try {
      // Try to find terminal instance (Shiro or Foam)
      const terminal = window.shiro?.terminal || window.foam?.shell?.terminal;

      if (!terminal) {
        sendResult(id, null, 'No terminal instance found');
        terminalState.isReady = true;
        return;
      }

      // Capture output
      const outputBuffer = [];
      const errorBuffer = [];

      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Terminal command timeout after ${timeoutMs}ms`)), timeoutMs);
      });

      // Execute command with output capture
      const execPromise = new Promise(async (resolve, reject) => {
        try {
          // For Shiro (TypeScript)
          if (window.shiro?.shell) {
            const shell = window.shiro.shell;
            let exitCode = 0;

            await shell.execute(command, (output) => {
              outputBuffer.push(output);
            });

            // Detect exit code from shell if available
            if (shell.lastExitCode !== undefined) {
              exitCode = shell.lastExitCode;
            }

            terminalState.exitCode = exitCode;
            terminalState.lastOutput = outputBuffer.join('');
            resolve({ exitCode, output: terminalState.lastOutput });
          }
          // For Foam (JavaScript)
          else if (window.foam?.shell) {
            const shell = window.foam.shell;

            await shell.execLive(command, {
              stdout: (text) => outputBuffer.push(text),
              stderr: (text) => errorBuffer.push(text),
            });

            // Try to detect exit code
            const exitCode = shell.lastExitCode || 0;
            terminalState.exitCode = exitCode;
            terminalState.lastOutput = outputBuffer.join('');
            terminalState.lastError = errorBuffer.join('');

            resolve({
              exitCode,
              output: terminalState.lastOutput,
              error: terminalState.lastError
            });
          }
        } catch (err) {
          terminalState.exitCode = 1;
          reject(err);
        }
      });

      const result = await Promise.race([execPromise, timeoutPromise]);
      terminalState.isReady = true;

      sendResult(id, {
        exitCode: result.exitCode,
        output: result.output,
        error: result.error || '',
        duration: Date.now() - terminalState.startTime,
      }, null);

    } catch (err) {
      terminalState.isReady = true;
      terminalState.exitCode = 1;
      sendResult(id, null, String(err));
    }
  }

  function readTerminalOutput(id) {
    try {
      sendResult(id, {
        lastCommand: terminalState.lastCommand,
        output: terminalState.lastOutput,
        error: terminalState.lastError,
        exitCode: terminalState.exitCode,
        isReady: terminalState.isReady,
      }, null);
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  function getTerminalStatus(id) {
    try {
      const terminal = window.shiro?.terminal || window.foam?.shell?.terminal;
      const shell = window.shiro?.shell || window.foam?.shell;

      sendResult(id, {
        available: !!terminal,
        ready: terminalState.isReady,
        busy: terminal?.busy || terminal?.running || false,
        cwd: shell?.cwd || shell?.vfs?.cwd || '/',
        lastExitCode: terminalState.exitCode,
        uptime: terminalState.startTime ? Date.now() - terminalState.startTime : null,
        promptPattern: detectPromptPattern(terminal),
      }, null);
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  function detectPromptPattern(terminal) {
    // Detect prompt pattern for better terminal interaction
    if (window.shiro) {
      return /user@shiro:.*\$\s*$/;
    } else if (window.foam) {
      return /user@foam:.*\$\s*$/;
    }
    return null;
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", function () {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
    }
  });

  // Connect on load
  connect();
})();
