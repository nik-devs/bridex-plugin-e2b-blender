# blender_preview: one view's camera and shading before POST /screenshot renders it
# (ARGS["do"] == "setup"), and everything put back after it ("restore"). What the setup changes is
# kept by name in bpy.app.driver_namespace["bx_view"] (see bx_restore_preview in lib.py).
#
# ARGS: view (camera|front|back|left|right|top|three_quarter|custom), objects (names to frame),
# ortho_views (every orthographic view of this call: they share one scale), azimuth/elevation/lens
# (custom), shading (material|clay|silhouette).


def bx_fit_ortho(rel, views, aspect):
    """The ortho_scale that fits the subject in every one of these views: front, side and top
    then share metres per pixel and compare directly (each view fitting itself made a narrow side
    view look as big as the front)."""
    need = 0.0
    for v in views:
        right, up, _ = bx_basis(*BX_VIEWS[v])
        w = max(abs(p.dot(right)) for p in rel) * 2
        h = max(abs(p.dot(up)) for p in rel) * 2
        need = max(need, max(w, h * aspect) if aspect >= 1 else max(h, w / aspect))
    return max(need * 1.08, 1e-4)


def bx_setup():
    bx_restore_preview()  # a call that never got to its restore
    sc = bpy.context.scene
    st = {"scene": sc.name, "made": [], "overrides": [], "settings": []}
    bpy.app.driver_namespace["bx_view"] = st
    info = {}
    view = ARGS.get("view") or "camera"
    if view == "camera" and sc.camera:
        info["camera"] = "scene"
    else:
        if view == "camera":
            view = "three_quarter"
        names = ARGS.get("objects") or []
        obs = bx_pick(names)
        if not obs:
            raise bx_nothing(names, "frame")
        # a temporary camera framing what is visible (or the named objects), fitted to the frame
        # both ways: a sphere fitted to the wide side of a 16:9 frame cut a tall figure's head and feet
        pts = bx_corners(obs)
        lo = mathutils.Vector([min(p[i] for p in pts) for i in range(3)])
        hi = mathutils.Vector([max(p[i] for p in pts) for i in range(3)])
        center = (lo + hi) / 2
        radius = max((hi - lo).length / 2, 1e-4)
        rel = [p - center for p in pts]
        r = sc.render
        aspect = (r.resolution_x or 1920) / (r.resolution_y or 1080)
        az, el = (float(ARGS.get("azimuth") or 0.0), float(ARGS.get("elevation") or 0.0)) if view == "custom" else BX_VIEWS[view]
        right, up, back = bx_basis(az, el)
        data = bpy.data.cameras.new("bx_view_cam")
        cam = bpy.data.objects.new("bx_view_cam", data)
        st["made"].append(("object", cam.name))
        sc.collection.objects.link(cam)
        if view in BX_ORTHO:
            data.type = 'ORTHO'
            data.ortho_scale = bx_fit_ortho(rel, set(ARGS.get("ortho_views") or ()) | {view}, aspect)
            dist = radius * 4
            info["ortho_scale"] = data.ortho_scale
        else:
            if ARGS.get("lens"):
                data.lens = float(ARGS["lens"])
            t = math.tan(data.angle / 2)
            tan_h, tan_v = (t, t / aspect) if aspect >= 1 else (t * aspect, t)
            dist = max(max(p.dot(back) + abs(p.dot(right)) * 1.06 / tan_h, p.dot(back) + abs(p.dot(up)) * 1.06 / tan_v) for p in rel)
            info["lens"] = data.lens
        cam.matrix_world = bx_camera_matrix(right, up, back, center + back * dist)
        data.clip_start = max(min(0.1, (dist - radius) * 0.5), 1e-4)
        data.clip_end = (dist + radius) * 2
        st["camera"] = sc.camera.name if sc.camera else ""
        sc.camera = cam
        info["camera"] = view

    shading = ARGS.get("shading") or "material"
    if shading in ("clay", "silhouette"):
        # an override on the view layers: every object renders with it, its own materials untouched
        mat = bpy.data.materials.new("bx_" + shading)
        st["made"].append(("material", mat.name))
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        if shading == "clay":
            sh = nt.nodes.new("ShaderNodeBsdfDiffuse")
            sh.inputs["Color"].default_value = (0.62, 0.62, 0.62, 1.0)
        else:
            sh = nt.nodes.new("ShaderNodeEmission")
            sh.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
            mat.cycles.emission_sampling = 'NONE'  # black emits nothing: no mesh lights to build
        nt.links.new(sh.outputs[0], out.inputs["Surface"])
        for vl in sc.view_layers:
            st["overrides"].append((vl.name, vl.material_override.name if vl.material_override else ""))
            vl.material_override = mat
        # and a world of its own: clay an even light grey (the scene's lights on top: under a dark world
        # and one sun from above, the front of a clay figure came out black), silhouette plain white
        world = bpy.data.worlds.new("bx_" + shading + "_world")
        st["made"].append(("world", world.name))
        bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
        bg.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1.0) if shading == "clay" else (1.0, 1.0, 1.0, 1.0)
        bg.inputs["Strength"].default_value = 1.0
        st["world"] = sc.world.name if sc.world else ""
        sc.world = world
    if shading == "silhouette":
        # shown as is (Standard: AgX turns white into light grey)
        # look before view_transform: restored in reverse, the transform comes back before its look
        for owner, attr, value in (
            ("render", "film_transparent", False),
            ("view_settings", "look", "None"),
            ("view_settings", "view_transform", "Standard"),
            ("view_settings", "exposure", 0.0),
            ("view_settings", "gamma", 1.0),
            ("view_settings", "use_curve_mapping", False),
        ):
            target = sc.path_resolve(owner)
            st["settings"].append((owner, attr, getattr(target, attr)))
            setattr(target, attr, value)
    print("BX " + json.dumps(info))


if ARGS.get("do") == "restore":
    bx_restore_preview()
    print("restored")
else:
    bx_setup()
