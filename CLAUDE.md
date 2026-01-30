# CLAUDE.md - Guide for AI Assistants Working on Skyeyes

## What is Skyeyes?

Skyeyes is a browser-side WebSocket bridge for remote JS execution in live pages. Inspired by FunctionServer's Eye/Lens. It's a single self-contained JS file that gets injected into proxied iframes by the Nimbus server, giving Claude workers the ability to execute JavaScript, inspect the DOM, and test live pages.

## How It Works

1. Nimbus server proxies GitHub Pages through `/live/:page` and injects `<script src="/skyeyes.js" data-page="shiro"></script>`
2. On load, skyeyes connects to `ws://localhost:7777/skyeyes?page=shiro`
3. Server routes eval commands from workers/dashboard to the iframe via WebSocket
4. Skyeyes executes JS in the page context using `new Function(code)()`
5. Results (including resolved Promises) are serialized and sent back
6. Console output is monkey-patched and forwarded to the server

## File Structure

```
skyeyes.js      # The entire library - single self-contained IIFE, no dependencies
package.json    # Metadata only (no build step)
```

## Capabilities

### Core Features
- **Execute arbitrary JS** in the page's global scope
- **Async support** — automatically resolves Promises before returning
- **Timeout handling** — configurable timeouts for eval and terminal commands (default 30s)
- **Console forwarding** — `console.log/warn/error/info` output sent to server
- **Error capture** — uncaught errors and unhandled rejections forwarded
- **Auto-reconnect** — reconnects to WebSocket on disconnect (2s delay)
- **Heartbeat/ping mechanism** — 5-second interval pings for immediate disconnect detection
- **Message queuing** — queues up to 100 messages during disconnect, delivers on reconnect
- **Serialization** — handles strings, numbers, booleans, HTMLElements (outerHTML), NodeLists, JSON-serializable objects

### Terminal Integration
- **Terminal execution** — execute shell commands with exit code detection
- **Exit code detection** — captures command exit codes for proper error handling
- **Prompt detection** — identifies terminal prompts for readiness checking

### Spirit Integration (UI Automation)
- **DOM snapshot** — capture full page HTML, viewport info, and computed styles
- **CSS selector queries** — find elements with detailed metadata (rect, visibility, attributes)
- **Element interaction** — click, type, and scroll commands for UI automation
- **Visibility detection** — check if elements are visible and interactable
- **Selector generation** — auto-generate unique CSS selectors for elements

### Production Features
- **Structured errors** — detailed error objects with stack traces, timestamps, and error types
- **Batch commands** — execute multiple commands in sequence with individual result tracking
- **File transfer** — upload/download files to/from browser OS VFS (Shiro/Foam)
- **Error recovery** — graceful handling of errors with detailed context

### Performance Monitoring
- **Timing data** — duration tracking for all eval, terminal, and DOM operations
- **Health metrics** — uptime, reconnect count, message count, error rates
- **Latency tracking** — ping/pong round-trip time measurement
- **Execution stats** — count, total time, average time, error rate per operation type
- **Diagnostics endpoint** — comprehensive bridge health reporting across all pages
- **Memory monitoring** — heap usage tracking (when available)
- **System info** — viewport, user agent, page URL, document state

## API (from a Claude worker's perspective)

Workers interact with skyeyes through Nimbus REST endpoints:

```bash
# Simple GET eval (plain text response, no JSON escaping needed)
curl 'localhost:7777/api/skyeyes/shiro/eval?code=document.title'

# POST eval with timeout (JSON body, JSON response)
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"document.querySelector(\".score\").textContent", "timeout": 5000}'

# Execute terminal command with timeout and exit code detection
curl -X POST localhost:7777/api/skyeyes/shiro/terminal/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls -la", "timeout": 10000}'

# Read terminal output and status
curl localhost:7777/api/skyeyes/shiro/terminal/read

# Check terminal status (busy, ready, cwd, exit code, prompt pattern)
curl localhost:7777/api/skyeyes/shiro/terminal/status

# Reload the page
curl -X POST localhost:7777/api/skyeyes/shiro/reload

# Check connection status
curl localhost:7777/api/skyeyes/status

# Spirit Integration: DOM snapshot
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"return {html: document.documentElement.outerHTML, viewport: {width: window.innerWidth, height: window.innerHeight}, title: document.title}"}'

# Spirit Integration: Query elements
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"const el = document.querySelector(\"button\"); return el ? {tag: el.tagName, text: el.textContent, rect: el.getBoundingClientRect()} : null"}'

# Spirit Integration: Click element
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"document.querySelector(\"button\")?.click(); return {clicked: true}"}'

# Spirit Integration: Type into input
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"const input = document.querySelector(\"input\"); input.value = \"test\"; input.dispatchEvent(new Event(\"input\")); return {value: input.value}"}'

# Production: Batch command execution
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"const cmds = [\"return 1+1\", \"return 2*3\", \"return Math.pow(2,8)\"]; const results = cmds.map(c => ({result: eval(c)})); return {count: results.length, results};"}'

# Production: Error with stack trace
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"throw new Error(\"Detailed error with context\")"}'

# Performance: Diagnostics endpoint (via eval)
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"/* Diagnostics accessible via internal healthMetrics object */"}'
```

## Cross-Project Integration

- **Nimbus** (williamsharkey/nimbus): Orchestrator that hosts the WebSocket server and injects skyeyes into proxied iframes
- **Shiro** (williamsharkey/shiro): Browser OS with live GitHub Pages — primary skyeyes target
- **Foam** (williamsharkey/foam): Browser OS with live GitHub Pages — primary skyeyes target
- **Windwalker** (williamsharkey/windwalker): Test automation that uses skyeyes for browser-side test execution

## Key Design Decisions

- **No dependencies, no build step** — single IIFE that runs in any browser
- **`new Function(code)()`** for eval — runs in global scope, not skyeyes closure
- **`data-page` attribute** on script tag identifies which page this bridge serves
- **Monkey-patched console** preserves original behavior while forwarding to server
- **HTMLElement serialization** returns truncated outerHTML (2000 chars max)
- **Heartbeat every 5s** — pings server to detect disconnects immediately
- **Message queue (max 100)** — ensures message delivery across reconnections

## Spirit Integration Details

Skyeyes provides comprehensive UI automation capabilities for Spirit (AI assistant for browser automation):

### DOM Snapshot
Captures complete page state including:
- Full HTML document (outerHTML of root element)
- Viewport dimensions (width, height, scroll position)
- Document dimensions (scrollWidth, scrollHeight)
- Computed styles for visible elements (limited to 1000 elements)
- Current URL and page title
- Timestamp for tracking state changes

### Element Queries
Advanced CSS selector queries with metadata:
- Tag name, ID, classes
- Text content (truncated to 200 chars)
- HTML (truncated to 500 chars)
- All attributes as key-value pairs
- Bounding rectangle (x, y, width, height)
- Visibility status (display, visibility, opacity, size)
- Auto-generated unique CSS selector

### Element Interaction
**Click**: Scrolls element into view, waits 300ms, triggers click event
**Type**: Focuses element, optionally clears, types text, triggers input/change events
**Scroll**: Scroll element or window by x/y offset, or scroll element into view

### Helper Functions
- `generateSelector()` - Creates unique CSS selector for any element
- `isElementVisible()` - Checks display, visibility, opacity, and size
- `getElementAttributes()` - Extracts all attributes as object

## Testing

Run the end-to-end test suites:

```bash
# Ensure Nimbus server is running with skyeyes bridges connected

# Core functionality tests
./test-skyeyes.sh

# Spirit integration tests
./test-spirit-integration.sh

# Production features tests
./test-production-features.sh

# Performance monitoring tests
./test-performance-monitoring.sh

# Or specify a different base URL
./test-skyeyes.sh http://localhost:8080
./test-spirit-integration.sh http://localhost:8080
./test-production-features.sh http://localhost:8080
./test-performance-monitoring.sh http://localhost:8080
```

### Core Test Suite (`test-skyeyes.sh`)
Validates:
- Server health and connection status
- GET and POST eval endpoints
- Async promise handling
- Timeout enforcement
- Error handling
- DOM manipulation
- JSON and array serialization
- Multiple bridge support
- Type handling (undefined, null, boolean)
- Window object access

### Spirit Integration Test Suite (`test-spirit-integration.sh`)
Validates:
- DOM snapshot (viewport, dimensions)
- Element queries (querySelector, querySelectorAll)
- Element visibility detection
- Bounding box calculations
- Attribute extraction
- Computed styles
- Text content extraction
- Class list handling
- Document structure
- Scroll position tracking
- Window and document dimensions
- HTML serialization
- CSS selector generation

### Production Features Test Suite (`test-production-features.sh`)
Validates:
- Structured error recovery with stack traces
- Error object structure (name, type, message, timestamp)
- Runtime error handling (undefined properties)
- Syntax error handling
- Promise rejection errors
- Successful operations (no error cases)
- Sequential command execution
- Error recovery in sequences
- Complex object serialization
- Array operations
- Clear error messages
- Error timestamps
- Mixed success/failure handling
- Empty/undefined result handling
- Console error forwarding

### Performance Monitoring Test Suite (`test-performance-monitoring.sh`)
Validates:
- Execution count tracking
- Performance timing measurement
- Error rate calculation
- Multiple rapid executions
- Async/Promise timing
- Uptime calculation
- Memory reporting (when available)
- Viewport information
- Page information tracking
- Operation type categorization
- Sequential timing accuracy
- High-resolution timing (performance.now)
- Metric aggregation
