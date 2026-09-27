"""Run the MCP for Blender addon inside a headless Blender (blender -b).

The addon refuses to start in background mode: its socket server hands every
command to a bpy.app.timers callback, and timers never tick when there is no
UI event loop. Here the same addon is loaded unchanged and this script becomes
the main loop instead — it drains the addon's command queue on Blender's main
thread, which is exactly what the timer did.

The one command that needs a screen is get_viewport_screenshot (it grabs the
3D viewport). Without a window it renders the scene with Cycles on the CPU
instead: through the scene camera if there is one, otherwise through a
temporary camera framing everything visible, lit by a temporary sun when the
scene has no lights of its own — so "look at what I made" always returns a
picture, like the viewport's solid view does.

    blender -b --factory-startup --python headless.py

Env: BLENDER_MCP_ADDON (addon.py path), BLENDER_PORT (9876),
PREVIEW_SAMPLES (16), PREVIEW_THREADS (0 = all cores).
"""
import glob
import importlib.util
import math
import os
import socket
import sys
import threading
import time

import bpy
import mathutils


def addon_path():
    p = os.environ.get("BLENDER_MCP_ADDON")
    if p:
        return p
    # the addon bundled with the installed MCP server: server and addon always match
    hits = glob.glob("/opt/bmcp/venv/lib/python3*/site-packages/blender_mcp/bundled/addon.py")
    if not hits:
        sys.exit("headless: addon.py not found — set BLENDER_MCP_ADDON")
    return hits[0]


spec = importlib.util.spec_from_file_location("blender_mcp_addon", addon_path())
addon = importlib.util.module_from_spec(spec)
sys.modules["blender_mcp_addon"] = addon
spec.loader.exec_module(addon)
addon.register()


def _visible_bounds():
    lo = mathutils.Vector((math.inf,) * 3)
    hi = mathutils.Vector((-math.inf,) * 3)
    found = False
    for ob in bpy.context.scene.objects:
        if ob.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"} or ob.hide_render or not ob.visible_get():
            continue
        for c in ob.bound_box:
            w = ob.matrix_world @ mathutils.Vector(c)
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
            found = True
    if not found:
        return mathutils.Vector((0, 0, 0)), 1.0
    return (lo + hi) / 2, max((hi - lo).length / 2, 0.1)


class HeadlessServer(addon.BlenderMCPServer):
    def start(self):
        # the addon's start() minus the background-mode refusal and the timer:
        # the loop at the bottom of this file drains the queue instead
        self.running = True
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind((self.host, self.port))
        self.socket.listen(5)
        self.server_thread = threading.Thread(target=self._server_loop, daemon=True)
        self.server_thread.start()
        print(f"headless BlenderMCP listening on {self.host}:{self.port}", flush=True)

    def get_viewport_screenshot(self, max_size=800, filepath=None, format="png"):
        if not filepath:
            return {"error": "No filepath provided"}
        scene = bpy.context.scene
        r = scene.render
        saved = {
            "engine": r.engine, "x": r.resolution_x, "y": r.resolution_y, "pct": r.resolution_percentage,
            "fmt": r.image_settings.file_format, "path": r.filepath, "camera": scene.camera,
            "tmode": r.threads_mode, "threads": r.threads,
        }
        temp = []
        try:
            cam = scene.camera
            if cam is None:
                center, radius = _visible_bounds()
                data = bpy.data.cameras.new("mcp_preview_cam")
                cam = bpy.data.objects.new("mcp_preview_cam", data)
                scene.collection.objects.link(cam)
                temp.append(cam)
                direction = mathutils.Vector((1.0, -1.2, 0.8)).normalized()
                fov = data.angle
                dist = radius / math.sin(fov / 2) * 1.05
                cam.location = center + direction * dist
                cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
                data.clip_end = dist * 10
                scene.camera = cam
            if not any(o.type == "LIGHT" and not o.hide_render for o in scene.objects):
                sun = bpy.data.objects.new("mcp_preview_sun", bpy.data.lights.new("mcp_preview_sun", "SUN"))
                sun.data.energy = 3.0
                sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
                scene.collection.objects.link(sun)
                temp.append(sun)

            aspect = (r.resolution_x or 1920) / (r.resolution_y or 1080)
            if aspect >= 1:
                r.resolution_x, r.resolution_y = max_size, max(1, round(max_size / aspect))
            else:
                r.resolution_x, r.resolution_y = max(1, round(max_size * aspect)), max_size
            r.resolution_percentage = 100
            r.engine = "CYCLES"
            scene.cycles.device = "CPU"
            scene.cycles.samples = int(os.environ.get("PREVIEW_SAMPLES", "16"))
            scene.cycles.use_denoising = True
            threads = int(os.environ.get("PREVIEW_THREADS", "0"))
            if threads > 0:
                r.threads_mode, r.threads = "FIXED", threads
            r.image_settings.file_format = format.upper()
            r.filepath = filepath
            t0 = time.time()
            bpy.ops.render.render(write_still=True)
            return {
                "success": True, "width": r.resolution_x, "height": r.resolution_y, "filepath": filepath,
                "method": "cycles_cpu", "render_s": round(time.time() - t0, 2),
            }
        except Exception as e:
            return {"error": str(e)}
        finally:
            for ob in temp:
                d = ob.data
                bpy.data.objects.remove(ob, do_unlink=True)
                if isinstance(d, bpy.types.Camera):
                    bpy.data.cameras.remove(d)
                elif isinstance(d, bpy.types.Light):
                    bpy.data.lights.remove(d)
            scene.camera = saved["camera"]
            r.engine, r.resolution_x, r.resolution_y = saved["engine"], saved["x"], saved["y"]
            r.resolution_percentage, r.filepath = saved["pct"], saved["path"]
            r.image_settings.file_format = saved["fmt"]
            r.threads_mode, r.threads = saved["tmode"], saved["threads"]


server = HeadlessServer(host="127.0.0.1", port=int(os.environ.get("BLENDER_PORT", "9876")))
server.start()
while True:
    server._drain_command_queue()
    time.sleep(0.02)
