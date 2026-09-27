#!/bin/bash
# Sandbox start: headless Blender with the MCP addon on 127.0.0.1:9876, the MCP
# server on :8000/mcp, and the Bridex job/file API on :8001 (the port the
# template waits for — it answers only once Blender is up).
cd /opt/bmcp
mkdir -p /work
/opt/blender/blender -b --factory-startup --python /opt/bmcp/headless.py > /tmp/blender.log 2>&1 &
for i in $(seq 1 120); do grep -q "listening on" /tmp/blender.log 2>/dev/null && break; sleep 0.5; done
/opt/bmcp/venv/bin/python /opt/bmcp/serve.py > /tmp/mcp.log 2>&1 &
exec python3 /opt/bmcp/bridex_api.py > /tmp/api.log 2>&1
