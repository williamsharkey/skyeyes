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
- **Multiplexed sessions** — tmux-like concurrent terminal sessions (create, list, attach, detach, kill)
- **Session management** — isolated environments with separate histories, output buffers, and state
- **Background processes** — run long-running commands in detached sessions

### Spirit Integration (UI Automation)
- **DOM snapshot** — capture full page HTML, viewport info, and computed styles
- **Visual snapshot** — capture page visual state as structured description (DOM tree, visible text, layout zones, interactive elements)
- **Accessibility tree** — AI-friendly semantic page structure (roles, names, states, landmarks, headings, forms, navigation)
- **Page state diffing** — capture snapshots and compute diffs to track DOM changes (added, removed, modified elements)
- **CSS selector queries** — find elements with detailed metadata (rect, visibility, attributes)
- **Element interaction** — click, type, and scroll commands for UI automation
- **Clipboard operations** — paste text into input fields, textareas, and contenteditable elements
- **Keyboard simulation** — simulate keypress events (Enter, Tab, Ctrl+C, arrow keys, modifiers)
- **Focus management** — programmatically focus elements by selector with state tracking
- **Visibility detection** — check if elements are visible and interactable
- **Selector generation** — auto-generate unique CSS selectors for elements
- **Layout analysis** — automatic detection of header, sidebar, main content, footer zones
- **Change tracking** — detect added, removed, modified elements with detailed change information
- **Semantic understanding** — ARIA roles, accessible names, states, and landmarks for navigation

### Production Features
- **Structured errors** — detailed error objects with stack traces, timestamps, and error types
- **Batch commands** — execute multiple commands in sequence with individual result tracking
- **File transfer** — upload/download files to/from browser OS VFS (Shiro/Foam) with base64 encoding
- **Error recovery** — graceful handling of errors with detailed context
- **Binary data support** — base64 encoding/decoding for binary files over WebSocket

### DOM Observation
- **Mutation observer** — real-time DOM change tracking for Spirit (childList, attributes, characterData)
- **Change queuing** — automatic logging of mutations with configurable filters and size limits
- **Selective observation** — target specific elements, filter by type, watch only certain attributes
- **Event capture** — track element additions/removals, attribute changes, text content updates
- **Mutation log** — queryable log with type/target filtering, pagination, and automatic FIFO management

### Performance Monitoring & Analysis
- **Timing data** — duration tracking for all eval, terminal, and DOM operations
- **Health metrics** — uptime, reconnect count, message count, error rates
- **Latency tracking** — ping/pong round-trip time measurement
- **Network interception** — automatic capture of fetch and XHR requests with full details
- **Request/response logging** — URLs, methods, status codes, headers, bodies (truncated)
- **Network statistics** — request counts by method, status, type, and average duration
- **Execution stats** — count, total time, average time, error rate per operation type
- **Diagnostics endpoint** — comprehensive bridge health reporting across all pages
- **Memory monitoring** — heap usage tracking (when available)
- **System info** — viewport, user agent, page URL, document state
- **Performance profiler** — PerformanceObserver API integration for page load metrics, resource timing, paint timing
- **Core Web Vitals** — track LCP (Largest Contentful Paint), CLS (Cumulative Layout Shift), FCP (First Contentful Paint)
- **Long task detection** — identify main thread blocking tasks >50ms
- **Performance regression testing** — compare metrics over time, detect performance degradation

### Visual Testing
- **Screenshot capture** — canvas-based screenshots of elements or full viewport
- **Visual regression** — compare screenshots to detect UI changes
- **Multiple formats** — PNG (lossless) and JPEG (compressed) support
- **Screenshot cache** — store up to 10 screenshots for comparison
- **Visual comparison** — dimension matching, pixel-perfect comparison, size diff analysis

### Storage Monitoring
- **Storage usage tracking** — monitor localStorage and sessionStorage size, item count, quota usage
- **Real-time change detection** — track set, remove, and clear operations
- **Storage APIs** — read, write, and manage browser storage
- **Change log with filtering** — filter by storage type, change type, or key
- **Quota monitoring** — detect when storage is nearing capacity
- **Storage leak detection** — track storage growth over time

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

# File Transfer: Upload text file to browser OS
curl -X POST localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"const vfs = window.foam?.shell?.vfs; vfs.writeFile(\"/home/user/test.txt\", \"Hello from host!\"); return {success: true};"}'

# File Transfer: Download file from browser OS
curl -X POST localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"const vfs = window.foam?.shell?.vfs; const content = vfs.readFile(\"/home/user/test.txt\"); return {content};"}'

# File Transfer: Upload binary file (base64 encoded)
FILE_B64=$(base64 -w 0 image.png)
curl -X POST localhost:7777/api/skyeyes/foam/exec \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"const vfs = window.foam?.shell?.vfs; const decoded = atob('$FILE_B64'); vfs.writeFile('/home/user/image.png', decoded); return {success: true};\"}"
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

# File transfer tests
./test-file-transfer.sh

# Terminal sessions tests
./test-terminal-sessions.sh

# Keyboard and clipboard tests
./test-keyboard-clipboard.sh

# Visual snapshot tests
./test-visual-snapshot.sh

# Page diff tests
./test-page-diff.sh

# Accessibility tree tests
./test-accessibility-tree.sh

# Network interception tests
./test-network-interception.sh

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

### File Transfer Test Suite (`test-file-transfer.sh`)
Validates:
- VFS availability detection
- Text file read/write operations
- Base64 encoding/decoding
- Path resolution (~ expansion, relative paths)
- File existence checks
- Multiple file operations (batch)
- Binary data handling
- Error handling (invalid paths, missing files)
- UTF-8 text support
- File overwrite behavior
- Empty and large file handling
- JSON file read/write
- Directory operations

### Terminal Sessions Test Suite (`test-terminal-sessions.sh`)
Validates:
- Session state management (Map-based storage)
- Concurrent operations support
- Session ID generation (unique identifiers)
- Metadata structure (created, lastActivity, attached, running)
- Output buffering (array-based with limits)
- Command history tracking
- State transitions (running/stopped, attached/detached)
- Timestamp tracking (created, lastActivity)
- Session lookup and enumeration
- Exit code tracking per session
- Output line limiting (prevent memory issues)
- Default session auto-creation
- Session uptime calculation

### Keyboard and Clipboard Test Suite (`test-keyboard-clipboard.sh`)
Validates:
- Paste into input elements (text fields)
- Paste into textarea elements (multiline)
- Paste into contenteditable elements (rich text)
- Paste at cursor position (text insertion)
- Paste without selector (active element)
- Enter key simulation
- Tab key simulation
- Escape key simulation
- Arrow key simulation (up, down, left, right)
- Modifier key combinations (Ctrl+C, Shift+Enter)
- Focus by selector
- Focus state tracking
- Previous focus tracking
- Keypress without selector (active element)
- Element focusability detection

### Visual Snapshot Test Suite (`test-visual-snapshot.sh`)
Validates:
- Basic visual snapshot generation
- Viewport information (width, height, scroll positions)
- Document information (title, url, readyState)
- Visual tree structure (tag, depth, visible, rect)
- Element rectangles (x, y, width, height)
- Visible text extraction
- Interactive elements detection
- Layout zones (header, sidebar, main, footer)
- maxDepth option handling
- includeStyles option handling
- maxElements option handling
- Timestamp inclusion
- Timing data tracking
- Device pixel ratio
- Element selectors in interactive elements

### Page Diff Test Suite (`test-page-diff.sh`)
Validates:
- Snapshot capture (with auto-generated and custom IDs)
- Snapshot timestamp inclusion
- Element count tracking
- Capture options (includeText, maxElements)
- Snapshot listing (count, metadata)
- Diff computation between snapshots
- Diff summary (totalChanges, addedCount, removedCount, modifiedCount)
- Change arrays (added, removed, modified)
- Time delta calculation
- Clear specific snapshot
- Clear all snapshots
- Error handling for missing snapshots
- Snapshot storage (auto-cleanup after 10)
- Element path generation for identification

### Accessibility Tree Test Suite (`test-accessibility-tree.sh`)
Validates:
- Basic accessibility tree extraction
- Tree node structure (role, tag, depth)
- Landmarks extraction (banner, navigation, main, etc.)
- Headings extraction with hierarchy
- Interactive elements detection
- Forms extraction with field details
- Navigation menu extraction
- Metadata inclusion (title, url, lang, dir)
- maxDepth option handling
- includePositions option handling
- Element selectors generation
- ARIA states and properties
- Timing data tracking
- Timestamp inclusion
- Tree depth tracking

### Network Interception Test Suite (`test-network-interception.sh`)
Validates:
- Network log retrieval
- Summary statistics (totalRequests, byMethod, byStatus, byType)
- Average duration calculation
- Pagination (limit and offset options)
- Filtering by method (GET, POST, etc.)
- Filtering by status code
- Filtering by URL pattern
- Filtering by type (fetch vs xhr)
- Clear network log functionality
- Log entry structure
- Response metadata (total, filtered, returned)
- Summary aggregation

### Mutation Observer Test Suite (`test-mutation-observer.sh`)
Validates:
- Starting mutation observer
- Capturing childList mutations (element additions/removals)
- Capturing attribute mutations (with old/new values)
- Capturing characterData mutations (text changes)
- Stopping mutation observer
- Observer state management (active/inactive)
- Mutation log retrieval with filters
- Filtering by mutation type
- Filtering by target selector
- Clearing mutation log
- Log size limit enforcement (max 200 entries, FIFO)
- Custom target element observation
- Observer options handling
- Mutation entry structure
- Timestamp tracking

### Performance Profiler Test Suite (`test-performance-profiler.sh`)
Validates:
- Starting performance monitoring
- Performance snapshot retrieval
- Performance metrics collection
- Filtering by metric type
- Summary statistics generation
- Navigation timing data
- Core Web Vitals (CLS, LCP, FCP)
- Long task detection
- Clear performance log
- Stop monitoring
- Observer state management
- Custom observer types
- Log size limit enforcement (max 500 entries, FIFO)

### Screenshot Capability Test Suite (`test-screenshot.sh`)
Validates:
- Viewport screenshot capture
- Element screenshot capture
- Dimension and size info
- Data URL return option
- Screenshot cache retrieval
- Screenshot listing
- Screenshot metadata
- Visual comparison (identical screenshots)
- Visual comparison (different screenshots)
- Clear specific screenshot
- Clear all screenshots
- JPEG format support
- PNG format support
- Cache size limit enforcement (max 10, FIFO)

### Storage Monitoring Test Suite (`test-storage-monitoring.sh`)
Validates:
- Storage usage retrieval (localStorage and sessionStorage)
- Item count and size calculations
- Set localStorage item
- Get localStorage item
- Set sessionStorage item
- Get sessionStorage item
- Start storage monitoring
- Detect storage changes
- Filter by storage type
- Filter by change type
- Remove storage item
- Clear storage log
- Clear localStorage
- Clear sessionStorage
- Stop storage monitoring
- Monitoring state management
- Storage size calculation
- Storage items listing
