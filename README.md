# bridex-plugin-e2b-blender

Blender for [Bridex](https://bridex.app) agents in an isolated cloud sandbox
([E2B](https://e2b.dev)). One sandbox per task, started on first use (~2 s —
the template snapshot already has Blender running), stopped by the agent, after
idle time, or at a maximum life. No keys ever enter the sandbox: files go in and
out through the plugin; the sandbox ports are private (E2B traffic token).

## Tools

| Tool | What it does |
|---|---|
| `blender_python` | Python (bpy) in the live scene — inline `code`, or a `script` file from a skill / artifacts with `argv`. Waits inline up to `sync_s` (150 s); longer work continues as a background job and wakes the agent. `background: true` runs a separate `blender -b` on a copy of the scene for known-long work (renders, bakes, exports). stdout, full traceback and elapsed seconds come back. |
| `blender_job` | Status / cancel / list background jobs. |
| `blender_preview` | Quick Cycles CPU render of the live scene into artifacts. |
| `blender_push` | Workspace files (artifacts, skill files) into the sandbox. |
| `blender_pull` | Sandbox files/folders into the task's artifacts, with provenance. |
| `blender_tool` | Any tool of the upstream MCP for Blender server (scene info, bpy API lookup, Poly Haven, Sketchfab, …). |
| `blender_stop` | Stop now; optionally save the scene as `.blend` into artifacts first. |

Sandbox time is recorded as spend (`e2b:blender`, seconds × `price_per_hour_usd`).

## Install

Catalog install from Settings → Plugins, or drop this folder into
`$BRIDEX_HOME/plugins/e2b-blender/`. Config (`plugins.e2b-blender.config`):

```yaml
api_key: ${E2B_API_KEY}   # or the key itself
template: bridex-blender  # built from template/
idle_s: 300
max_life_s: 3600
sync_s: 150
price_per_hour_usd: 0.33  # 4 vCPU / 8 GB at E2B list prices
```

## Template

`template/` — Blender 5.2 LTS (headless) + [MCP for Blender](https://github.com/ahujasid/blender-mcp)
(unchanged, served over HTTP on :8000/mcp) + a small stdlib job/file API on :8001
(`bridex_api.py`). `headless.py` runs the addon in `blender -b` (its timer-driven
queue does not tick without a UI) and renders previews with Cycles on the CPU.
Build in E2B's cloud, no local Docker:

```sh
cd template && E2B_API_KEY=… python build.py bridex-blender
```

CI does the same on every push that touches `template/` (`.github/workflows/template.yml`,
repo secret `E2B_API_KEY`; also runnable by hand from the Actions tab).
