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

- **Execute arbitrary JS** in the page's global scope
- **Async support** — automatically resolves Promises before returning
- **Console forwarding** — `console.log/warn/error/info` output sent to server
- **Error capture** — uncaught errors and unhandled rejections forwarded
- **Auto-reconnect** — reconnects to WebSocket on disconnect (2s delay)
- **Serialization** — handles strings, numbers, booleans, HTMLElements (outerHTML), NodeLists, JSON-serializable objects

## API (from a Claude worker's perspective)

Workers interact with skyeyes through Nimbus REST endpoints:

```bash
# Simple GET eval (plain text response, no JSON escaping needed)
curl 'localhost:7777/api/skyeyes/shiro/eval?code=document.title'

# POST eval (JSON body, JSON response)
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H 'Content-Type: application/json' \
  -d '{"code":"document.querySelector(\".score\").textContent"}'

# Reload the page
curl -X POST localhost:7777/api/skyeyes/shiro/reload

# Check connection status
curl localhost:7777/api/skyeyes/status
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
