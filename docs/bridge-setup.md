# figma-mcp-bridge setup

[figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) is a community-built alternative to Figma's own MCP server. It runs a Figma plugin that streams design data directly over a local WebSocket, bypassing Figma's API rate limits entirely (200 calls/day on Pro, 6/month on free).

Use `source: bridge` in `figma.config.yaml` when rate limits are a constraint. Switch back to `source: desktop` at any time with no other changes.

---

## Prerequisites

- Figma Desktop app
- Cursor IDE (the bridge runs as a persistent background process managed by Cursor's MCP config)
- Node.js with npm

---

## One-time setup

### 1. Add the bridge to Cursor's global MCP settings

Open Cursor → Settings → MCP and add:

```json
{
  "figma-bridge": {
    "command": "npx",
    "args": ["-y", "@gethopp/figma-mcp-bridge"]
  }
}
```

Restart Cursor. From this point on, Cursor automatically starts the bridge as a background process (the "leader" on port 1994) whenever it opens.

### 2. Download and install the Figma plugin

From your project root, run:

```bash
npx figma-mcp bridge setup
```

The command downloads the plugin files and prints the exact path to the manifest:

```
✓ Plugin ready.

To install in Figma Desktop:
  1. Open Figma Desktop
  2. Main menu → Plugins → Development → Import plugin from manifest
  3. Select: /path/to/project/.cursor/mcp/figma-bridge-plugin/manifest.json
```

Follow those steps in Figma. The plugin only needs to be imported once — it persists in Figma's Development plugins list.

### 3. Set source: bridge in figma.config.yaml

In `.cursor/mcp/figma.config.yaml`, change the source line:

```yaml
source: bridge
```

That's it. No environment variable needed — `figma-mcp` scripts read this value automatically.

---

## Per-session workflow

Each time you want to warm the cache:

1. **Open Cursor** — this starts the bridge leader on port 1994.
2. **Open your Figma file** in Figma Desktop.
3. **Run the plugin** — Plugins → Development → Figma MCP Bridge. The plugin connects to the running leader automatically.
4. **Verify the connection** (optional but useful):
   ```bash
   npx figma-mcp bridge status
   ```
   Expected output:
   ```
     bridge   running v0.0.12
     plugin   1 file(s) connected
              · My Design File (abc123)
   ```
5. **Warm the cache:**
   ```bash
   npx figma-mcp cache warm --refresh
   ```

---

## Troubleshooting

**`bridge: not running`**
Cursor is not open, or the bridge entry is missing from Cursor's global MCP config. Check Settings → MCP and restart Cursor.

**`plugin: not connected`**
The bridge leader must be running before the plugin can connect. Make sure Cursor is open first, then open Figma and run the plugin. If the plugin was already open when Cursor started, close and re-run it.

**Multiple Figma files open**
Set `bridge.fileKey` in `figma.config.yaml` to the exact file name (case-sensitive) of the file you want to target. Use `npx figma-mcp bridge status` to see connected file names and keys.

**Updating the plugin**
When a new version of figma-mcp-bridge is released:
```bash
npx figma-mcp bridge setup --refresh
```
Then re-import the manifest in Figma (Plugins → Development → Import plugin from manifest, same path as before).

**Switching back to Figma Desktop MCP**
Change `source: desktop` in `figma.config.yaml`. No other changes needed.
