import fs from "node:fs";
import path from "node:path";

/**
 * e2b-blender: Blender for Bridex agents in an E2B sandbox.
 *
 * One sandbox per task (per conversation when there is no task), created on
 * first use (~2 s — the template snapshot already has Blender running),
 * extended on every call and while background jobs run, stopped by
 * blender_stop, after idle_s without calls, or at max_life_s. E2B's own timer
 * backs this up: a sandbox dies on its timeout even if the instance is down.
 *
 * Inside the sandbox (template/ in this repo): headless Blender with the MCP
 * for Blender addon, the MCP server on :8000/mcp, and a small job/file API on
 * :8001. Ports are not public (allow_public_traffic=false) — every request
 * carries the sandbox's traffic token. No keys ever enter the sandbox: files
 * go in and out through the plugin.
 *
 * Long work never hits a wall: python in the live scene waits inline up to
 * sync_s and then continues as a background job; blender_python with
 * background=true runs a separate `blender -b` on a copy of the scene. Either
 * way the agent is woken in its session when the job lands (ctx.jobs keeps the
 * job across a server restart).
 */

const API = "https://api.e2b.app";
const POLL_MS = 10_000;
const WATCH_MS = 20_000;
const TEXT_CAP = 6000;

export default async function activate(ctx) {
  const { z, log } = ctx;
  const cfg = ctx.config ?? {};
  const resolve = (v) => String(v ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
  const apiKey = resolve(cfg.api_key || "${E2B_API_KEY}");
  const template = String(cfg.template || "bridex-blender");
  const idleS = Number(cfg.idle_s) > 0 ? Number(cfg.idle_s) : 300;
  const maxLifeS = Number(cfg.max_life_s) > 0 ? Number(cfg.max_life_s) : 3600;
  const syncS = Math.min(170, Number(cfg.sync_s) > 0 ? Number(cfg.sync_s) : 150);
  const pricePerHour = Number(cfg.price_per_hour_usd ?? 0.33) || 0;
  if (!apiKey) {
    ctx.needsConfig("set the E2B API key (plugins.e2b-blender.config.api_key, or ${E2B_API_KEY} in the environment)");
    return;
  }

  // -- durable state: live sandboxes + background jobs ----------------------

  const stateDir = path.join(ctx.paths.state, "e2b-blender");
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "sandboxes.json");
  /** @type {Record<string, any>} key → sandbox */
  let boxes = {};
  try {
    boxes = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    /* first boot */
  }
  const persist = () => fs.writeFileSync(stateFile, JSON.stringify(boxes, null, 2));
  /** jobs we poll: trackId → {box key, jobId, ...} */
  const pending = new Map();

  const e2b = async (method, p, body) => {
    const res = await fetch(`${API}${p}`, {
      method,
      headers: { "X-API-KEY": apiKey, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`E2B ${method} ${p}: HTTP ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  };

  const keyOf = (call) => `${call.workspace}:${call.taskId ?? call.sessionKey ?? call.agent}`;
  const hostOf = (box, port) => `https://${port}-${box.id}.${box.domain || "e2b.app"}`;

  async function sbx(box, method, p, body, raw) {
    const res = await fetch(`${hostOf(box, 8001)}${p}`, {
      method,
      headers: { "e2b-traffic-access-token": box.traffic, ...(raw ? {} : { "content-type": "application/json" }) },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
      ...(raw ? { duplex: "half" } : {}),
    });
    if (raw === "download") {
      if (!res.ok) throw new Error(`sandbox ${p}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`sandbox ${p}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok && res.status !== 409) throw new Error(`sandbox ${p}: ${data.error ?? `HTTP ${res.status}`}`);
    return data;
  }

  function recordSpend(box, reason) {
    try {
      const seconds = Math.max(1, Math.round((Date.now() - box.createdAt) / 1000));
      ctx.usage.record({
        workspace: box.workspace,
        agent: box.agent,
        kind: "e2b:blender",
        model: template,
        costUsd: (seconds / 3600) * pricePerHour,
        units: seconds,
        unit: "s",
        taskId: box.taskId ?? null,
      });
      log.info(`sandbox ${box.id} for @${box.agent} ended (${reason}) after ${seconds}s`);
    } catch (e) {
      log.warn(`usage record failed: ${e.message}`);
    }
  }

  function forget(key, reason) {
    const box = boxes[key];
    if (!box) return;
    recordSpend(box, reason);
    delete boxes[key];
    persist();
  }

  async function boxFor(call) {
    const key = keyOf(call);
    const have = boxes[key];
    if (have) {
      try {
        await e2b("POST", `/sandboxes/${have.id}/timeout`, { timeout: idleS });
        have.lastUse = Date.now();
        persist();
        return have;
      } catch (e) {
        if (e.status !== 404) throw e;
        forget(key, "gone");
      }
    }
    const t0 = Date.now();
    const s = await e2b("POST", "/sandboxes", {
      templateID: template,
      timeout: idleS,
      secure: true,
      network: { allow_public_traffic: false },
      metadata: { bridex_workspace: call.workspace, bridex_agent: call.agent, bridex_task: String(call.taskId ?? "") },
    });
    const box = {
      id: s.sandboxID,
      domain: s.domain || null,
      traffic: s.trafficAccessToken,
      workspace: call.workspace,
      agent: call.agent,
      taskId: call.taskId ?? null,
      sessionKey: call.sessionKey ?? null,
      createdAt: Date.now(),
      lastUse: Date.now(),
    };
    boxes[key] = box;
    persist();
    log.info(`sandbox ${box.id} started for @${call.agent} in ${Date.now() - t0} ms`);
    return box;
  }

  // -- files between artifacts and the sandbox ------------------------------

  const artifactsRoot = (ws) => ctx.paths.workspaceArtifacts(ws);
  const inside = (p, root) => {
    const r = path.relative(root, p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  /** A workspace file: artifacts/…, a skill's file (<skill>/scripts/x.py), or an absolute path in the workspace. */
  function workspaceFile(ws, p) {
    const s = String(p);
    const wsRoot = path.join(ctx.paths.home, "workspaces", ws);
    const abs = s.startsWith("artifacts/")
      ? path.join(artifactsRoot(ws), s.slice("artifacts/".length))
      : path.isAbsolute(s)
        ? s
        : path.join(ctx.paths.workspaceSkills(ws), s);
    if (!inside(abs, wsRoot)) throw new Error(`not a file in this workspace: ${s}`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${s}`);
    return abs;
  }

  async function push(box, abs, dest) {
    const data = fs.readFileSync(abs);
    await sbx(box, "PUT", `/files?path=${encodeURIComponent(dest)}`, data, true);
    return { dest, size: data.length };
  }

  async function pull(box, call, src, subdir, description) {
    const buf = await sbx(box, "GET", `/files?path=${encodeURIComponent(src)}`, undefined, "download");
    const folder = subdir || `blender/${call.taskId ?? "chat"}`;
    // keep the sandbox layout under /work (out/front/view0.png and out/back/view0.png
    // must not overwrite each other); files elsewhere keep their name
    const under = src.startsWith("/work/") ? src.slice("/work/".length) : path.posix.basename(src);
    const rel = path.posix.join(folder, under);
    const abs = path.join(artifactsRoot(call.workspace), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    try {
      ctx.artifacts.annotate(call.workspace, rel, {
        agent: call.agent,
        taskId: call.taskId ?? null,
        description: description || `Blender (E2B sandbox, template ${template}): ${src}`,
        action: "generated",
      });
      ctx.artifacts.mirror(call.workspace, [rel]);
    } catch (e) {
      log.warn(`annotate ${rel}: ${e.message}`);
    }
    return { rel: `artifacts/${rel}`, size: buf.length };
  }

  // -- background jobs: track, poll, wake -----------------------------------

  const fmt = (j) => {
    const lines = [`job ${j.id} (${j.kind === "background" ? "blender -b" : "live scene"}): ${j.status}${j.phase ? ` — ${j.phase}` : ""} after ${j.elapsed_s} s`];
    if (j.result) lines.push(`stdout:\n${String(j.result).slice(-TEXT_CAP)}`);
    if (j.error) lines.push(`error:\n${String(j.error).slice(-TEXT_CAP)}`);
    if (j.log_tail && j.status !== "running") lines.push(`log (${j.log_path}):\n${String(j.log_tail).slice(-TEXT_CAP)}`);
    return lines.join("\n");
  };

  function track(call, box, job, label) {
    const trackId = ctx.jobs.track({
      workspace: call.workspace,
      agent: call.agent,
      taskId: call.taskId ?? null,
      sessionKey: call.sessionKey ?? null,
      runId: call.runId ?? null,
      externalId: `${box.id}:${job.id}`,
      model: template,
      label: `blender: ${label}`.slice(0, 120),
    });
    pending.set(trackId, { key: keyOf(call), boxId: box.id, jobId: job.id, workspace: call.workspace, agent: call.agent, sessionKey: call.sessionKey ?? null, taskId: call.taskId ?? null, label });
    return trackId;
  }

  function settle(trackId, p, j, extra = "") {
    pending.delete(trackId);
    const ok = j && j.status === "done";
    ctx.jobs.settle(trackId, ok ? { status: "succeeded", result: { elapsed_s: j.elapsed_s } } : { status: "failed", error: j?.error ?? extra });
    ctx.wakeAgent({
      workspace: p.workspace,
      agent: p.agent,
      key: `e2b-blender:${p.jobId}`,
      ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}),
      prompt:
        `Blender job ${p.jobId} (${p.label}) ${ok ? "finished" : "FAILED"}${p.taskId ? ` — task ${p.taskId}` : ""}.\n` +
        (j ? fmt(j) : extra) +
        `\n${ok ? "Pull the files you need into artifacts with blender_pull, then continue." : "Fix the script and run it again, or report the blocker."}`,
    });
  }

  async function pollOnce() {
    for (const [trackId, p] of [...pending]) {
      const box = Object.values(boxes).find((b) => b.id === p.boxId);
      if (!box) {
        settle(trackId, p, null, "the sandbox stopped before the job finished (idle/max-life timeout or blender_stop) — nothing to collect");
        continue;
      }
      try {
        const j = await sbx(box, "GET", `/jobs/${p.jobId}`);
        if (j.status && j.status !== "running") settle(trackId, p, j);
      } catch (e) {
        log.warn(`poll ${p.jobId}: ${e.message}`);
      }
    }
  }

  async function watchOnce() {
    for (const [key, box] of Object.entries(boxes)) {
      const busy = [...pending.values()].some((p) => p.boxId === box.id);
      const age = (Date.now() - box.createdAt) / 1000;
      try {
        if (age > maxLifeS) {
          await e2b("DELETE", `/sandboxes/${box.id}`).catch(() => {});
          forget(key, `max life ${maxLifeS}s`);
        } else if (busy) {
          // a render must not be cut by the idle timer
          await e2b("POST", `/sandboxes/${box.id}/timeout`, { timeout: idleS });
        } else if (Date.now() - box.lastUse > idleS * 1000 + 15_000) {
          // E2B's own timer should have stopped it; confirm and close the books
          await e2b("GET", `/sandboxes/${box.id}`).then(
            () => e2b("DELETE", `/sandboxes/${box.id}`),
            () => undefined,
          );
          forget(key, `idle ${idleS}s`);
        }
      } catch (e) {
        if (e.status === 404) forget(key, "gone");
        else log.warn(`watch ${box.id}: ${e.message}`);
      }
    }
  }

  // re-arm jobs that were pending when the server stopped
  for (const j of ctx.jobs.pending()) {
    if (!String(j.label).startsWith("blender:")) continue;
    const [boxId, jobId] = String(j.externalId).split(":");
    const entry = Object.entries(boxes).find(([, b]) => b.id === boxId);
    pending.set(j.id, { key: entry?.[0] ?? "", boxId, jobId, workspace: j.workspace, agent: j.agent, sessionKey: j.sessionKey, taskId: j.taskId, label: String(j.label).slice(8).trim() });
  }
  const poller = setInterval(() => void pollOnce(), POLL_MS);
  const watcher = setInterval(() => void watchOnce(), WATCH_MS);
  poller.unref?.();
  watcher.unref?.();
  ctx.onShutdown(() => {
    clearInterval(poller);
    clearInterval(watcher);
  });

  // -- MCP passthrough (the upstream MCP for Blender tools) -----------------

  const mcpSessions = new Map();
  async function mcpPost(box, body, session) {
    const res = await fetch(`${hostOf(box, 8000)}/mcp`, {
      method: "POST",
      headers: {
        "e2b-traffic-access-token": box.traffic,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    const sid = res.headers.get("mcp-session-id");
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    const payload = lines.length ? lines.map((l) => l.slice(5).trim()).filter(Boolean).pop() : text;
    return { sid, msg: payload ? JSON.parse(payload) : null };
  }
  async function mcpCall(box, name, args) {
    let sid = mcpSessions.get(box.id);
    if (!sid) {
      const init = await mcpPost(box, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bridex-e2b-blender", version: "0.1.0" } },
      });
      sid = init.sid;
      await mcpPost(box, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      mcpSessions.set(box.id, sid);
    }
    const { msg } = await mcpPost(box, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }, sid);
    if (msg?.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
    return msg?.result?.content ?? [];
  }

  // -- tools ----------------------------------------------------------------

  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const fail = (e) => text(`error: ${e.message ?? e}`);
  const parseList = (v) => {
    if (Array.isArray(v)) return v.map(String);
    const s = String(v ?? "").trim();
    if (!s) return [];
    if (s.startsWith("[")) return JSON.parse(s).map(String);
    return [s];
  };

  ctx.registerTool({
    name: "blender_python",
    description:
      `Run Python in Blender (bpy) in your own cloud sandbox — the scene lives across calls for this task; the first call starts the sandbox (~2 s). Give inline \`code\`, or a \`script\` file from your workspace (a skill's <skill>/scripts/x.py, or artifacts/...) with \`argv\` — the script's folder is uploaded next to it and it runs as __main__ with sys.argv = [script, *argv]. print() output and the full traceback come back.\n` +
      `Timing — you never have to guess whether something fits: in the live scene the call waits up to ${syncS} s; if the code is still running then (a big render, a bake), it continues as a background job and you get its id — END your run, you will be woken with the result. For work you already know is long (renders from several angles, exports of many files, simulations), pass background=true: a separate Blender process runs on a copy of the current scene (scene="current", or "empty", or a .blend path in the sandbox) while the live scene stays free; it wakes you when done. The copy is taken when the live scene is free — if live code is still running, the background job starts after it (scene="empty" or a .blend starts at once). Every result reports elapsed seconds — note typical durations for next time.\n` +
      `Write outputs under /work (e.g. /work/out/…), then blender_pull them into artifacts. Only the scene persists between calls, not Python variables.`,
    schema: {
      code: z.string().optional().describe("inline Python (bpy is imported for you in the live scene)"),
      script: z.string().optional().describe("a .py file in your workspace: <skill>/scripts/file.py or artifacts/..."),
      argv: z.array(z.string()).optional().describe("arguments for the script (sys.argv[1:])"),
      background: z.boolean().optional().describe("run in a separate `blender -b` process as a background job (long renders/exports)"),
      scene: z.string().optional().describe('background only: "current" (default — a copy of the live scene), "empty", or a .blend path in the sandbox'),
    },
    async handler(args, call) {
      try {
        if (!args.code && !args.script) return text("error: pass code or script");
        const box = await boxFor(call);
        const argv = parseList(args.argv);
        let scriptPath = null;
        let uploaded = "";
        if (args.script) {
          const abs = workspaceFile(call.workspace, args.script);
          const dir = path.dirname(abs);
          // named after the skill (<skill>/scripts/x.py → /work/scripts/<skill>), else the folder
          const skillRel = path.relative(ctx.paths.workspaceSkills(call.workspace), abs);
          const label = !skillRel.startsWith("..") && !path.isAbsolute(skillRel) ? skillRel.split(path.sep)[0] : path.basename(dir);
          const remoteDir = `/work/scripts/${label}`;
          // the whole script folder: helpers the script imports come along (capped)
          const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).slice(0, 60);
          let bytes = 0;
          for (const f of files) {
            const size = fs.statSync(path.join(dir, f)).size;
            if (size > 20 * 1024 ** 2 || bytes + size > 60 * 1024 ** 2) continue;
            bytes += size;
            await push(box, path.join(dir, f), `${remoteDir}/${f}`);
          }
          scriptPath = `${remoteDir}/${path.basename(abs)}`;
          uploaded = `uploaded ${files.length} file(s) from ${path.basename(dir)}/ to ${remoteDir}\n`;
        }
        let j;
        if (args.background) {
          j = await sbx(box, "POST", "/spawn", {
            ...(scriptPath ? { script: scriptPath } : { code: `import bpy\n${args.code}` }),
            argv,
            scene: args.scene || "current",
            cwd: scriptPath ? path.posix.dirname(scriptPath) : "/work",
            label: args.script ? path.basename(String(args.script)) : "inline",
          });
        } else {
          const code = scriptPath
            ? `import sys, runpy\nsys.path.insert(0, ${JSON.stringify(path.posix.dirname(scriptPath))})\nsys.argv = ${JSON.stringify([scriptPath, ...argv])}\nrunpy.run_path(${JSON.stringify(scriptPath)}, run_name="__main__")`
            : args.code;
          j = await sbx(box, "POST", "/exec", { code, sync_s: syncS, label: args.script ? path.basename(String(args.script)) : "inline" });
        }
        box.lastUse = Date.now();
        persist();
        if (j.status === "running") {
          track(call, box, j, j.label ?? "python");
          return text(
            `${uploaded}${args.background ? (j.phase ? `background job queued — ${j.phase} (code running there finishes first)` : "background job started") : `still running after ${j.elapsed_s} s — detached`}: job ${j.id}. END your run now; you will be woken in this conversation when it finishes (blender_job to check or cancel).`,
          );
        }
        return text(uploaded + fmt(j));
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "blender_job",
    description: "Background Blender jobs of this task's sandbox: status of one (job_id), cancel it (cancel=true — only background `blender -b` jobs can be cancelled; code in the live scene cannot be interrupted, stop the sandbox instead), or list all without job_id. Normally the wakeup finds you first — do not poll in a loop.",
    schema: { job_id: z.string().optional(), cancel: z.boolean().optional() },
    async handler(args, call) {
      try {
        const box = boxes[keyOf(call)];
        if (!box) return text("no sandbox for this task (it starts on the first blender_* call)");
        if (!args.job_id) {
          const all = await sbx(box, "GET", "/jobs");
          return text(all.length ? all.map((j) => `${j.id} ${j.kind} ${j.status}${j.phase ? ` (${j.phase})` : ""} ${j.elapsed_s}s — ${j.label}`).join("\n") : "no jobs yet");
        }
        const j = args.cancel ? await sbx(box, "POST", `/jobs/${args.job_id}/cancel`, {}) : await sbx(box, "GET", `/jobs/${args.job_id}`);
        return text(j.error && j.status === "running" ? `${j.error}\n${fmt(j)}` : fmt(j));
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "blender_preview",
    description: "Look at the live scene: a quick Cycles CPU render (through the scene camera, or an automatic camera framing everything, with a temporary sun if there are no lights) saved into your artifacts and returned as a picture you see right away (its path too, to hand it over). A few seconds at 800 px.",
    schema: { max_size: z.number().optional().describe("longest side in px, default 800") },
    async handler(args, call) {
      try {
        const box = await boxFor(call);
        const r = await sbx(box, "POST", "/screenshot", { max_size: Number(args.max_size) || 800 });
        if (r.error) return text(`error: ${r.error}`);
        const saved = await pull(box, call, r.path, undefined, `Blender preview render (${r.width}×${r.height}, Cycles CPU) of the live scene`);
        box.lastUse = Date.now();
        persist();
        const line = `preview: ${saved.rel} (${r.width}×${r.height}, ${r.elapsed_s} s)`;
        // the picture itself, so the agent sees the scene in this step (cores
        // that pass image blocks through); the path stays for handing it over
        const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), saved.rel);
        const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
        if (size > 0 && size <= 4 * 1024 * 1024)
          return { content: [{ type: "image", data: fs.readFileSync(abs).toString("base64"), mimeType: "image/png" }, { type: "text", text: line }] };
        return text(line);
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "blender_push",
    description: "Copy files from your workspace (artifacts/... or a skill's files) into the sandbox, e.g. textures, references, a .blend to open. They land in `to` (default /work/in).",
    schema: {
      paths: z.array(z.string()).describe("workspace files: artifacts/... or <skill>/..."),
      to: z.string().optional().describe("folder in the sandbox, default /work/in"),
    },
    async handler(args, call) {
      try {
        const box = await boxFor(call);
        const to = String(args.to || "/work/in").replace(/\/+$/, "");
        const out = [];
        for (const p of parseList(args.paths)) {
          const r = await push(box, workspaceFile(call.workspace, p), `${to}/${path.basename(String(p))}`);
          out.push(`${p} → ${r.dest} (${r.size} B)`);
        }
        return text(out.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "blender_pull",
    description: "Bring files out of the sandbox into this task's artifacts (renders, .glb/.fbx/.blend exports) — with provenance, visible in the dashboard. Pass exact sandbox paths, or a folder to take everything in it (e.g. /work/out). Call it before the sandbox stops: its files are gone after.",
    schema: {
      paths: z.array(z.string()).describe("sandbox file paths or folders, e.g. /work/out/front.png or /work/out"),
      to: z.string().optional().describe("artifacts subfolder, default blender/<task>"),
    },
    async handler(args, call) {
      try {
        const box = boxes[keyOf(call)];
        if (!box) return text("error: no sandbox for this task — nothing to pull");
        const files = [];
        for (const p of parseList(args.paths)) {
          if (/\.[a-z0-9]{1,5}$/i.test(p)) files.push(p);
          else {
            const ls = await sbx(box, "GET", `/ls?path=${encodeURIComponent(p)}`);
            files.push(...(ls.items ?? []).map((i) => i.path));
          }
        }
        if (!files.length) return text("nothing found at those paths");
        const out = [];
        for (const f of files.slice(0, 100)) {
          const r = await pull(box, call, f, args.to ? String(args.to).replace(/^artifacts\//, "") : undefined);
          out.push(`${r.rel} (${Math.round(r.size / 1024)} KB)`);
        }
        box.lastUse = Date.now();
        persist();
        return text(`pulled into artifacts:\n${out.join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "blender_tool",
    description:
      "Call one tool of the MCP for Blender server in your sandbox by name: get_scene_info, get_object_info {object_name}, bpy_api_lookup {query}, describe_node_type {bl_idname}, search_polyhaven_assets / download_polyhaven_asset / set_texture (free Poly Haven HDRIs, textures, models), search_sketchfab_models / download_sketchfab_model, and more. Python work goes through blender_python.",
    schema: { name: z.string(), args: z.string().optional().describe("JSON object of the tool's arguments") },
    async handler(args, call) {
      try {
        const box = await boxFor(call);
        const toolArgs = args.args ? JSON.parse(String(args.args)) : {};
        // the upstream tools require the user's words for their telemetry; there is none to give
        if (toolArgs.user_prompt === undefined) toolArgs.user_prompt = "";
        const content = await mcpCall(box, String(args.name), toolArgs);
        box.lastUse = Date.now();
        persist();
        const out = [];
        for (const c of content) {
          if (c.type === "text") out.push(c.text);
          else if (c.type === "image") {
            const rel = path.posix.join(`blender/${call.taskId ?? "chat"}`, `mcp-${Date.now()}.png`);
            const abs = path.join(artifactsRoot(call.workspace), rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, Buffer.from(c.data, "base64"));
            ctx.artifacts.annotate(call.workspace, rel, { agent: call.agent, taskId: call.taskId ?? null, description: `Blender MCP ${args.name} image`, action: "generated" });
            out.push(`image saved: artifacts/${rel}`);
          }
        }
        return text(out.join("\n").slice(0, TEXT_CAP * 2) || "(no output)");
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "blender_stop",
    description: "Stop this task's Blender sandbox now (it also stops by itself after idle time). Pass save_blend to keep the scene: it is saved and pulled into artifacts first. Running background jobs are lost.",
    schema: { save_blend: z.string().optional().describe("file name for the saved scene, e.g. tower.blend") },
    async handler(args, call) {
      const key = keyOf(call);
      const box = boxes[key];
      if (!box) return text("no sandbox running for this task");
      let saved = "";
      try {
        if (args.save_blend) {
          const name = path.basename(String(args.save_blend)).replace(/\.blend$/i, "") + ".blend";
          const fp = `/work/out/${name}`;
          const r = await sbx(box, "POST", "/exec", { code: `import bpy, os\nos.makedirs('/work/out', exist_ok=True)\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(fp)}, copy=True)`, sync_s: 120 });
          if (r.status !== "done") throw new Error(r.error ?? "save failed");
          saved = `saved scene: ${(await pull(box, call, fp, undefined, "Blender scene saved from the E2B sandbox")).rel}\n`;
        }
      } catch (e) {
        saved = `could not save the scene: ${e.message}\n`;
      }
      await e2b("DELETE", `/sandboxes/${box.id}`).catch(() => {});
      for (const [tid, p] of [...pending]) if (p.boxId === box.id) settle(tid, p, null, "sandbox stopped by blender_stop");
      const mins = Math.round((Date.now() - box.createdAt) / 6000) / 10;
      forget(key, "blender_stop");
      return text(`${saved}sandbox stopped after ${mins} min`);
    },
  });

  if (typeof ctx.registerStat === "function")
    ctx.registerStat(() => {
      const live = Object.keys(boxes).length;
      return [{ label: "Blender sandboxes", value: live, sub: `${pending.size} job(s) running` }];
    });

  log.info(`e2b-blender active: template ${template}, idle ${idleS}s, inline up to ${syncS}s${pending.size ? `, ${pending.size} job(s) resumed` : ""}`);
}
