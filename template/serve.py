"""The upstream MCP for Blender server, unchanged, over streamable HTTP.

`uvx mcp-for-blender` speaks stdio (a local client spawns it). In a sandbox the
client is remote, so the same FastMCP instance is served over HTTP at
http://0.0.0.0:$MCP_PORT/mcp. It still talks to Blender on BLENDER_HOST:
BLENDER_PORT — the headless addon started by start.sh.
"""
import os

os.environ.setdefault("DISABLE_TELEMETRY", "1")

from blender_mcp import server  # noqa: E402
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402

server.mcp.settings.host = "0.0.0.0"
# The Host header is the sandbox's public name (8000-<id>.e2b.app), which the
# SDK's DNS-rebinding guard rejects with 421. Access is gated in front of us by
# E2B's traffic token (allow_public_traffic=False), so the guard is off here.
server.mcp.settings.transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
server.mcp.settings.port = int(os.environ.get("MCP_PORT", "8000"))
server.mcp.run(transport="streamable-http")
