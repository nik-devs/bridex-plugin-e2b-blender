# bridex-plugin-e2b-blender

Blender for [Bridex](https://bridex.app) agents in an isolated cloud sandbox
([E2B](https://e2b.dev)). One sandbox per task, started on first use (~2 s —
the template snapshot already has Blender running), stopped by the agent, after
idle time, or at a maximum life. No keys ever enter the sandbox: files go in and
out through the plugin; the sandbox ports are private (E2B traffic token).

## Tools

| Tool | What it does |
|---|---|
| `blender_python` | Python (bpy) in the live scene — inline `code`, or a `script` file from a skill, artifacts or the task's checkout with `argv` (its folder goes along, subfolders too; unchanged files are not sent again; the folder's modules are imported fresh on every run). Waits inline up to `sync_s` (150 s); longer work continues as a background job and wakes the agent. `background: true` runs a separate `blender -b` on a copy of the scene for known-long work (renders, bakes, exports). stdout, full traceback and elapsed seconds come back. |
| `blender_job` | Status / cancel / list background jobs. |
| `blender_preview` | Quick Cycles CPU render of the live scene into artifacts, through the scene camera or from given `views` (front/back/left/right/top orthographic, three_quarter), framing everything or the named `objects`. |
| `blender_push` | Workspace files (artifacts, skill files, the task's checkout) into the sandbox. |
| `blender_pull` | Sandbox files/folders into the task's artifacts, with provenance: a folder's contents land in `to` (subfolders kept), up to 500 files, more is reported. |
| `blender_tool` | Any tool of the upstream MCP for Blender server (scene info, bpy API lookup, Poly Haven, Sketchfab, …). |
| `blender_stop` | Stop now; optionally save the scene as `.blend` into artifacts first. |

Before a timer stops a sandbox (idle or max life), a scene the agent built in it is saved to `artifacts/blender/<task>/autosave.blend`, and the next sandbox of the task says so; the last 15 minutes of a sandbox's life are announced in tool results.

Sandbox time is recorded as spend (`e2b:blender`, seconds × `price_per_hour_usd`).

## Install

Catalog install from Settings → Plugins, or drop this folder into
`$BRIDEX_HOME/plugins/e2b-blender/`. Config (`plugins.e2b-blender.config`):

```yaml
api_key: ${E2B_API_KEY}   # or the key itself
template: ""             # empty = the plugin builds its own in your account
idle_s: 1200
max_life_s: 3600
sync_s: 150
price_per_hour_usd: 0.33  # 4 vCPU / 8 GB at E2B list prices
```

## Template

`template/` — Blender 5.2 LTS (headless) + [MCP for Blender](https://github.com/ahujasid/blender-mcp)
(unchanged, served over HTTP on :8000/mcp) + a small stdlib job/file API on :8001
(`bridex_api.py`). `headless.py` runs the addon in `blender -b` (its timer-driven
queue does not tick without a UI) and renders previews with Cycles on the CPU.

A template belongs to one E2B team, so the plugin builds it itself, in the
account of the key it is given (`template/template.mjs`): on activation it looks
for `bridex-blender-<hash of the template files>` and, when missing, builds it in
E2B's cloud in the background. Agents asking for Blender meanwhile are told to
come back in a few minutes; Settings → Plugins → Check shows the state (and
retries a failed build). A new plugin version with changed template files builds
its own new template the same way. Set `template` in the config only to use one
you built yourself.
