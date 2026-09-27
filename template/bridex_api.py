"""Job + file API for the Bridex plugin, next to the MCP server (port 8001).

stdlib only. Everything here is reached through E2B's port proxy with the
sandbox's traffic token (allow_public_traffic=False) — nothing is public.

  POST /exec   {code, sync_s}           python in the LIVE scene (the headless
                                        addon on 127.0.0.1:9876). Waits up to
                                        sync_s; still running → a job id, the
                                        code keeps going.
  POST /spawn  {script|code, argv, scene} a separate `blender -b` process for
                                        long work (renders, bakes, exports) —
                                        the live scene stays responsive. scene:
                                        "current" (a copy of the live scene),
                                        "empty", or a .blend path.
  GET  /jobs, GET /jobs/<id>, POST /jobs/<id>/cancel
  POST /screenshot {max_size}           preview render of the live scene → png path
  PUT  /files?path=…  (raw body)        write a file (dirs created)
  GET  /files?path=…                    read a file
  GET  /ls?path=…                       list a folder (recursive, capped)
  GET  /health
"""
import json
import os
import re
import socket
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BLENDER = os.environ.get("BLENDER_BIN", "/opt/blender/blender")
ADDON = ("127.0.0.1", int(os.environ.get("BLENDER_PORT", "9876")))
WORK = os.environ.get("BRIDEX_WORK", "/work")
TAIL = 6000

jobs = {}
lock = threading.Lock()
ADDON_CHATTER = re.compile(r"^(Connected to client|Client handler started|Client disconnected|Queued command|Sent response|Executing handler|Error in client handler)")


def addon_call(cmd_type, params, timeout=None):
    """One command to the headless addon; its reply is a single JSON object."""
    s = socket.create_connection(ADDON, timeout=10)
    s.settimeout(timeout)
    try:
        s.sendall(json.dumps({"type": cmd_type, "params": params}).encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            try:
                return json.loads(buf.decode())
            except ValueError:
                continue
        return json.loads(buf.decode()) if buf else {"status": "error", "message": "no reply from Blender"}
    finally:
        s.close()


def new_job(kind, label):
    jid = "bj-" + uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "label": label, "status": "running", "started": time.time(), "ended": None,
           "result": "", "error": None, "log": None, "proc": None}
    with lock:
        jobs[jid] = job
    return job


def view(job):
    end = job["ended"] or time.time()
    out = {k: job[k] for k in ("id", "kind", "label", "status", "result", "error")}
    out["elapsed_s"] = round(end - job["started"], 1)
    if job.get("log") and os.path.exists(job["log"]):
        with open(job["log"], errors="replace") as f:
            data = f.read()
        out["log_tail"] = data[-TAIL:]
        out["log_path"] = job["log"]
    return out


def run_exec(job, code):
    try:
        reply = addon_call("execute_code", {"code": code}, timeout=None)
        if reply.get("status") == "success":
            out = str((reply.get("result") or {}).get("result", ""))
            # the addon's socket thread prints into the same redirected stdout
            # while the code runs — its chatter is not the script's output
            out = "\n".join(l for l in out.splitlines() if not ADDON_CHATTER.match(l))
            job["result"] = out[-TAIL * 4:]
            job["status"] = "done"
        else:
            msg = reply.get("message", "unknown error")
            # the addon wraps failures as JSON {exception_type, message, traceback}
            try:
                d = json.loads(msg)
                msg = f"{d.get('exception_type', 'Error')}: {d.get('message', '')}\n\n{d.get('traceback', '')}"
            except (ValueError, TypeError):
                pass
            job["error"] = msg
            job["status"] = "failed"
    except Exception as e:  # noqa: BLE001
        job["error"] = f"{type(e).__name__}: {e}"
        job["status"] = "failed"
    job["ended"] = time.time()


def run_spawn(job, argv_cmd, cwd):
    with open(job["log"], "w") as log:
        try:
            p = subprocess.Popen(argv_cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        except Exception as e:  # noqa: BLE001
            job["error"] = f"could not start Blender: {e}"
            job["status"] = "failed"
            job["ended"] = time.time()
            return
        job["proc"] = p
        rc = p.wait()
    if job["status"] == "cancelled":
        pass
    elif rc == 0:
        job["status"] = "done"
    else:
        job["status"] = "failed"
        job["error"] = f"blender exited {rc} — see log_tail"
    job["ended"] = time.time()


def wait_for(job, sync_s):
    deadline = time.time() + max(0.0, float(sync_s))
    while job["status"] == "running" and time.time() < deadline:
        time.sleep(0.1)
    return view(job)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._json(200, {"ok": True})
        if u.path == "/jobs":
            with lock:
                return self._json(200, [view(j) for j in jobs.values()])
        if u.path.startswith("/jobs/"):
            job = jobs.get(u.path.split("/")[2])
            return self._json(200, view(job)) if job else self._json(404, {"error": "unknown job"})
        if u.path == "/files":
            p = q.get("path", [""])[0]
            if not os.path.isfile(p):
                return self._json(404, {"error": f"no such file: {p}"})
            with open(p, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/ls":
            root = q.get("path", [WORK])[0]
            if not os.path.isdir(root):
                return self._json(404, {"error": f"no such folder: {root}"})
            items = []
            for d, dirs, files in os.walk(root):
                dirs[:] = [x for x in dirs if not x.startswith(".")]
                for fn in files:
                    fp = os.path.join(d, fn)
                    try:
                        st = os.stat(fp)
                    except OSError:
                        continue
                    items.append({"path": fp, "size": st.st_size, "mtime": int(st.st_mtime)})
                    if len(items) >= 500:
                        return self._json(200, {"items": items, "truncated": True})
            return self._json(200, {"items": items, "truncated": False})
        return self._json(404, {"error": "not found"})

    def do_PUT(self):
        u = urlparse(self.path)
        if u.path != "/files":
            return self._json(404, {"error": "not found"})
        p = parse_qs(u.query).get("path", [""])[0]
        if not p.startswith("/"):
            return self._json(400, {"error": "absolute path required"})
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = self._body()
        with open(p, "wb") as f:
            f.write(data)
        return self._json(200, {"ok": True, "path": p, "size": len(data)})

    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = json.loads(self._body() or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad json"})
        if u.path == "/exec":
            code = str(body.get("code", ""))
            if not code.strip():
                return self._json(400, {"error": "code required"})
            job = new_job("live", body.get("label") or "python")
            threading.Thread(target=run_exec, args=(job, code), daemon=True).start()
            return self._json(200, wait_for(job, body.get("sync_s", 150)))
        if u.path == "/spawn":
            job = new_job("background", body.get("label") or "blender -b")
            jdir = os.path.join(WORK, "jobs", job["id"])
            os.makedirs(jdir, exist_ok=True)
            job["log"] = os.path.join(jdir, "run.log")
            script = body.get("script")
            if body.get("code"):
                script = os.path.join(jdir, "job.py")
                with open(script, "w") as f:
                    f.write(str(body["code"]))
            if not script or not os.path.isfile(script):
                job.update(status="failed", error=f"script not found in the sandbox: {script}", ended=time.time())
                return self._json(200, view(job))
            scene = body.get("scene", "current")
            blend = None
            if scene == "current":
                blend = os.path.join(jdir, "scene.blend")
                r = addon_call("execute_code", {"code": f"import bpy; bpy.ops.wm.save_as_mainfile(filepath={blend!r}, copy=True)"}, timeout=120)
                if r.get("status") != "success":
                    job.update(status="failed", error=f"could not snapshot the live scene: {r.get('message')}", ended=time.time())
                    return self._json(200, view(job))
            elif scene and scene != "empty":
                blend = scene
            # the script sees the same sys.argv as in the live scene — [script, *argv] —
            # not Blender's own command line
            boot = os.path.join(jdir, "_boot.py")
            with open(boot, "w") as f:
                f.write(
                    "import sys, runpy\n"
                    f"sys.argv = {[script] + [str(a) for a in body.get('argv', [])]!r}\n"
                    f"sys.path.insert(0, {os.path.dirname(script)!r})\n"
                    f"runpy.run_path({script!r}, run_name='__main__')\n"
                )
            cmd = [BLENDER, "-b"] + ([blend] if blend else ["--factory-startup"]) + [
                "--python-exit-code", "1", "--python", boot]
            threading.Thread(target=run_spawn, args=(job, cmd, body.get("cwd") or WORK), daemon=True).start()
            return self._json(200, wait_for(job, body.get("sync_s", 0)))
        if u.path.startswith("/jobs/") and u.path.endswith("/cancel"):
            job = jobs.get(u.path.split("/")[2])
            if not job:
                return self._json(404, {"error": "unknown job"})
            if job["status"] != "running":
                return self._json(200, view(job))
            if job["kind"] == "background" and job.get("proc"):
                job["status"] = "cancelled"
                job["proc"].kill()
                job["ended"] = time.time()
                return self._json(200, view(job))
            # python in the live scene cannot be interrupted from outside
            return self._json(409, {"error": "code running in the live scene cannot be interrupted — stop the sandbox to abort it", **view(job)})
        if u.path == "/screenshot":
            os.makedirs(os.path.join(WORK, "previews"), exist_ok=True)
            fp = os.path.join(WORK, "previews", f"preview-{int(time.time() * 1000)}.png")
            t0 = time.time()
            r = addon_call("get_viewport_screenshot", {"max_size": int(body.get("max_size", 800)), "filepath": fp, "format": "png"}, timeout=600)
            res = r.get("result") or {}
            if r.get("status") != "success" or res.get("error") or not os.path.isfile(fp):
                return self._json(200, {"error": r.get("message") or res.get("error") or "preview failed"})
            return self._json(200, {"path": fp, "elapsed_s": round(time.time() - t0, 1), **{k: res.get(k) for k in ("width", "height", "render_s")}})
        return self._json(404, {"error": "not found"})


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    port = int(os.environ.get("API_PORT", "8001"))
    print(f"bridex api on :{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
