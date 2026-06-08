# figma-mcp-bridge setup

(There is a very short version of this document [here](./bridge-setup-tldr.md))

[figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge) is a community-built alternative to Figma's own MCP server. It runs a Figma plugin that streams design data directly over a local WebSocket, bypassing Figma's API rate limits entirely.

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

Restart Cursor. From this point on, Cursor automatically starts the bridge as a background process whenever it opens.

### 2. Download and install the Figma plugin

From your project root, run:

```bash
npx figma-mcp bridge setup
```

The command fetches the latest release from GitHub, downloads the pre-built plugin files into `.cursor/mcp/figma-bridge-plugin/`, and prints the exact path to the manifest:

```
✓ Plugin ready.

To install in Figma Desktop:
  1. Open Figma Desktop
  2. Main menu → Plugins → Development → Import plugin from manifest
  3. Select: /path/to/project/.cursor/mcp/figma-bridge-plugin/manifest.json
```

Follow those steps in Figma. The plugin only needs to be imported once — it persists in Figma's Development plugins list.

#### Manual alternative (without npx)

If you prefer not to use the command, you can set up the plugin manually:

1. Go to [github.com/gethopp/figma-mcp-bridge/releases](https://github.com/gethopp/figma-mcp-bridge/releases) and download the source of the latest release (or clone the repo).
2. Navigate into the `plugin/` directory and install dependencies, then build:

```bash
 cd plugin
 npm install
 npm run build
```

3. Copy the entire `plugin/` folder to `.cursor/mcp/figma-bridge-plugin/` in your project (or note the path where it lives).
4. In Figma Desktop: Main menu → Plugins → Development → Import plugin from manifest, then select the `manifest.json` inside that folder.

> The build step is only required for the manual path. `npx figma-mcp bridge setup` downloads already-built distribution files directly.

### 3. Set source: bridge in figma.config.yaml

In `.cursor/mcp/figma.config.yaml`, change the source line:

```yaml
source: bridge
```

That's it. No environment variable needed — `figma-mcp` scripts read this value automatically.

---

## Troubleshooting

`**bridge: not running**`
Cursor is not open, or the bridge entry is missing from Cursor's global MCP config. Check Settings → MCP and restart Cursor.

`**plugin: not connected**`
The bridge leader must be running before the plugin can connect. Make sure Cursor is open first, then open Figma and run the plugin. If the plugin was already open when Cursor started, close and re-run it.

**Multiple Figma files open**
Set `bridge.fileKey` in `figma.config.yaml` to the exact file name (case-sensitive) of the file you want to target. Use `npx figma-mcp bridge status` to see connected file names and keys.

**Updating the plugin**
When a new version of figma-mcp-bridge is released:

```bash
npx figma-mcp bridge setup --refresh
```

Then re-import the manifest in Figma (Plugins → Development → Import plugin from manifest, same path as before).
