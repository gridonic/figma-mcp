# figma-mcp-bridge setup (TL;DR)

**1. Cursor → Settings → MCP — add:**

```json
{
  "figma-bridge": {
    "command": "npx",
    "args": ["-y", "@gethopp/figma-mcp-bridge"]
  }
}
```

Restart Cursor.

**2. Download and import the Figma plugin:**

```bash
npx figma-mcp bridge setup
```

In Figma Desktop: Main menu → Plugins → Development → Import plugin from manifest → select the path printed by the command.

**3. In `.cursor/mcp/figma.config.yaml`:**

```yaml
source: bridge
```
