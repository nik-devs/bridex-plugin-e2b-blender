import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "e2b";
import { blenderTemplate, templateName } from "./template/template.mjs";

/**
 * e2b-blender: Blender for Bridex agents in an E2B sandbox.
 *
 * One sandbox per task (per conversation when there is no task), created on
 * first use (~2 s — the template snapshot already has Blender running),
 * extended on every call and while background jobs run, stopped by
 * blender_stop, after idle_s without calls, or at max_life_s. E2B's own timer
 * backs this up: a sandbox dies on its timeout even if the instance is down.
 *
 * The template is built by the plugin in the E2B account of the instance's
 * own key (a template belongs to one E2B team): on activation it checks for
 * the template matching this version's files and, if missing, builds it in
 * the background — first use waits for that once, then sandboxes start fast.
 *
 * Inside the sandbox (template/ in this repo): headless Blender with the MCP
 * for Blender addon, the MCP server on :8000/mcp, and a small job/file API on
 * :8001. Ports are not public (allow_public_traffic=false) — every request
 * carries the sandbox's traffic token. No keys ever enter the sandbox: files
 * go in and out through the plugin. The plugin's own code for the live scene
 * (preview cameras and shading, game-size pixels, the reference comparison) is
 * in sandbox/ and goes in with each call, so changing it rebuilds no template.
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
// never uploaded with a script's folder (hidden files and folders never are either)
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv"]);
// automatic stops save the scene this long before the sandbox's own timer runs out
const SAVE_AHEAD_MS = 120_000;

export default async function activate(ctx) {
  const { z, log } = ctx;
  const cfg = ctx.config ?? {};
  const resolve = (v) => String(v ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
  const apiKey = resolve(cfg.api_key || "${E2B_API_KEY}");
  // a set template name is used as is; empty (or the old shared default) =
  // the plugin's own build, named by the hash of its files
  const custom = cfg.template && cfg.template !== "bridex-blender" ? String(cfg.template) : null;
  const template = custom ?? templateName();
  // 20 min: a strong model thinks 10–15 min between calls, and at 5 the live scene died between steps
  const idleS = Number(cfg.idle_s) > 0 ? Number(cfg.idle_s) : 1200;
  const maxLifeS = Number(cfg.max_life_s) > 0 ? Number(cfg.max_life_s) : 3600;
  const syncS = Math.min(170, Number(cfg.sync_s) > 0 ? Number(cfg.sync_s) : 150);
  const pricePerHour = Number(cfg.price_per_hour_usd ?? 0.33) || 0;
  if (!apiKey) {
    ctx.needsConfig("set the E2B API key (plugins.e2b-blender.config.api_key, or ${E2B_API_KEY} in the environment)");
    return;
  }

  // Python the plugin runs in the live scene that is not part of the template (sandbox/ in this
  // repo — the template's file hash names it, and a change there rebuilds it on every instance):
  // sent to POST /exec with its arguments in front, sandbox/lib.py's helpers next
  const sandboxDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox");
  const SANDBOX_PY = Object.fromEntries(
    ["lib", "preview", "game_pixels", "compare_reference"].map((n) => [n, fs.readFileSync(path.join(sandboxDir, `${n}.py`), "utf8")]),
  );
  const py = (name, args) => `import json\nARGS = json.loads(${JSON.stringify(JSON.stringify(args))})\n${SANDBOX_PY.lib}\n${SANDBOX_PY[name]}`;
  /** The "BX {json}" line that code prints with what it did. */
  const bxOf = (j) => {
    const m = /^BX (\{.*\})\s*$/m.exec(String(j?.result ?? ""));
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  };

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

  // -- the template in this account ------------------------------------------

  const tplFile = path.join(stateDir, "template.json");
  /** {status: checking|building|ready|error, name, templateId?, buildId?, startedAt?, error?} */
  let tpl = { status: custom ? "ready" : "checking", name: template };
  try {
    const saved = JSON.parse(fs.readFileSync(tplFile, "utf8"));
    if (!custom && saved.name === template) tpl = saved;
  } catch {
    /* none yet */
  }
  const saveTpl = () => fs.writeFileSync(tplFile, JSON.stringify(tpl, null, 2));
  let tplPoll = null;

  async function pollBuild() {
    try {
      const st = await Template.getBuildStatus({ templateId: tpl.templateId, buildId: tpl.buildId }, { apiKey });
      if (st.status === "ready") {
        log.info(`template ${template} built in ${Math.round((Date.now() - (tpl.startedAt ?? Date.now())) / 60000)} min`);
        tpl = { status: "ready", name: template };
      } else if (st.status === "error") {
        tpl = { ...tpl, status: "error", error: st.reason?.message ?? "build failed" };
        log.warn(`template ${template} build failed: ${tpl.error}`);
      }
      saveTpl();
    } catch (e) {
      log.warn(`template build status: ${e.message}`);
    }
    if (tpl.status === "building") tplPoll = setTimeout(pollBuild, 20_000);
  }

  // one check/start at a time: activation and a Check click racing each other
  // started two builds of the same template
  let ensuring = null;
  function ensureTemplate(opts) {
    ensuring ??= startTemplate(opts).finally(() => (ensuring = null));
    return ensuring;
  }

  async function startTemplate({ retry = false } = {}) {
    if (custom || tpl.status === "ready") return;
    if (tpl.status === "building") {
      if (!tplPoll) void pollBuild();
      return;
    }
    if (tpl.status === "error" && !retry) return;
    try {
      if (await Template.aliasExists(template, { apiKey })) {
        tpl = { status: "ready", name: template };
        saveTpl();
        return;
      }
      const b = await Template.buildInBackground(blenderTemplate(), template, { apiKey, cpuCount: 4, memoryMB: 8192 });
      tpl = { status: "building", name: template, templateId: b.templateId, buildId: b.buildId, startedAt: Date.now() };
      saveTpl();
      log.info(`building template ${template} in this E2B account (first use)`);
      tplPoll = setTimeout(pollBuild, 20_000);
    } catch (e) {
      tpl = { status: "error", name: template, error: e.message };
      saveTpl();
      log.warn(`template ${template}: ${e.message}`);
    }
  }

  /** Why a sandbox cannot start yet, or null when the template is there. */
  function templateNotReady() {
    if (tpl.status === "ready") return null;
    if (tpl.status === "error")
      return `The Blender sandbox template could not be built in this instance's E2B account: ${tpl.error}. A person can retry with Check in Settings → Plugins → e2b-blender.`;
    if (tpl.status === "checking") return "The Blender sandbox template is being checked in this instance's E2B account — try again in a minute.";
    const mins = tpl.startedAt ? Math.round((Date.now() - tpl.startedAt) / 60000) : 0;
    return `The Blender sandbox template is being built in this instance's E2B account — first use only, usually 5–10 min${mins ? ` (started ${mins} min ago)` : ""}. Set remind_me for 10 minutes and continue then; nothing is lost.`;
  }

  if (typeof ctx.registerCheck === "function")
    ctx.registerCheck(async () => {
      await ensureTemplate({ retry: true });
      const why = templateNotReady();
      return why ? { ok: false, message: why } : { ok: true, message: `template ${template} ready` };
    });
  void ensureTemplate();

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

  // why a task's sandbox went away, so the next one can say so: a fresh box
  // after an idle reset looked like the old one and the agent worked on an
  // empty scene as if its setup were still there
  const ended = new Map();
  const notices = new Map();

  function forget(key, reason, saved = null) {
    const box = boxes[key];
    if (!box) return;
    recordSpend(box, reason);
    delete boxes[key];
    persist();
    if (reason !== "blender_stop") ended.set(key, { reason, at: Date.now(), saved });
  }

  /** Restart the sandbox's own stop timer: E2B stops it idle_s from now. */
  async function touch(box) {
    await e2b("POST", `/sandboxes/${box.id}/timeout`, { timeout: idleS });
    box.lastUse = Date.now();
    box.expiresAt = Date.now() + idleS * 1000;
    persist();
  }

  async function boxFor(call) {
    const key = keyOf(call);
    const have = boxes[key];
    if (have) {
      try {
        await touch(have);
        return have;
      } catch (e) {
        if (e.status !== 404) throw e;
        forget(key, "gone");
      }
    }
    const why = templateNotReady();
    if (why) throw new Error(why);
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
      expiresAt: Date.now() + idleS * 1000,
    };
    boxes[key] = box;
    persist();
    log.info(`sandbox ${box.id} started for @${call.agent} in ${Date.now() - t0} ms`);
    const prev = ended.get(key);
    if (prev) {
      ended.delete(key);
      const mins = Math.round((Date.now() - prev.at) / 60_000);
      notices.set(
        key,
        `[A NEW sandbox was started: the previous one stopped${mins >= 1 ? ` ${mins} min ago` : ""} (${prev.reason}). The scene and /work are EMPTY` +
          (prev.saved
            ? ` — its scene was saved before it stopped: ${prev.saved}. To go on from it, blender_push it and append its objects into the live scene (bpy.data.libraries.load), or run background jobs with scene="/work/in/autosave.blend"; files of /work were not saved — push again what you need.]`
            : ` — redo the setup and push the files again before going on.]`),
      );
    }
    return box;
  }

  // -- files between artifacts and the sandbox ------------------------------

  const artifactsRoot = (ws) => ctx.paths.workspaceArtifacts(ws);
  const inside = (p, root) => {
    const r = path.relative(root, p);
    return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  };
  /**
   * A workspace file: artifacts/…, a skill's file (<skill>/scripts/x.py — the
   * shared library or the agent's own skills), a path in the task's checkout or
   * the working directory, or an absolute path in the workspace. Relative paths
   * from a task's checkout used to fail «file not found» (only artifacts and the
   * shared skills were looked at), so agents copied inputs around by hand.
   */
  function workspaceFile(call, p) {
    const s = String(p);
    const ws = call.workspace;
    const wsRoot = path.join(ctx.paths.home, "workspaces", ws);
    const candidates = s.startsWith("artifacts/")
      ? [path.join(artifactsRoot(ws), s.slice("artifacts/".length))]
      : path.isAbsolute(s)
        ? [s]
        : [
            path.join(ctx.paths.workspaceSkills(ws), s),
            path.join(wsRoot, "agents", String(call.agent), "skills", s),
            ...(call.taskId ? [path.join(wsRoot, "work", String(call.taskId), s)] : []),
            path.join(ctx.paths.workspaceWorkdir(ws), s),
          ];
    const allowed = candidates.filter((c) => inside(c, wsRoot));
    if (!allowed.length) throw new Error(`not a file in this workspace: ${s}`);
    for (const abs of allowed) if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    throw new Error(`file not found: ${s} (looked in ${allowed.map((c) => path.relative(wsRoot, c)).join(", ")})`);
  }

  async function push(box, abs, dest) {
    const data = fs.readFileSync(abs);
    await sbx(box, "PUT", `/files?path=${encodeURIComponent(dest)}`, data, true);
    return { dest, size: data.length };
  }

  async function pull(box, call, src, subdir, description, relName) {
    const buf = await sbx(box, "GET", `/files?path=${encodeURIComponent(src)}`, undefined, "download");
    const folder = subdir || `blender/${call.taskId ?? "chat"}`;
    // keep the sandbox layout under /work (out/front/view0.png and out/back/view0.png
    // must not overwrite each other); files elsewhere keep their name
    const under = src.startsWith("/work/") ? src.slice("/work/".length) : path.posix.basename(src);
    const rel = relName ?? path.posix.join(folder, under);
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

  function settle(trackId, p, j, extra = "", { wake = true, gone = false } = {}) {
    pending.delete(trackId);
    const ok = j && j.status === "done";
    // the agent is woken to collect the result: the idle clock starts NOW, not
    // at its last call before the render — a 12-minute render was followed by
    // the watcher stopping the sandbox 20 s later, /work and the frames gone
    const box = Object.values(boxes).find((b) => b.id === p.boxId);
    if (box) touch(box).catch((e) => log.warn(`extend ${box.id} after job: ${e.message}`));
    ctx.jobs.settle(trackId, ok ? { status: "succeeded", result: { elapsed_s: j.elapsed_s } } : { status: "failed", error: j?.error ?? extra });
    // the agent already read the result itself (blender_job) — a wake would only repeat it
    if (!wake) return;
    ctx.wakeAgent({
      workspace: p.workspace,
      agent: p.agent,
      key: `e2b-blender:${p.jobId}`,
      ...(p.sessionKey ? { sessionKey: p.sessionKey } : {}),
      prompt:
        `Blender job ${p.jobId} (${p.label}) ${ok ? "finished" : "FAILED"}${p.taskId ? ` — task ${p.taskId}` : ""}.\n` +
        (j ? fmt(j) : extra) +
        `\n${
          ok
            ? `Pull the files you need into artifacts with blender_pull, then continue — the sandbox stays up ${Math.round(idleS / 60)} min from now without calls.`
            : gone
              ? // this notice can come late — after the agent already redid the work in a new sandbox
                "The sandbox it ran in is gone — there is nothing to fix in the script. If you already started this work again in a new sandbox, do not start it once more: blender_job lists what is running now."
              : "Fix the script and run it again, or report the blocker."
        }`,
    });
  }

  async function pollOnce() {
    for (const [trackId, p] of [...pending]) {
      const box = Object.values(boxes).find((b) => b.id === p.boxId);
      if (!box) {
        settle(trackId, p, null, "the sandbox stopped before the job finished (idle/max-life timeout or blender_stop) — nothing to collect", { gone: true });
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

  /**
   * Save the live scene into the task's artifacts before a timer stops the
   * sandbox: the next one starts empty, and an agent away longer than idle_s
   * (or working past max_life_s) lost the whole scene and rebuilt it from
   * scratch. Only a scene some code built is saved, under one name per task
   * (the next autosave replaces it); a busy scene is left alone.
   */
  async function autosave(box) {
    if (!box.built) return null;
    try {
      // room for the save and the download, whatever the timer had left
      await e2b("POST", `/sandboxes/${box.id}/timeout`, { timeout: 180 });
      const fp = "/work/.bridex/autosave.blend";
      const r = await sbx(box, "POST", "/exec", {
        code: `import bpy, os\nif len(bpy.data.objects):\n    os.makedirs('/work/.bridex', exist_ok=True)\n    bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(fp)}, copy=True)\n    print('saved')\nelse:\n    print('empty')`,
        sync_s: 60,
        label: "autosave before the sandbox stops",
      });
      if (r.status !== "done" || !String(r.result ?? "").includes("saved")) return null;
      const who = { workspace: box.workspace, agent: box.agent, taskId: box.taskId ?? null };
      const saved = await pull(box, who, fp, undefined, "Blender scene saved automatically before its sandbox stopped", `blender/${box.taskId ?? "chat"}/autosave.blend`);
      log.info(`sandbox ${box.id}: scene saved to ${saved.rel} before stopping`);
      return saved.rel;
    } catch (e) {
      log.warn(`autosave ${box.id}: ${e.message}`);
      return null;
    }
  }

  async function watchOnce() {
    for (const [key, box] of Object.entries(boxes)) {
      const busy = [...pending.values()].some((p) => p.boxId === box.id);
      const age = (Date.now() - box.createdAt) / 1000;
      const expires = box.expiresAt ?? box.lastUse + idleS * 1000;
      try {
        if (age * 1000 > maxLifeS * 1000 - SAVE_AHEAD_MS) {
          // the longest life is a hard stop, a running render included — the scene is saved first
          if (!box.lifeSaved) {
            box.lifeSaved = (await autosave(box)) ?? "";
            persist();
          }
          if (age > maxLifeS) {
            await e2b("DELETE", `/sandboxes/${box.id}`).catch(() => {});
            forget(key, `max life ${maxLifeS}s`, box.lifeSaved || null);
          }
        } else if (busy) {
          // a render must not be cut by the idle timer
          await touch(box);
        } else if (box.built && Date.now() > expires - SAVE_AHEAD_MS && Date.now() < expires) {
          // save the scene while the sandbox is still up, then stop it
          const seen = box.lastUse;
          const saved = await autosave(box);
          // a call that came in meanwhile keeps the sandbox going
          if (box.lastUse !== seen || !boxes[key]) continue;
          await e2b("DELETE", `/sandboxes/${box.id}`).catch(() => {});
          forget(key, `idle ${idleS}s`, saved);
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
  // every tool result of a call that had to start a NEW sandbox opens with why
  const register = (def) =>
    ctx.registerTool({
      ...def,
      async handler(args, call) {
        const r = await def.handler(args, call);
        const key = keyOf(call);
        const notice = notices.get(key);
        if (notice && r && Array.isArray(r.content)) {
          notices.delete(key);
          r.content = [{ type: "text", text: notice }, ...r.content];
        }
        const box = boxes[key];
        if (box) {
          // idle time counts from the end of a call: a long live call or a pull no longer eats into it
          await touch(box).catch((e) => log.warn(`extend ${box.id}: ${e.message}`));
          const left = maxLifeS - (Date.now() - box.createdAt) / 1000;
          if (left < 900 && r && Array.isArray(r.content))
            r.content.push({
              type: "text",
              text: `[This sandbox stops in ${Math.max(1, Math.round(left / 60))} min — its longest life is ${Math.round(maxLifeS / 60)} min. Before that its scene is saved to artifacts/blender/${call.taskId ?? "chat"}/autosave.blend (unless code is running then); /work is not saved — blender_pull what you need now. Work that will not fit: blender_stop with save_blend, then go on in a new sandbox.]`,
            });
        }
        return r;
      },
    });
  const fail = (e) => text(`error: ${e.message ?? e}`);
  const parseList = (v) => {
    if (Array.isArray(v)) return v.map(String);
    const s = String(v ?? "").trim();
    if (!s) return [];
    if (s.startsWith("[")) return JSON.parse(s).map(String);
    return [s];
  };

  register({
    name: "blender_python",
    description:
      `Run Python in Blender (bpy) in your own cloud sandbox — the scene lives across calls for this task; the first call starts the sandbox (~2 s). Give inline \`code\`, or a \`script\` file from your workspace (a skill's <skill>/scripts/x.py, artifacts/..., or a file of your task's checkout) with \`argv\` — the script's folder, subfolders included, is uploaded next to it and it runs as __main__ with sys.argv = [script, *argv]. print() output and the full traceback come back.\n` +
      `Timing — you never have to guess whether something fits: in the live scene the call waits up to ${syncS} s; if the code is still running then (a big render, a bake), it continues as a background job and you get its id — END your run, you will be woken with the result. For work you already know is long (renders from several angles, exports of many files, simulations), pass background=true: a separate Blender process runs on a copy of the current scene (scene="current", or "empty", or a .blend path in the sandbox) while the live scene stays free; it wakes you when done. The copy is taken when the live scene is free — if live code is still running, the background job starts after it (scene="empty" or a .blend starts at once). Every result reports elapsed seconds — note typical durations for next time.\n` +
      `Write outputs under /work (e.g. /work/out/…), then blender_pull them into artifacts. Only the scene persists between calls, not Python variables; modules your script's folder provides are imported fresh on every run, so an edited helper takes effect.\n` +
      `The sandbox has no GPU: render with Cycles (low samples for previews); EEVEE is very slow here. In the live scene avoid edit mode (bpy.ops.object.mode_set(mode='EDIT')) — it has crashed the sandbox: build meshes with bmesh, edit armatures with background=true, scene="empty".\n` +
      `Look as you go: after each meaningful step (the blockout, proportions, a new part, UVs, the rig) take blender_preview from two or three angles and hold it against the reference before the next step — a mistake seen at the blockout costs one call, the same one found at the art gate costs a round.`,
    schema: {
      code: z.string().optional().describe("inline Python (bpy is imported for you in the live scene)"),
      script: z.string().optional().describe("a .py file in your workspace: <skill>/scripts/file.py, artifacts/..., or a path in your task's checkout or working directory (relative or absolute) — its folder goes along, subfolders too"),
      argv: z.array(z.string()).optional().describe("arguments for the script (sys.argv[1:])"),
      background: z.boolean().optional().describe("run in a separate `blender -b` process as a background job (long renders/exports)"),
      scene: z.string().optional().describe('background only: "current" (default — a copy of the live scene), "empty", or a .blend path in the sandbox'),
    },
    async handler(args, call) {
      try {
        if (!args.code && !args.script) return text("error: pass code or script");
        const scriptAbs = args.script ? workspaceFile(call, args.script) : null;
        // a factory reset in the live scene unloads the sandbox's own add-on: the scene stops answering
        const source = (args.code ?? (scriptAbs ? fs.readFileSync(scriptAbs, "utf8") : "")).split("\n").filter((l) => !l.trim().startsWith("#"));
        if (!args.background && source.some((l) => /\bread_(factory_settings|homefile)\s*\(/.test(l)))
          return text("error: read_factory_settings / read_homefile in the live scene unloads the sandbox's add-on and the scene stops answering. Clear the scene by removing bpy.data blocks (objects, meshes, materials, images, cameras, lights, worlds), or run this with background=true, scene=\"empty\".");
        const box = await boxFor(call);
        const argv = parseList(args.argv);
        let scriptPath = null;
        let remoteDir = null;
        let uploaded = "";
        if (scriptAbs) {
          const dir = path.dirname(scriptAbs);
          // named after the skill (<skill>/scripts/x.py → /work/scripts/<skill>), else the folder
          const skillRel = path.relative(ctx.paths.workspaceSkills(call.workspace), scriptAbs);
          const label = !skillRel.startsWith("..") && !path.isAbsolute(skillRel) ? skillRel.split(path.sep)[0] : path.basename(dir);
          remoteDir = `/work/scripts/${label}`;
          // the whole script folder with its subfolders (data next to the script used to stay
          // behind); hidden files (.env) and dependency folders never go; unchanged files go once
          const files = [];
          const walk = (d, depth) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (files.length >= 400) return;
              if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
              const fp = path.join(d, e.name);
              if (e.isDirectory()) {
                if (depth < 4) walk(fp, depth + 1);
              } else if (e.isFile()) files.push(fp);
            }
          };
          walk(dir, 0);
          box.sent ??= {};
          let bytes = 0;
          let sent = 0;
          let same = 0;
          let skipped = 0;
          for (const f of files) {
            const st = fs.statSync(f);
            if (st.size > 20 * 1024 ** 2 || bytes + st.size > 80 * 1024 ** 2) {
              skipped++;
              continue;
            }
            bytes += st.size;
            const remote = `${remoteDir}/${path.relative(dir, f).split(path.sep).join("/")}`;
            const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
            if (box.sent[remote] === stamp) {
              same++;
              continue;
            }
            await push(box, f, remote);
            box.sent[remote] = stamp;
            sent++;
          }
          scriptPath = `${remoteDir}/${path.relative(dir, scriptAbs).split(path.sep).join("/")}`;
          uploaded =
            `uploaded ${sent} file(s) from ${path.basename(dir)}/ to ${remoteDir}${same ? ` (${same} unchanged already there)` : ""}` +
            `${skipped ? `, ${skipped} skipped (over 20 MB each or 80 MB in all)` : ""}${files.length >= 400 ? " — the folder has over 400 files, the rest stayed behind" : ""}\n`;
        }
        // a background job works on its own copy: only live work changes what an autosave would keep
        if (!args.background) box.built = true;
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
          // modules the script's folder provides are imported fresh on every run: the live
          // scene kept them in sys.modules, and an edited helper silently ran its old code
          const code = scriptPath
            ? [
                "import sys, runpy",
                `_bx_root = ${JSON.stringify(remoteDir)}`,
                "for _bx_k, _bx_m in list(sys.modules.items()):",
                "    if (getattr(_bx_m, '__file__', None) or '').startswith(_bx_root + '/'):",
                "        del sys.modules[_bx_k]",
                `_bx_dir = ${JSON.stringify(path.posix.dirname(scriptPath))}`,
                "if _bx_dir not in sys.path:",
                "    sys.path.insert(0, _bx_dir)",
                `sys.argv = ${JSON.stringify([scriptPath, ...argv])}`,
                `runpy.run_path(${JSON.stringify(scriptPath)}, run_name="__main__")`,
              ].join("\n")
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

  register({
    name: "blender_job",
    description: "Background Blender jobs of this task's sandbox: status of one (job_id), cancel it (cancel=true — only background `blender -b` jobs can be cancelled; code in the live scene cannot be interrupted, stop the sandbox instead), or list all without job_id. Normally the wakeup finds you first — do not poll in a loop.",
    schema: { job_id: z.string().optional(), cancel: z.boolean().optional() },
    async handler(args, call) {
      try {
        const box = boxes[keyOf(call)];
        if (!box) return text("no sandbox for this task (it starts on the first blender_* call)");
        if (!args.job_id) {
          // the plugin's own short calls (preview cameras and comparisons, the autosave) are not the agent's jobs
          const all = (await sbx(box, "GET", "/jobs")).filter((j) => !/^(preview (camera|pixels|compare)|autosave)/.test(String(j.label ?? "")));
          return text(all.length ? all.map((j) => `${j.id} ${j.kind} ${j.status}${j.phase ? ` (${j.phase})` : ""} ${j.elapsed_s}s — ${j.label}`).join("\n") : "no jobs yet");
        }
        const j = args.cancel ? await sbx(box, "POST", `/jobs/${args.job_id}/cancel`, {}) : await sbx(box, "GET", `/jobs/${args.job_id}`);
        if (j.status && j.status !== "running")
          for (const [trackId, p] of [...pending]) if (p.boxId === box.id && p.jobId === args.job_id) settle(trackId, p, j, "", { wake: false });
        return text(j.error && j.status === "running" ? `${j.error}\n${fmt(j)}` : fmt(j));
      } catch (e) {
        return fail(e);
      }
    },
  });

  // -- blender_preview: views, shading, game size, the reference sheet -----
  // the views and where they look from are in sandbox/lib.py (BX_VIEWS); these five are orthographic
  const VIEW_NAMES = ["camera", "front", "back", "left", "right", "top", "three_quarter", "custom"];
  const ORTHO = new Set(["front", "back", "left", "right", "top"]);
  const SHADINGS = ["material", "clay", "silhouette"];
  const REF_EXAMPLE = '{image: "artifacts/refs/sheet.png", crop: [0, 0, 512, 1024], view: "front", height_m: 1.8}';
  const firstLine = (s) => String(s ?? "").split("\n")[0];
  const nums = (v) => (Array.isArray(v) ? v : String(v ?? "").replace(/[[\]\s]/g, "").split(",").filter(Boolean)).map(Number);
  const signed = (v, d = 1) => {
    if (v == null || !Number.isFinite(v)) return "?";
    const r = Number(v.toFixed(d));
    return `${r > 0 ? "+" : r < 0 ? "-" : ""}${Math.abs(r).toFixed(d)}`;
  };
  const mm = (m) => `${Number((m * 1000).toPrecision(3))} mm`;
  /** A pulled picture as an image block, so the agent sees it in this step (cores that pass image blocks through). */
  const picture = (call, rel) => {
    const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), rel.replace(/^artifacts\//, ""));
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    return size > 0 && size <= 4 * 1024 * 1024 ? { type: "image", data: fs.readFileSync(abs).toString("base64"), mimeType: "image/png" } : null;
  };

  /** The reference argument, checked before anything runs in the sandbox: a wrong one fails at once and says what to give. */
  function referenceOf(raw) {
    let ref = raw;
    if (typeof ref === "string") {
      try {
        ref = JSON.parse(ref);
      } catch {
        ref = null;
      }
    }
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error(`reference is an object, e.g. ${REF_EXAMPLE}`);
    const has = (k) => ref[k] !== undefined && ref[k] !== null && ref[k] !== "";
    const list = (v, n, what) => {
      const a = nums(v);
      if (a.length !== n || a.some((x) => !Number.isFinite(x))) throw new Error(`${what} is ${n} numbers`);
      return a;
    };
    if (!has("image")) throw new Error(`reference.image is required — the sheet, e.g. ${REF_EXAMPLE}`);
    const view = has("view") ? String(ref.view) : "front";
    if (!ORTHO.has(view)) throw new Error(`reference.view is the orthographic view the crop shows: front, back, left, right or top (got ${JSON.stringify(ref.view)})`);
    if (has("m_per_px") === has("height_m"))
      throw new Error("reference needs exactly one scale: m_per_px (metres per sheet pixel) or height_m (the object's real height — the figure's height on the sheet then sets the scale)");
    const scale = has("m_per_px") ? { m_per_px: Number(ref.m_per_px) } : { height_m: Number(ref.height_m) };
    const sv = Object.values(scale)[0];
    if (!Number.isFinite(sv) || sv <= 0) throw new Error(`reference.${Object.keys(scale)[0]} is a positive number of metres`);
    if (scale.height_m && view === "top") throw new Error("reference.height_m sets the scale from the figure's height, which a top view does not show — give m_per_px for the top view");
    const crop = has("crop") ? list(ref.crop, 4, "reference.crop [x0, y0, x1, y1]") : null;
    if (crop && !(crop[0] >= 0 && crop[1] >= 0 && crop[2] > crop[0] && crop[3] > crop[1]))
      throw new Error("reference.crop is [x0, y0, x1, y1] px in the image, its left-top and right-bottom corners: x1 > x0 ≥ 0, y1 > y0 ≥ 0");
    const origin = has("origin") ? list(ref.origin, 2, "reference.origin [col, row]") : null;
    const tolerance = has("tolerance") ? Number(ref.tolerance) : 40;
    if (!(tolerance >= 0 && tolerance <= 255)) throw new Error("reference.tolerance is 0–255");
    let marks = has("landmarks") ? ref.landmarks : [];
    if (typeof marks === "string") marks = JSON.parse(marks);
    if (!Array.isArray(marks) || marks.length > 16) throw new Error("reference.landmarks is a list of at most 16 {name, object, point?, at}");
    const landmarks = marks.map((l, i) => {
      if (!l || typeof l !== "object" || !l.object || l.at == null) throw new Error(`reference.landmarks[${i}] needs object (an object's name) and at ([col, row] px in the crop)`);
      return {
        name: String(l.name ?? l.object),
        object: String(l.object),
        ...(l.point != null ? { point: list(l.point, 3, `reference.landmarks[${i}].point [x, y, z]`) } : {}),
        at: list(l.at, 2, `reference.landmarks[${i}].at [col, row]`),
      };
    });
    return { image: String(ref.image), mask: has("mask") ? String(ref.mask) : null, view, crop, origin, tolerance, landmarks, ...scale };
  }

  /** A sheet or mask in the workspace, found before anything renders: a wrong path costs no sandbox time. */
  function refFile(call, p) {
    const abs = workspaceFile(call, p);
    const size = fs.statSync(abs).size;
    if (size > 50 * 1024 ** 2) throw new Error(`${p} is ${Math.round(size / 1024 ** 2)} MB — give a smaller copy of the sheet (up to 50 MB)`);
    return abs;
  }

  /** A workspace file into the sandbox's hidden /work/.bridex/ref/, sent again only when it changed (size:mtime, like a script's folder). */
  async function sendRef(box, abs) {
    const st = fs.statSync(abs);
    const remote = `/work/.bridex/ref/${crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8)}-${path.basename(abs)}`;
    const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    box.sent ??= {};
    if (box.sent[remote] !== stamp) {
      await push(box, abs, remote);
      box.sent[remote] = stamp;
    }
    return remote;
  }

  function compareLines(res, ref, rel) {
    const side = res.view !== "top";
    const L = [`reference ${res.view}: ${rel} — grey both, red sheet only, blue model only${res.landmarks?.length ? "; crosses: yellow sheet, blue model landmark" : ""}`];
    L.push(
      `sheet ${ref.image}${ref.crop ? ` crop [${res.crop.join(", ")}]` : ""}: ${res.size.join("×")} px, figure by ${res.mask}; ` +
        `1 px = ${(res.m_per_px * 100).toFixed(2)} cm (${res.scale_from}); world origin at [${res.origin.join(", ")}] (${res.origin_from})`,
    );
    L.push(`IoU ${res.iou.toFixed(3)} · sheet only ${res.sheet_only_pct.toFixed(1)} % · model only ${res.model_only_pct.toFixed(1)} % (of the sheet figure's area)`);
    if (res.model_cm) {
      const dh = res.model_cm.height - res.sheet_cm.height;
      const dw = res.model_cm.width - res.sheet_cm.width;
      L.push(
        `${side ? "height" : "depth (image up–down)"}: model ${res.model_cm.height.toFixed(1)} cm, sheet ${res.sheet_cm.height.toFixed(1)} cm → ${signed(dh)} cm (${signed((100 * dh) / res.sheet_cm.height)} %); ` +
          `top ${signed(res.top_cm)}, bottom ${signed(res.bottom_cm)} cm (up +)`,
      );
      L.push(`width: model ${res.model_cm.width.toFixed(1)} cm, sheet ${res.sheet_cm.width.toFixed(1)} cm → ${signed(dw)} cm; centre ${signed(res.centre_cm)} cm (right +)`);
      L.push(`width by band, top to bottom (model − sheet, cm): ${res.bands_cm.map((b) => (b == null ? "·" : signed(b))).join(" ")}`);
    }
    if (res.landmarks?.length)
      L.push(`landmarks (model − sheet, cm, right / up +): ${res.landmarks.map((m) => (m.error ? `${m.name}: ${m.error}` : `${m.name} ${signed(m.dx_cm)} / ${signed(m.dy_cm)}`)).join(" · ")}`);
    L.push(
      `compared ${res.object_count} object(s): ${res.objects.join(", ")}${res.object_count > res.objects.length ? ", …" : ""} — ` +
        `silhouette ${res.render_px.join("×")} px (${res.supersample}×${res.supersample} samples per sheet px), ${res.elapsed_s} s`,
    );
    for (const w of res.warnings ?? []) L.push(`note: ${w}`);
    return L;
  }

  /** The model against one orthographic view of the reference sheet: one /exec renders, measures and restores. */
  async function compare(box, call, ref, files, names, viewPx) {
    const image = await sendRef(box, files.image);
    const mask = files.mask ? await sendRef(box, files.mask) : null;
    const out = `/work/previews/compare-${ref.view}-${Date.now()}.png`;
    const j = await sbx(box, "POST", "/exec", {
      code: py("compare_reference", { ...ref, image, mask, objects: names, out, view_px: viewPx }),
      sync_s: syncS,
      label: `preview compare: ${ref.view}`,
    });
    const head = `reference ${ref.view}`;
    if (j.status === "running") return { lines: [`${head}: still running after ${j.elapsed_s} s — the live scene is busy (a call is still running there); compare after it finishes`] };
    if (j.status !== "done") {
      const err = String(j.error ?? "the comparison failed");
      // a check of the arguments says what to change in one line; anything else keeps its traceback
      return { lines: [`${head}: error: ${/^(ValueError|RuntimeError): /.test(err) ? firstLine(err) : err.slice(-1500)}`] };
    }
    const res = bxOf(j);
    if (!res) return { lines: [`${head}: error: the comparison gave no result:\n${String(j.result ?? "").slice(-600)}`] };
    const saved = await pull(
      box,
      call,
      out,
      undefined,
      `Blender: the model against the reference ${ref.image} (${ref.view}), silhouettes registered in world units — grey both, red sheet only, blue model only`,
      path.posix.join(`blender/${call.taskId ?? "chat"}`, "previews", path.posix.basename(out)),
    );
    return { rel: saved.rel, lines: compareLines(res, ref, saved.rel) };
  }

  register({
    name: "blender_preview",
    description:
      "Look at the live scene: a quick Cycles CPU render saved into your artifacts and returned as a picture you see right away (its path too, to hand it over). " +
      'views: "camera" — the scene camera, or without one a three-quarter view framing everything — front / back / left / right / top (orthographic: proportions and silhouettes; those in one call share one scale, given in mm per px) / three_quarter; azimuth + elevation (+ lens) add "custom", a perspective view from any angle. ' +
      "objects frames just those objects or collections (the rest stays in the picture). shading: clay (plain grey: form) or silhouette (black on white: outline). game_px renders that small and enlarges it with hard pixels: how the asset reads at game size. A few seconds per view at 800 px; the scene's camera, materials and world stay as they were. " +
      `reference measures the model against one orthographic view of a reference sheet in world units, nothing re-centred or re-scaled: reference: ${REF_EXAMPLE} → a diff picture with IoU and cm for height, centre offset and width by band. The crop is that one view on plain background (labels, rulers and ground lines count as figure). ` +
      "Use it after every meaningful step from two or three angles (e.g. three_quarter, front, right), not only before handing over.",
    schema: {
      views: z.array(z.enum(VIEW_NAMES)).optional().describe('default ["camera"]; with azimuth/elevation alone just "custom", with reference alone none. Up to 6 plus custom'),
      azimuth: z.number().optional().describe('degrees around the subject for the "custom" view: 0 front (camera at -Y), 90 right (+X), 180 back, -90 left'),
      elevation: z.number().optional().describe("custom view: degrees above the horizon, -90…90 (negative: from below); default 0"),
      lens: z.number().optional().describe("custom view focal length in mm, default 50"),
      shading: z.enum(SHADINGS).optional().describe("material (default), clay or silhouette"),
      game_px: z.number().optional().describe("render with this longest side, then enlarge with hard pixels to about max_size: e.g. 64 for an icon, 256 for a sprite"),
      objects: z
        .array(z.string())
        .optional()
        .describe("object or collection names (children and nested collections included): views frame just these; with reference only these render — name the model when the scene holds helpers (a floor, a reference plane). Default everything visible"),
      max_size: z.number().optional().describe("longest side in px, default 800 (with game_px: the size it is enlarged to)"),
      reference: z
        .object({
          image: z.string().describe("the sheet: artifacts/... or a file of your task's checkout"),
          crop: z.array(z.number()).optional().describe("[x0, y0, x1, y1] px in the image: the one view to compare (left-top, right-bottom); default the whole image"),
          view: z.enum(["front", "back", "left", "right", "top"]).optional().describe("the view the crop shows, default front"),
          m_per_px: z.number().optional().describe("metres per sheet pixel — or height_m"),
          height_m: z.number().optional().describe("the object's real height: the figure's height on the sheet sets the scale (not for top)"),
          origin: z
            .array(z.number())
            .optional()
            .describe("[col, row] px in the crop where the world origin is: the vertical axis column and the ground line (top: the x = 0 column, y = 0 row). Default the figure's box centre column and bottom — give it for side views, which are rarely centred"),
          mask: z.string().optional().describe("white-on-black image of the figure (the image's or the crop's size), instead of finding it automatically"),
          tolerance: z.number().optional().describe("sheets without transparency: a pixel is figure when its R+G+B differ from the corner colour by more than this; 0–255, default 40"),
          landmarks: z
            .array(
              z.object({
                name: z.string(),
                object: z.string().describe("the object the point belongs to"),
                point: z.array(z.number()).optional().describe("[x, y, z] in the object's local space, default its origin"),
                at: z.array(z.number()).describe("[col, row] px in the crop where the sheet has it"),
              }),
            )
            .optional()
            .describe("up to 16 points to check, e.g. the chin, a hand, the top of the head"),
        })
        .optional()
        .describe(`compare with one orthographic view of a reference sheet in world units, e.g. ${REF_EXAMPLE}`),
    },
    async handler(args, call) {
      try {
        // everything about the arguments is checked before the sandbox starts
        const ref = args.reference != null && args.reference !== "" ? referenceOf(args.reference) : null;
        const refFiles = ref ? { image: refFile(call, ref.image), mask: ref.mask ? refFile(call, ref.mask) : null } : null;
        const shading = args.shading ?? "material";
        if (!SHADINGS.includes(shading)) return text(`error: shading is one of ${SHADINGS.join(", ")}`);
        let views = [...new Set(parseList(args.views))];
        const unknown = views.filter((v) => !VIEW_NAMES.includes(v));
        if (unknown.length) return text(`error: unknown view ${unknown.join(", ")} — views are ${VIEW_NAMES.join(", ")}`);
        const angled = args.azimuth != null || args.elevation != null;
        if (views.includes("custom") && !angled) return text("error: the custom view looks from azimuth / elevation — give them, e.g. azimuth: 30, elevation: 15");
        if (args.lens != null && !angled) return text("error: lens is for the custom view — give azimuth (and elevation) with it");
        const az = Number(args.azimuth ?? 0);
        const el = Number(args.elevation ?? 0);
        const lens = args.lens != null ? Number(args.lens) : null;
        if (angled && (!Number.isFinite(az) || !Number.isFinite(el) || el < -90 || el > 90))
          return text("error: azimuth is degrees around the subject (0 front, 90 right, 180 back), elevation -90…90 degrees (+ from above)");
        if (lens != null && !(lens >= 1 && lens <= 5000)) return text("error: lens is the focal length in mm, e.g. 35 (wide) to 135 (long)");
        const gamePx = args.game_px != null ? Math.round(Number(args.game_px)) : 0;
        if (args.game_px != null && !(gamePx >= 8 && gamePx <= 2048)) return text("error: game_px is the longest side in game pixels, 8–2048 (e.g. 64 for an icon, 256 for a sprite)");
        views = views.filter((v) => v !== "custom").slice(0, 6);
        if (angled) views.push("custom");
        if (!views.length && !ref) views.push("camera");
        const maxSize = Number(args.max_size) || 800;
        const box = await boxFor(call);
        const names = parseList(args.objects);
        // the orthographic views of one call get one scale: the largest any of them needs
        const orthoViews = views.filter((v) => ORTHO.has(v));
        const content = [];
        const lines = [];
        const scales = [];
        let busy = false;
        for (const view of views) {
          let set;
          let r;
          try {
            set = await sbx(box, "POST", "/exec", {
              code: py("preview", { do: "setup", view, objects: names, ortho_views: orthoViews, shading, ...(view === "custom" ? { azimuth: az, elevation: el, lens } : {}) }),
              sync_s: 30,
              label: `preview camera: ${view}`,
            });
            if (set.status !== "done") {
              // the other views would fail the same way (a busy scene, a name that is not there)
              busy = set.status === "running";
              lines.push(`${view}: ${busy ? "the live scene is busy — a call is still running there; look after it finishes" : `error: ${firstLine(set.error ?? "could not place the camera")}`}`);
              break;
            }
            r = await sbx(box, "POST", "/screenshot", { max_size: gamePx || maxSize });
          } finally {
            // the camera, the overrides and the world are put back after every view
            await sbx(box, "POST", "/exec", { code: py("preview", { do: "restore" }), sync_s: 30, label: "preview camera: restore" }).catch((e) => log.warn(`restore camera ${box.id}: ${e.message}`));
          }
          if (r.error) {
            lines.push(`${view}: error: ${r.error}`);
            continue;
          }
          const info = bxOf(set) ?? {};
          const detail = [];
          let src = r.path;
          let shown = `${r.width}×${r.height}`;
          if (gamePx) {
            const factor = Math.max(1, Math.round(maxSize / Math.max(r.width, r.height)));
            const dst = r.path.replace(/\.png$/i, `-px${gamePx}.png`);
            const up = await sbx(box, "POST", "/exec", { code: py("game_pixels", { src: r.path, dst, factor }), sync_s: 60, label: `preview pixels: ${view}` });
            if (up.status === "done") {
              src = dst;
              shown = `${r.width}×${r.height} game px${factor > 1 ? `, shown ×${factor} with hard pixels` : ""}`;
            } else detail.push(`not enlarged: ${firstLine(up.error ?? up.status)}`);
          }
          if (shading !== "material") detail.push(shading);
          if (view === "custom") detail.push(`azimuth ${az}°, elevation ${el}°${info.lens ? `, ${Math.round(info.lens)} mm` : ""}`);
          if (info.ortho_scale) scales.push({ view, m: info.ortho_scale / Math.max(r.width, r.height) });
          const name = `${path.posix.basename(r.path).replace(/\.png$/i, "")}${view === "camera" ? "" : `-${view}`}${shading === "material" ? "" : `-${shading}`}${gamePx ? `-px${gamePx}` : ""}.png`;
          const saved = await pull(box, call, src, undefined, `Blender preview render (${[view, ...detail].join(", ")}, ${shown}, Cycles CPU) of the live scene`, path.posix.join(`blender/${call.taskId ?? "chat"}`, "previews", name));
          lines.push(`${view}: ${saved.rel} (${[shown, ...detail, `${r.elapsed_s} s`].join(", ")})`);
          const pic = picture(call, saved.rel);
          if (pic) content.push(pic);
        }
        if (scales.length) {
          const unit = gamePx ? "1 game px" : "1 px";
          const m = Math.max(...scales.map((s) => s.m));
          lines.push(scales.length > 1 ? `${scales.map((s) => s.view).join(", ")}: one scale, ${unit} = ${mm(m)} — sizes compare directly across them` : `${scales[0].view}: ${unit} = ${mm(m)}`);
        }
        if (ref && busy) lines.push(`reference ${ref.view}: not compared — the live scene is busy`);
        else if (ref) {
          // a failure here costs the comparison, not the views already rendered
          const c = await compare(box, call, ref, refFiles, names, maxSize).catch((e) => ({ lines: [`reference ${ref.view}: error: ${e.message}`] }));
          const pic = c.rel ? picture(call, c.rel) : null;
          if (pic) content.push(pic);
          lines.push(...c.lines);
        }
        box.lastUse = Date.now();
        persist();
        return { content: [...content, { type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return fail(e);
      }
    },
  });

  register({
    name: "blender_push",
    description: "Copy files from your workspace into the sandbox — artifacts/..., a skill's files, or files of your task's checkout or working directory (relative or absolute) — e.g. textures, references, a .blend to open. They land in `to` (default /work/in).",
    schema: {
      paths: z.array(z.string()).describe("workspace files: artifacts/..., <skill>/..., or a path in your task's checkout / working directory"),
      to: z.string().optional().describe("folder in the sandbox, default /work/in"),
    },
    async handler(args, call) {
      try {
        const box = await boxFor(call);
        const to = String(args.to || "/work/in").replace(/\/+$/, "");
        const out = [];
        for (const p of parseList(args.paths)) {
          const r = await push(box, workspaceFile(call, p), `${to}/${path.basename(String(p))}`);
          out.push(`${p} → ${r.dest} (${r.size} B)`);
        }
        return text(out.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  });

  register({
    name: "blender_pull",
    description: "Bring files out of the sandbox into this task's artifacts (renders, .glb/.fbx/.blend exports) — with provenance, visible in the dashboard. A file lands in `to` under its own name; a folder brings everything inside it into `to` (its subfolders kept), up to 500 files — more than that, zip them in the sandbox and pull the .zip. Everything means earlier runs' files too (a failed or cancelled build's): give each build its own output folder, or clear it when a build starts. Call it before the sandbox stops: its files are gone after.",
    schema: {
      paths: z.array(z.string()).describe("sandbox file paths or folders, e.g. /work/out/front.png or /work/out"),
      to: z.string().optional().describe("artifacts subfolder, default blender/<task>"),
    },
    async handler(args, call) {
      try {
        const box = boxes[keyOf(call)];
        if (!box) return text("error: no sandbox for this task — nothing to pull");
        const dest = args.to ? String(args.to).replace(/^artifacts\//, "").replace(/\/+$/, "") : `blender/${call.taskId ?? "chat"}`;
        const plan = [];
        let truncated = false;
        for (const p of parseList(args.paths)) {
          if (/\.[a-z0-9]{1,5}$/i.test(p)) plan.push({ src: p, rel: path.posix.basename(p) });
          else {
            // the folder's contents go straight into `to` — the /work path used to come along
            // (/work/out/r → artifacts/<to>/out/r/…) and every agent had to work around it
            const base = String(p).replace(/\/+$/, "");
            const ls = await sbx(box, "GET", `/ls?path=${encodeURIComponent(base)}`);
            truncated ||= Boolean(ls.truncated);
            for (const i of ls.items ?? []) plan.push({ src: i.path, rel: path.posix.relative(base, i.path) });
          }
        }
        if (!plan.length) return text("nothing found at those paths");
        const out = [];
        for (const f of plan) {
          const r = await pull(box, call, f.src, undefined, undefined, path.posix.join(dest, f.rel));
          out.push(`${r.rel} (${Math.round(r.size / 1024)} KB)`);
        }
        box.lastUse = Date.now();
        persist();
        const listed = out.length > 40 ? [...out.slice(0, 30), `… and ${out.length - 30} more in artifacts/${dest}/`] : out;
        return text(
          `pulled ${out.length} file(s) into artifacts:\n${listed.join("\n")}` +
            (truncated ? "\nThe folder has more than 500 files — the rest stayed in the sandbox: zip them there (zipfile, background=true) and pull the .zip." : ""),
        );
      } catch (e) {
        return fail(e);
      }
    },
  });

  register({
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
        // imports and texture changes build the scene too (worth saving before an automatic stop)
        if (!/^(get_|search_|bpy_api_lookup|describe_)/.test(String(args.name))) box.built = true;
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

  register({
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
      const mins = Math.round((Date.now() - box.createdAt) / 6000) / 10;
      forget(key, "blender_stop");
      // the agent stopped it itself: a wake saying its jobs FAILED would only start a duplicate run
      for (const [tid, p] of [...pending]) if (p.boxId === box.id) settle(tid, p, null, "sandbox stopped by blender_stop", { wake: false });
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
