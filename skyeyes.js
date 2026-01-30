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
  let heartbeatTimer = null;
  let messageQueue = [];
  const RECONNECT_DELAY = 2000;
  const HEARTBEAT_INTERVAL = 5000; // Send ping every 5 seconds

  // Performance monitoring and health metrics
  const healthMetrics = {
    connectTime: Date.now(),
    reconnectCount: 0,
    totalMessages: 0,
    totalErrors: 0,
    lastPingTime: null,
    lastPongTime: null,
    latency: null,
    executions: {
      eval: { count: 0, totalTime: 0, errors: 0 },
      terminal: { count: 0, totalTime: 0, errors: 0 },
      dom: { count: 0, totalTime: 0, errors: 0 },
      batch: { count: 0, totalTime: 0, errors: 0 },
      file: { count: 0, totalTime: 0, errors: 0 },
    }
  };

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

      // Start heartbeat
      startHeartbeat();

      // Send any queued messages
      flushMessageQueue();
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        healthMetrics.totalMessages++;

        if (msg.type === "pong") {
          // Server acknowledged our ping - calculate latency
          healthMetrics.lastPongTime = Date.now();
          if (healthMetrics.lastPingTime) {
            healthMetrics.latency = healthMetrics.lastPongTime - healthMetrics.lastPingTime;
          }
          return;
        } else if (msg.type === "eval") {
          executeEval(msg.id, msg.code, msg.timeout);
        } else if (msg.type === "terminal_exec") {
          executeTerminalCommand(msg.id, msg.command, msg.timeout);
        } else if (msg.type === "terminal_read") {
          readTerminalOutput(msg.id);
        } else if (msg.type === "terminal_status") {
          getTerminalStatus(msg.id);
        } else if (msg.type === "dom_snapshot") {
          getDOMSnapshot(msg.id, msg.options);
        } else if (msg.type === "query_selector") {
          querySelector(msg.id, msg.selector, msg.all);
        } else if (msg.type === "element_click") {
          elementClick(msg.id, msg.selector);
        } else if (msg.type === "element_type") {
          elementType(msg.id, msg.selector, msg.text, msg.options);
        } else if (msg.type === "element_scroll") {
          elementScroll(msg.id, msg.selector, msg.options);
        } else if (msg.type === "batch_eval") {
          executeBatchEval(msg.id, msg.commands, msg.timeout);
        } else if (msg.type === "file_upload") {
          fileUpload(msg.id, msg.path, msg.content, msg.options);
        } else if (msg.type === "file_download") {
          fileDownload(msg.id, msg.path);
        } else if (msg.type === "diagnostics") {
          getDiagnostics(msg.id);
        }
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to parse message:", err);
        healthMetrics.totalErrors++;
      }
    };

    ws.onclose = function () {
      isConnecting = false;
      stopHeartbeat();
      healthMetrics.reconnectCount++;
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

  function startHeartbeat() {
    stopHeartbeat(); // Clear any existing timer
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          healthMetrics.lastPingTime = Date.now();
          ws.send(JSON.stringify({ type: "ping", page, timestamp: healthMetrics.lastPingTime }));
        } catch (err) {
          originalConsole.error("[skyeyes] Failed to send ping:", err);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function queueMessage(message) {
    messageQueue.push({
      message,
      timestamp: Date.now(),
    });
    // Limit queue size to prevent memory issues
    if (messageQueue.length > 100) {
      messageQueue.shift(); // Remove oldest message
    }
  }

  function flushMessageQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const queue = messageQueue.slice(); // Copy queue
    messageQueue = []; // Clear original queue

    for (const item of queue) {
      try {
        ws.send(JSON.stringify(item.message));
        originalConsole.log(`[skyeyes] Sent queued message from ${item.timestamp}`);
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to send queued message:", err);
        // Re-queue failed message
        queueMessage(item.message);
      }
    }
  }

  function executeEval(id, code, timeout) {
    const startTime = Date.now();
    healthMetrics.executions.eval.count++;
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
            const duration = Date.now() - startTime;
            healthMetrics.executions.eval.totalTime += duration;
            sendResultWithTiming(id, serialize(resolved), null, startTime);
          })
          .catch((err) => {
            const duration = Date.now() - startTime;
            healthMetrics.executions.eval.totalTime += duration;
            healthMetrics.executions.eval.errors++;
            healthMetrics.totalErrors++;
            sendResultWithTiming(id, null, serializeError(err), startTime);
          });
        return;
      }

      result = serialize(result);
    } catch (err) {
      error = serializeError(err);
      healthMetrics.executions.eval.errors++;
      healthMetrics.totalErrors++;
    }

    const duration = Date.now() - startTime;
    healthMetrics.executions.eval.totalTime += duration;
    sendResultWithTiming(id, result, error, startTime);
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

  function serializeError(err) {
    // Create structured error with stack trace
    const errorObj = {
      message: err.message || String(err),
      name: err.name || 'Error',
      stack: err.stack || null,
      type: err.constructor?.name || 'Error',
      timestamp: Date.now(),
    };

    // Add additional error properties if available
    if (err.fileName) errorObj.fileName = err.fileName;
    if (err.lineNumber) errorObj.lineNumber = err.lineNumber;
    if (err.columnNumber) errorObj.columnNumber = err.columnNumber;

    // Return as JSON string for sendResult
    try {
      return JSON.stringify(errorObj);
    } catch {
      return String(err);
    }
  }

  function sendResult(id, result, error) {
    sendResultWithTiming(id, result, error, null);
  }

  function sendResultWithTiming(id, result, error, startTime) {
    const timing = startTime ? {
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    } : null;

    const message = {
      type: "skyeyes_result",
      id,
      result,
      error,
      timing
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        originalConsole.error("[skyeyes] Failed to send result, queuing:", err);
        queueMessage(message);
      }
    } else {
      // Queue message for later delivery
      originalConsole.log("[skyeyes] WebSocket not ready, queuing result");
      queueMessage(message);
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
    const startTime = Date.now();
    healthMetrics.executions.terminal.count++;
    const timeoutMs = timeout || 30000; // Default 30s timeout
    terminalState.lastCommand = command;
    terminalState.lastOutput = '';
    terminalState.lastError = '';
    terminalState.exitCode = null;
    terminalState.isReady = false;
    terminalState.startTime = startTime;

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
      const duration = Date.now() - startTime;
      healthMetrics.executions.terminal.totalTime += duration;

      sendResultWithTiming(id, {
        exitCode: result.exitCode,
        output: result.output,
        error: result.error || '',
        duration,
      }, null, startTime);

    } catch (err) {
      terminalState.isReady = true;
      terminalState.exitCode = 1;
      const duration = Date.now() - startTime;
      healthMetrics.executions.terminal.totalTime += duration;
      healthMetrics.executions.terminal.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, String(err), startTime);
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

  // Spirit Integration: DOM Snapshot for visual inspection
  function getDOMSnapshot(id, options = {}) {
    try {
      const includeStyles = options.includeStyles !== false; // Default true
      const includeScripts = options.includeScripts || false; // Default false
      const maxDepth = options.maxDepth || -1; // -1 = unlimited

      // Capture full HTML
      const html = document.documentElement.outerHTML;

      // Capture viewport information
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
      };

      // Capture computed styles for visible elements if requested
      let styles = null;
      if (includeStyles) {
        styles = {};
        const visibleElements = document.querySelectorAll('body *');
        let count = 0;
        const maxElements = 1000; // Limit to prevent huge payloads

        for (const el of visibleElements) {
          if (count >= maxElements) break;

          // Only capture visible elements
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const computedStyle = window.getComputedStyle(el);
            const selector = generateSelector(el);
            styles[selector] = {
              display: computedStyle.display,
              position: computedStyle.position,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              color: computedStyle.color,
              backgroundColor: computedStyle.backgroundColor,
              fontSize: computedStyle.fontSize,
            };
            count++;
          }
        }
      }

      sendResult(id, {
        html,
        viewport,
        styles,
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      }, null);
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Spirit Integration: CSS Selector Query
  function querySelector(id, selector, all = false) {
    const startTime = Date.now();
    healthMetrics.executions.dom.count++;

    try {
      if (!selector) {
        healthMetrics.executions.dom.errors++;
        healthMetrics.totalErrors++;
        sendResultWithTiming(id, null, 'No selector provided', startTime);
        return;
      }

      const elements = all
        ? Array.from(document.querySelectorAll(selector))
        : [document.querySelector(selector)].filter(Boolean);

      const results = elements.map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList),
        text: el.textContent?.trim().substring(0, 200) || '',
        html: el.outerHTML.substring(0, 500),
        attributes: getElementAttributes(el),
        rect: el.getBoundingClientRect(),
        visible: isElementVisible(el),
        selector: generateSelector(el),
      }));

      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;

      sendResultWithTiming(id, {
        count: results.length,
        elements: results,
        selector,
      }, null, startTime);
    } catch (err) {
      const duration = Date.now() - startTime;
      healthMetrics.executions.dom.totalTime += duration;
      healthMetrics.executions.dom.errors++;
      healthMetrics.totalErrors++;
      sendResultWithTiming(id, null, String(err), startTime);
    }
  }

  // Spirit Integration: Click element
  function elementClick(id, selector) {
    try {
      const element = document.querySelector(selector);

      if (!element) {
        sendResult(id, null, `Element not found: ${selector}`);
        return;
      }

      // Scroll element into view first
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Wait a bit for scroll, then click
      setTimeout(() => {
        try {
          // Try multiple click methods for compatibility
          if (element.click) {
            element.click();
          } else {
            const clickEvent = new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            element.dispatchEvent(clickEvent);
          }

          sendResult(id, {
            success: true,
            selector,
            element: {
              tag: element.tagName.toLowerCase(),
              text: element.textContent?.trim().substring(0, 100),
            }
          }, null);
        } catch (clickErr) {
          sendResult(id, null, String(clickErr));
        }
      }, 300);

    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Spirit Integration: Type into element
  function elementType(id, selector, text, options = {}) {
    try {
      const element = document.querySelector(selector);

      if (!element) {
        sendResult(id, null, `Element not found: ${selector}`);
        return;
      }

      // Scroll into view
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {
        try {
          // Focus the element
          element.focus();

          // Clear existing value if requested
          if (options.clear !== false) {
            element.value = '';
          }

          // Type the text
          if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
            element.value = (options.clear === false ? element.value : '') + text;

            // Trigger input event
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            // For contenteditable elements
            if (element.isContentEditable) {
              element.textContent = (options.clear === false ? element.textContent : '') + text;
              element.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              sendResult(id, null, 'Element is not typeable');
              return;
            }
          }

          sendResult(id, {
            success: true,
            selector,
            text,
            value: element.value || element.textContent,
          }, null);
        } catch (typeErr) {
          sendResult(id, null, String(typeErr));
        }
      }, 300);

    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Spirit Integration: Scroll element or window
  function elementScroll(id, selector, options = {}) {
    try {
      const x = options.x || 0;
      const y = options.y || 0;
      const behavior = options.smooth ? 'smooth' : 'auto';

      if (selector) {
        const element = document.querySelector(selector);
        if (!element) {
          sendResult(id, null, `Element not found: ${selector}`);
          return;
        }

        if (options.intoView) {
          element.scrollIntoView({ behavior, block: options.block || 'center' });
        } else {
          element.scrollBy({ left: x, top: y, behavior });
        }

        sendResult(id, {
          success: true,
          selector,
          scrollPosition: {
            x: element.scrollLeft,
            y: element.scrollTop,
          }
        }, null);
      } else {
        // Scroll window
        window.scrollBy({ left: x, top: y, behavior });

        sendResult(id, {
          success: true,
          scrollPosition: {
            x: window.scrollX,
            y: window.scrollY,
          }
        }, null);
      }
    } catch (err) {
      sendResult(id, null, String(err));
    }
  }

  // Helper: Generate unique CSS selector for an element
  function generateSelector(element) {
    if (element.id) {
      return `#${element.id}`;
    }

    const path = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.tagName.toLowerCase();

      if (current.className) {
        const classes = Array.from(current.classList)
          .filter(c => c && !c.includes(' '))
          .slice(0, 2); // Limit classes
        if (classes.length) {
          selector += '.' + classes.join('.');
        }
      }

      // Add nth-child if needed for uniqueness
      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children);
        const index = siblings.indexOf(current);
        if (siblings.length > 1) {
          selector += `:nth-child(${index + 1})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;

      // Limit depth to keep selector reasonable
      if (path.length >= 5) break;
    }

    return path.join(' > ');
  }

  // Helper: Get element attributes as object
  function getElementAttributes(element) {
    const attrs = {};
    for (const attr of element.attributes) {
      attrs[attr.name] = attr.value;
    }
    return attrs;
  }

  // Helper: Check if element is visible
  function isElementVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && rect.width > 0
      && rect.height > 0;
  }

  // Batch command execution - execute multiple commands in sequence
  async function executeBatchEval(id, commands, timeout) {
    if (!Array.isArray(commands)) {
      sendResult(id, null, serializeError(new Error('Commands must be an array')));
      return;
    }

    const results = [];
    const timeoutMs = timeout || 30000;
    const startTime = Date.now();

    try {
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];

        // Check if we've exceeded timeout
        if (Date.now() - startTime > timeoutMs) {
          results.push({
            index: i,
            code: cmd,
            result: null,
            error: serializeError(new Error(`Batch timeout after ${timeoutMs}ms at command ${i}`)),
            skipped: true
          });
          break;
        }

        try {
          const result = new Function(cmd)();

          // Handle promises
          if (result && typeof result.then === "function") {
            const remainingTime = timeoutMs - (Date.now() - startTime);
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`Command ${i} timeout`)), remainingTime);
            });

            const resolved = await Promise.race([result, timeoutPromise]);
            results.push({
              index: i,
              code: cmd.substring(0, 100),
              result: serialize(resolved),
              error: null,
              duration: Date.now() - startTime
            });
          } else {
            results.push({
              index: i,
              code: cmd.substring(0, 100),
              result: serialize(result),
              error: null,
              duration: Date.now() - startTime
            });
          }
        } catch (err) {
          results.push({
            index: i,
            code: cmd.substring(0, 100),
            result: null,
            error: serializeError(err),
            duration: Date.now() - startTime
          });

          // Stop on error unless continueOnError is set
          if (!commands[i].continueOnError) {
            break;
          }
        }
      }

      sendResult(id, {
        totalCommands: commands.length,
        executedCommands: results.length,
        results,
        totalDuration: Date.now() - startTime
      }, null);

    } catch (err) {
      sendResult(id, {
        totalCommands: commands.length,
        executedCommands: results.length,
        results,
        totalDuration: Date.now() - startTime
      }, serializeError(err));
    }
  }

  // File upload - write file to browser filesystem (Shiro/Foam VFS)
  async function fileUpload(id, path, content, options = {}) {
    try {
      // Try to access VFS from Shiro or Foam
      const vfs = window.shiro?.vfs || window.foam?.shell?.vfs;

      if (!vfs) {
        sendResult(id, null, serializeError(new Error('No VFS available (not in Shiro/Foam)')));
        return;
      }

      // Decode base64 content if specified
      let fileContent = content;
      if (options.encoding === 'base64') {
        fileContent = atob(content);
      }

      // Write file to VFS
      const resolvedPath = vfs.resolvePath(path);
      await vfs.writeFile(resolvedPath, fileContent);

      sendResult(id, {
        success: true,
        path: resolvedPath,
        size: fileContent.length,
        encoding: options.encoding || 'utf8',
        timestamp: Date.now()
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // File download - read file from browser filesystem (Shiro/Foam VFS)
  async function fileDownload(id, path) {
    try {
      // Try to access VFS from Shiro or Foam
      const vfs = window.shiro?.vfs || window.foam?.shell?.vfs;

      if (!vfs) {
        sendResult(id, null, serializeError(new Error('No VFS available (not in Shiro/Foam)')));
        return;
      }

      // Read file from VFS
      const resolvedPath = vfs.resolvePath(path);
      const content = await vfs.readFile(resolvedPath);

      // Try to determine if binary content
      const isBinary = content.some ? content.some(byte => byte === 0) : false;

      sendResult(id, {
        success: true,
        path: resolvedPath,
        content: isBinary ? btoa(content) : content,
        encoding: isBinary ? 'base64' : 'utf8',
        size: content.length,
        timestamp: Date.now()
      }, null);

    } catch (err) {
      sendResult(id, null, serializeError(err));
    }
  }

  // Diagnostics endpoint - comprehensive bridge health reporting
  function getDiagnostics(id) {
    const now = Date.now();
    const uptime = now - healthMetrics.connectTime;

    // Calculate averages
    const avgLatency = healthMetrics.latency || 0;
    const avgEvalTime = healthMetrics.executions.eval.count > 0
      ? healthMetrics.executions.eval.totalTime / healthMetrics.executions.eval.count
      : 0;
    const avgTerminalTime = healthMetrics.executions.terminal.count > 0
      ? healthMetrics.executions.terminal.totalTime / healthMetrics.executions.terminal.count
      : 0;
    const avgDomTime = healthMetrics.executions.dom.count > 0
      ? healthMetrics.executions.dom.totalTime / healthMetrics.executions.dom.count
      : 0;

    const diagnostics = {
      page,
      timestamp: now,
      uptime,
      uptimeFormatted: formatDuration(uptime),

      connection: {
        status: ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
        reconnectCount: healthMetrics.reconnectCount,
        lastPingTime: healthMetrics.lastPingTime,
        lastPongTime: healthMetrics.lastPongTime,
        latency: avgLatency,
        messageQueueSize: messageQueue.length,
      },

      traffic: {
        totalMessages: healthMetrics.totalMessages,
        totalErrors: healthMetrics.totalErrors,
        errorRate: healthMetrics.totalMessages > 0
          ? (healthMetrics.totalErrors / healthMetrics.totalMessages * 100).toFixed(2) + '%'
          : '0%',
      },

      performance: {
        eval: {
          count: healthMetrics.executions.eval.count,
          totalTime: healthMetrics.executions.eval.totalTime,
          avgTime: Math.round(avgEvalTime),
          errors: healthMetrics.executions.eval.errors,
          errorRate: healthMetrics.executions.eval.count > 0
            ? (healthMetrics.executions.eval.errors / healthMetrics.executions.eval.count * 100).toFixed(2) + '%'
            : '0%',
        },
        terminal: {
          count: healthMetrics.executions.terminal.count,
          totalTime: healthMetrics.executions.terminal.totalTime,
          avgTime: Math.round(avgTerminalTime),
          errors: healthMetrics.executions.terminal.errors,
          errorRate: healthMetrics.executions.terminal.count > 0
            ? (healthMetrics.executions.terminal.errors / healthMetrics.executions.terminal.count * 100).toFixed(2) + '%'
            : '0%',
        },
        dom: {
          count: healthMetrics.executions.dom.count,
          totalTime: healthMetrics.executions.dom.totalTime,
          avgTime: Math.round(avgDomTime),
          errors: healthMetrics.executions.dom.errors,
          errorRate: healthMetrics.executions.dom.count > 0
            ? (healthMetrics.executions.dom.errors / healthMetrics.executions.dom.count * 100).toFixed(2) + '%'
            : '0%',
        },
      },

      system: {
        userAgent: navigator.userAgent,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        memory: performance.memory ? {
          usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + ' MB',
          totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + ' MB',
          jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + ' MB',
        } : 'not available',
        pageUrl: location.href,
        pageTitle: document.title,
      },
    };

    sendResult(id, diagnostics, null);
  }

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", function () {
    stopHeartbeat();
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
