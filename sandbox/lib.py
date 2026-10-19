# e2b-blender, sandbox side: helpers shared by the code in this folder. The plugin sends
# "ARGS = json.loads(...)" + this file + one task file (preview.py, game_pixels.py,
# compare_reference.py) to POST /exec, where the live scene runs it with exec(). None of it is in
# template/: the template's file hash names the E2B template, and a change there rebuilds it.
import json
import math
import os
import struct
import time
import zlib

import bpy
import mathutils
import numpy as np

BX_RENDERABLE = {"MESH", "CURVE", "CURVES", "SURFACE", "META", "FONT"}
# where a view looks FROM, as (azimuth, elevation) in degrees: azimuth 0 = front (camera at -Y),
# 90 = camera at +X (right); positive elevation = from above
BX_VIEWS = {
    "front": (0.0, 0.0),
    "back": (180.0, 0.0),
    "left": (-90.0, 0.0),
    "right": (90.0, 0.0),
    "top": (0.0, 90.0),
    "three_quarter": (math.degrees(math.atan2(1.0, 1.2)), math.degrees(math.atan2(0.8, math.hypot(1.0, 1.2)))),
}
BX_ORTHO = ("front", "back", "left", "right", "top")


def bx_basis(azimuth, elevation):
    """Camera axes (right, up, back) looking at the subject from azimuth/elevation. Built from the
    angles, not tracked: a camera straight above has no up to track (top keeps +Y up, like Blender's
    Top view)."""
    az, el = math.radians(azimuth), math.radians(elevation)
    back = mathutils.Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    up = mathutils.Vector((-math.sin(az) * math.sin(el), math.cos(az) * math.sin(el), math.cos(el)))
    return up.cross(back), up, back


def bx_camera_matrix(right, up, back, location):
    m = mathutils.Matrix((right, up, back)).transposed().to_4x4()
    m.translation = location
    return m


def bx_pick(names):
    """Visible objects of a renderable type that a render shows. With names: just those objects
    (their children too) and the objects of those collections (nested collections too)."""
    sc = bpy.context.scene
    names = set(names or ())
    pool = None
    if names:
        pool = set()
        for c in bpy.data.collections:
            if c.name in names:
                pool.update(c.all_objects)
        for o in sc.objects:
            if o.name in names:
                pool.add(o)
                pool.update(o.children_recursive)
    return [o for o in sc.objects if o.type in BX_RENDERABLE and o.visible_get() and not o.hide_render and (pool is None or o in pool)]


def bx_nothing(names, what):
    return RuntimeError(f"nothing visible to {what}" + (": no visible object or collection named " + ", ".join(sorted(names)) if names else " in the scene"))


def bx_corners(obs):
    return [o.matrix_world @ mathutils.Vector(c) for o in obs for c in o.bound_box]


def bx_read_rgba(path, max_px=None):
    """An image as (h, w, 4) float32 in 0..1, row 0 at the top. 8-bit images come as stored, with
    straight alpha and no colour transform."""
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        ch = img.channels
        if not w or not h or not ch:
            raise RuntimeError(f"could not read {os.path.basename(path)} as an image")
        if max_px and w * h > max_px:
            raise ValueError(f"{os.path.basename(path)} is {w}×{h} px — at most {max_px // 1_000_000} MP: give a smaller copy")
        px = np.empty(w * h * ch, np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    px = px.reshape(h, w, ch)[::-1]
    if ch == 4:
        return np.ascontiguousarray(px)
    out = np.ones((h, w, 4), np.float32)
    out[..., :3] = px[..., :1] if ch < 3 else px[..., :3]
    if ch == 2:
        out[..., 3] = px[..., 1]
    return out


def bx_write_png(path, rgba):
    """(h, w, 4) uint8, row 0 at the top, written byte for byte: no colour management on the way."""
    h, w = rgba.shape[:2]
    raw = np.zeros((h, w * 4 + 1), np.uint8)  # filter byte 0 (none) before every row
    raw[:, 1:] = np.ascontiguousarray(rgba, np.uint8).reshape(h, w * 4)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw.tobytes(), 6)) + chunk(b"IEND", b""))


def bx_restore_preview():
    """Put back what a preview's setup changed: the scene camera, material overrides, the world and
    view settings, kept BY NAME in the driver namespace between the setup and the restore call.
    Also cleans up after a call that never got to its restore."""
    st = bpy.app.driver_namespace.pop("bx_view", None)
    if isinstance(st, tuple):  # 0.2.4 kept (scene camera, temporary camera)
        st = {"camera": st[0], "made": [("object", st[1])]} if st[1] else None
    if not st:
        return False
    sc = bpy.data.scenes.get(st.get("scene") or "") or bpy.context.scene
    if "camera" in st:
        sc.camera = bpy.data.objects.get(st["camera"]) if st["camera"] else None
    for layer, mat in st.get("overrides", ()):
        vl = sc.view_layers.get(layer)
        if vl is not None:
            vl.material_override = bpy.data.materials.get(mat) if mat else None
    if "world" in st:
        sc.world = bpy.data.worlds.get(st["world"]) if st["world"] else None
    for owner, attr, value in reversed(st.get("settings", ())):
        try:
            setattr(sc.path_resolve(owner), attr, value)
        except Exception as e:  # noqa: BLE001
            print(f"could not restore {owner}.{attr}: {e}")
    for kind, name in st.get("made", ()):
        coll = {"object": bpy.data.objects, "material": bpy.data.materials, "world": bpy.data.worlds}[kind]
        block = coll.get(name)
        if block is None:
            continue
        data = block.data if kind == "object" else None
        coll.remove(block, do_unlink=True)
        if isinstance(data, bpy.types.Camera) and data.users == 0:
            bpy.data.cameras.remove(data)
    return True
