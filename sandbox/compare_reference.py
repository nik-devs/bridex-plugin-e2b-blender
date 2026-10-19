# blender_preview reference=...: the model against ONE orthographic view of a reference sheet,
# registered in world units. The camera covers exactly the crop's world window (from the scale and
# where the world origin sits in the crop), so the model's silhouette and the sheet's figure meet
# pixel for pixel: nothing is re-centred or re-scaled, and a model 4 % short or 3 cm off its axis
# shows it instead of being normalised away.
# The approach follows world_gate.py of blender-game-skills (MIT, (c) 2026 Majid Manzarpour);
# written anew for the live scene: Cycles on the CPU (the sandbox has no GPU), every setting put back.
#
# ARGS: image, mask, crop [x0, y0, x1, y1], view, m_per_px | height_m, origin [col, row],
# tolerance, landmarks [{name, object, point, at}], objects, out (the diff PNG), view_px.
# Prints "BX {json}" with the numbers.

BX_MAX_PX = 4_200_000  # the silhouette render stays under ~4 MP: supersampling drops before that
BX_BG, BX_BOTH, BX_SHEET, BX_MODEL = (38, 38, 38), (150, 150, 150), (225, 62, 62), (62, 112, 240)
BX_AXIS, BX_MARK_SHEET, BX_MARK_MODEL = (92, 92, 92), (255, 214, 0), (110, 190, 255)


def bx_max_filter(a, r):
    """The maximum over the (2r+1)×(2r+1) window around every pixel (outside the image does not
    count) — separable and in place: a stack of shifted copies of a 4 MP crop took gigabytes."""
    out = a.copy()
    for axis in (0, 1):
        src = out.copy()
        for s in range(1, min(r, a.shape[axis] - 1) + 1):
            lo = (slice(None),) * axis + (slice(s, None),)
            hi = (slice(None),) * axis + (slice(None, -s),)
            np.maximum(out[lo], src[hi], out=out[lo])
            np.maximum(out[hi], src[lo], out=out[hi])
    return out


def bx_extents(mask):
    """Per row: the outer width in px (first to last filled pixel), 0 for an empty row."""
    has = mask.any(1)
    first = mask.argmax(1)
    last = mask.shape[1] - 1 - mask[:, ::-1].argmax(1)
    return np.where(has, last - first + 1, 0)


def bx_box(mask):
    rows, cols = np.flatnonzero(mask.any(1)), np.flatnonzero(mask.any(0))
    if not len(rows):
        return None
    return int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1  # top, bottom, left, right (pixel edges)


def bx_edges(cov, mask, box):
    """The box's edges to a fraction of a pixel, from coverage (0..1): along a straight edge, the
    figure's outermost pixels and the ones just outside them together say where it runs (a soft
    edge's spread cancels out) — whole pixels read a model 4 % short at 0.5 cm a pixel as 3.9 %.
    Medians along the edge, not the brightest pixel: a noisy render has fully covered ones on any
    edge. Returns (top, bottom, left, right) and how far each edge's two coverages are from adding
    up to 1 (they do in the colour space the edge was smoothed in)."""
    top, bot, left, right = box
    H, W = cov.shape
    sides = (
        (cov[top], cov[top - 1] if top > 0 else None, mask[top]),
        (cov[bot - 1], cov[bot] if bot < H else None, mask[bot - 1]),
        (cov[:, left], cov[:, left - 1] if left > 0 else None, mask[:, left]),
        (cov[:, right - 1], cov[:, right] if right < W else None, mask[:, right - 1]),
    )
    c = [(float(np.median(cin[sel])), float(np.median(cout[sel])) if cout is not None else 0.0) for cin, cout, sel in sides]
    edges = (top + 1 - sum(c[0]), bot - 1 + sum(c[1]), left + 1 - sum(c[2]), right - 1 + sum(c[3]))
    return edges, sum(abs(a + b - 1.0) for a, b in c)


def bx_geometry_box(model, to_px):
    """The model's extremes (top, bottom, left, right) in crop px, measured on its evaluated vertices:
    exact, where the silhouette's pixels know them to a quarter pixel. None when a part has no mesh."""
    dg = bpy.context.evaluated_depsgraph_get()
    us, vs = [], []
    for o in model:
        ev = o.evaluated_get(dg)
        try:
            me = ev.to_mesh()
        except RuntimeError:
            return None
        try:
            if me is None:
                return None
            co = np.empty(len(me.vertices) * 3, np.float64)
            me.vertices.foreach_get("co", co)
        finally:
            ev.to_mesh_clear()
        if not len(co):
            continue
        m = np.array(ev.matrix_world)
        u, v = to_px(co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
        us += [u.min(), u.max()]
        vs += [v.min(), v.max()]
    return (min(vs), max(vs), min(us), max(us)) if us else None


def bx_linear(c):
    """sRGB-encoded values (0..1) to linear light."""
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def bx_sheet_mask(crop, full, xy):
    """The figure in the crop: from the mask image, from alpha when the sheet has transparency, else
    by distance from the corner colour. Returns (mask, coverage 0..1, method, warnings)."""
    H, W = crop.shape[:2]
    x0, y0, x1, y1 = xy
    if ARGS.get("mask"):
        mk = bx_read_rgba(ARGS["mask"], max_px=64_000_000)
        if mk.shape[:2] == full:
            mk = mk[y0:y1, x0:x1]
        elif mk.shape[:2] != (H, W):
            raise ValueError(f"the mask is {mk.shape[1]}×{mk.shape[0]} px: it must be the size of the image ({full[1]}×{full[0]}) or of the crop ({W}×{H})")
        cov = mk[..., :3].mean(-1) * mk[..., 3]
        return cov >= 0.5, cov, "the mask image", []
    if (crop[..., 3] < 0.5).mean() >= 0.01:
        return crop[..., 3] >= 0.5, crop[..., 3], "alpha", []
    tol = float(ARGS.get("tolerance", 40))
    rgb = crop[..., :3]
    n = max(1, min(8, W // 10, H // 10))
    corners = np.concatenate([q.reshape(-1, 3) for q in (rgb[:n, :n], rgb[:n, -n:], rgb[-n:, :n], rgb[-n:, -n:])])
    bg = np.median(corners, axis=0)
    # summed over R, G and B: a light part on a light background (skin on grey) differs a little in
    # every channel — the largest single channel lost a tenth of such a head at the default 40
    dist = np.abs(rgb - bg).sum(-1) * 255.0
    mask = dist > tol
    # anti-aliased edges: an outline pixel counts when it is at least half as far from the background
    # as the figure within 2 px of it, i.e. at least half covered. Peeled from the outside in (a soft
    # edge is a fringe of 1–3 px): a plain threshold grows the figure by a pixel or more on every side,
    # and a true model read short against it. Only the outline is touched, never the inside (a light
    # fill next to a dark outline stays).
    for _ in range(3):
        edge = mask & bx_max_filter(~mask, 1)
        weak = edge & (dist < 0.5 * bx_max_filter(np.where(mask, dist, 0.0), 2))
        if not weak.any():
            break
        mask &= ~weak
    # coverage near the figure, for its edges to a fraction of a pixel: a pixel's distance against the
    # figure's within 2 px. Renders and photos smooth edges in linear light, 2D art in the stored
    # values: the space where an edge's two pixels add up to one whole is the sheet's
    box, best = bx_box(mask), None
    for d in (dist, np.abs(bx_linear(rgb) - bx_linear(bg)).sum(-1)):
        full_d = bx_max_filter(np.where(mask, d, 0.0), 2)
        cov = np.where(full_d > 0, np.clip(d / np.maximum(full_d, 1e-9), 0.0, 1.0), 0.0)
        err = bx_edges(cov, mask, box)[1] if box else 0.0
        if best is None or err < best[0]:
            best = (err, cov)
    cov = best[1]
    hexbg = "#%02x%02x%02x" % tuple(int(round(float(c) * 255)) for c in bg)
    warnings = []
    if (np.abs(corners - bg).sum(-1) * 255.0 > tol).mean() > 0.05:
        warnings.append(f"the crop's corners are not all background ({hexbg}) — if the diff looks wrong, crop with some background around the figure or give mask")
    return mask, cov, f"corner colour {hexbg} ± {tol:g}", warnings


def bx_compare():
    t_start = time.time()
    sc = bpy.context.scene
    view = ARGS.get("view") or "front"
    if view not in BX_ORTHO:
        raise ValueError("view must be one of " + ", ".join(BX_ORTHO))
    bx_restore_preview()  # a preview that never got to its restore must not stay in the picture

    # -- the sheet: the crop, its figure, the scale and where the world origin is --------------------
    sheet_rgba = bx_read_rgba(ARGS["image"], max_px=64_000_000)
    H0, W0 = sheet_rgba.shape[:2]
    if ARGS.get("crop"):
        x0, y0, x1, y1 = (int(round(float(v))) for v in ARGS["crop"])
        if not (0 <= x0 < x1 <= W0 and 0 <= y0 < y1 <= H0):
            raise ValueError(f"crop [{x0}, {y0}, {x1}, {y1}] is not inside the image ({W0}×{H0} px): [x0, y0, x1, y1] with 0 ≤ x0 < x1 ≤ {W0}, 0 ≤ y0 < y1 ≤ {H0}")
    else:
        x0, y0, x1, y1 = 0, 0, W0, H0
    crop = sheet_rgba[y0:y1, x0:x1]
    H, W = crop.shape[:2]
    if W * H > BX_MAX_PX:
        raise ValueError(f"the crop is {W}×{H} px — at most about 4 MP (2000×2000): crop to the one view, or give a smaller copy of the sheet")
    sheet, sheet_cov, method, warnings = bx_sheet_mask(crop, (H0, W0), (x0, y0, x1, y1))
    area = int(sheet.sum())
    if not area:
        raise ValueError(f"no figure found in the crop (by {method}) — check crop and tolerance, or give mask")
    if area > 0.9 * W * H:
        raise ValueError(f"the figure fills {100 * area / (W * H):.0f} % of the crop (by {method}) — the background was not told apart: crop with some background around the figure, or give mask")
    s_box = bx_box(sheet)
    if s_box[0] == 0 or s_box[2] == 0 or s_box[1] == H or s_box[3] == W:
        warnings.append("the sheet's figure touches the crop's edge — the crop may cut it")
    (s_top, s_bot, s_left, s_right), _ = bx_edges(sheet_cov, sheet, s_box)
    if ARGS.get("m_per_px"):
        S = float(ARGS["m_per_px"])
        scale_from = "m_per_px"
    else:
        if view == "top":
            raise ValueError("height_m sets the scale from the figure's height, which a top view does not show — give m_per_px")
        S = float(ARGS["height_m"]) / (s_bot - s_top)
        scale_from = f"height_m {float(ARGS['height_m']):g} over the figure's {s_bot - s_top:.1f} px"
    if ARGS.get("origin"):
        oc, orow = (float(v) for v in ARGS["origin"])
        origin_from = "given"
    else:
        oc = (s_left + s_right) / 2.0
        orow = (s_top + s_bot) / 2.0 if view == "top" else float(s_bot)
        origin_from = "default: the figure's box centre" if view == "top" else "default: the figure's box centre column, its bottom row"
        if view in ("left", "right", "top"):
            # a front view is symmetric about its axis; a profile (nose, feet) or a top view rarely is
            warnings.append("the world origin was put at the figure's box centre, and a side or top view is rarely centred on its axis: the centre offset is measured from that box — give origin to measure it from the axis")

    # -- the model's silhouette through a camera on exactly that world window -----------------------
    names = ARGS.get("objects") or []
    model = bx_pick(names)
    if not model:
        raise bx_nothing(names, "compare")
    right, up, back = bx_basis(*BX_VIEWS[view])
    centre = right * ((W / 2.0 - oc) * S) + up * ((orow - H / 2.0) * S)  # the world point at the crop's centre
    R, U, C = np.array(right), np.array(up), np.array(centre)

    def to_px(p):
        """World points (…×3) to crop px: column, row."""
        d = np.asarray(p, np.float64) - C
        return W / 2.0 + d @ R / S, H / 2.0 - d @ U / S

    depth = [p.dot(back) for p in bx_corners(model)]
    d_near, d_far = max(depth), min(depth)
    margin = max(0.1, (d_near - d_far) * 0.1)
    k = next((s for s in (4, 3, 2) if W * H * s * s <= BX_MAX_PX), 1)
    out = ARGS["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = os.path.join(os.path.dirname(out), ".bx_compare_silhouette.png")

    changed, made = [], []

    def put(owner, attr, value):
        """Set it and remember what it was (skipped when this Blender has no such setting)."""
        if not hasattr(owner, attr):
            return
        old = getattr(owner, attr)
        if old != value:
            setattr(owner, attr, value)
            changed.append((owner, attr, old))

    try:
        keep = set(model)
        stuck = []
        for o in sc.objects:
            if o not in keep:
                try:
                    put(o, "hide_render", True)
                except (AttributeError, TypeError):  # linked from a library: read-only here
                    stuck.append(o.name)
        if stuck:
            warnings.append(f"could not hide {len(stuck)} object(s) for the render (linked from a library?): {', '.join(stuck[:4])}{', …' if len(stuck) > 4 else ''} — they may be in the silhouette")
        mat = bpy.data.materials.new("bx_compare")
        made.append((bpy.data.materials, mat))
        nt = mat.node_tree
        nt.nodes.clear()
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
        nt.links.new(em.outputs[0], nt.nodes.new("ShaderNodeOutputMaterial").inputs["Surface"])
        mat.cycles.emission_sampling = 'NONE'
        data = bpy.data.cameras.new("bx_compare_cam")
        made.append((bpy.data.cameras, data))
        cam = bpy.data.objects.new("bx_compare_cam", data)
        made.insert(0, (bpy.data.objects, cam))
        sc.collection.objects.link(cam)
        data.type = 'ORTHO'
        data.sensor_fit = 'HORIZONTAL'
        data.ortho_scale = W * S
        data.clip_start = margin / 2
        data.clip_end = d_near - d_far + margin * 2
        cam.matrix_world = bx_camera_matrix(right, up, back, centre + back * (d_near + margin))
        r, cy, ims = sc.render, sc.cycles, sc.render.image_settings
        put(r, "engine", "CYCLES")
        # one point sample per pixel at its centre (k×k of them per sheet pixel): alpha is all we read
        for attr, value in (("device", "CPU"), ("samples", 1), ("use_adaptive_sampling", False), ("use_denoising", False),
                            ("pixel_filter_type", "BOX"), ("filter_width", 0.01), ("max_bounces", 0), ("time_limit", 0.0)):
            put(cy, attr, value)
        for vl in sc.view_layers:
            put(vl, "samples", 0)
            put(vl, "material_override", mat)
        for attr, value in (("film_transparent", True), ("use_single_layer", True), ("use_compositing", False), ("use_sequencer", False),
                            ("use_freestyle", False), ("use_border", False), ("use_motion_blur", False), ("use_multiview", False),
                            ("pixel_aspect_x", 1.0), ("pixel_aspect_y", 1.0), ("resolution_x", W * k), ("resolution_y", H * k),
                            ("resolution_percentage", 100), ("filepath", tmp)):
            put(r, attr, value)
        for attr, value in (("media_type", "IMAGE"), ("file_format", "PNG"), ("color_mode", "RGBA"), ("color_depth", "8")):
            put(ims, attr, value)
        put(sc, "camera", cam)
        t_render = time.time()
        bpy.ops.render.render(write_still=True)
        render_s = time.time() - t_render
        alpha = bx_read_rgba(tmp)[..., 3]
    finally:
        for owner, attr, old in reversed(changed):
            try:
                setattr(owner, attr, old)
            except Exception as e:  # noqa: BLE001
                print(f"could not restore {attr}: {e}")
        for coll, block in made:
            try:
                coll.remove(block, do_unlink=True)
            except Exception as e:  # noqa: BLE001
                print(f"could not remove {block!r}: {e}")
        if os.path.exists(tmp):
            os.remove(tmp)
    if alpha.shape != (H * k, W * k):
        raise RuntimeError(f"the silhouette came out {alpha.shape[1]}×{alpha.shape[0]} px, not {W * k}×{H * k}")
    mod_cov = alpha.reshape(H, k, W, k).mean(axis=(1, 3))  # the model's exact coverage of every sheet pixel
    mod = mod_cov >= 0.5

    # -- the numbers -------------------------------------------------------------------------------
    cm = S * 100.0
    both, s_only, m_only = sheet & mod, sheet & ~mod, mod & ~sheet
    res = {
        "view": view, "crop": [x0, y0, x1, y1], "size": [W, H], "image_size": [W0, H0], "mask": method,
        "m_per_px": S, "scale_from": scale_from, "origin": [round(oc, 1), round(orow, 1)], "origin_from": origin_from,
        "iou": round(float(both.sum()) / float((sheet | mod).sum()), 4),
        "sheet_only_pct": round(100.0 * float(s_only.sum()) / area, 2),
        "model_only_pct": round(100.0 * float(m_only.sum()) / area, 2),
        "sheet_cm": {"height": round((s_bot - s_top) * cm, 2), "width": round((s_right - s_left) * cm, 2)},
        "objects": [o.name for o in model[:8]], "object_count": len(model),
        "render_px": [W * k, H * k], "supersample": k, "render_s": round(render_s, 2),
    }
    m_box = bx_box(mod)
    if m_box is None:
        warnings.append("nothing of the model falls inside the sheet's window — check view, scale and origin")
    else:
        px_edges = bx_edges(mod_cov, mod, m_box)[0]
        geo = bx_geometry_box(model, to_px)
        # the vertices give the exact extremes; the pixels stand where the two disagree by more than a
        # pixel (instances or hair the mesh does not hold, geometry outside the sheet's window)
        m_top, m_bot, m_left, m_right = (g if geo is not None and abs(g - q) <= 1.0 else q for g, q in zip(geo or px_edges, px_edges))
        if m_box[0] == 0 or m_box[2] == 0 or m_box[1] == H or m_box[3] == W:
            warnings.append("the model reaches the crop's edge: part of it is outside the sheet's window — or a helper (a floor, a reference plane) is in the picture: name the model in objects")
        res["model_cm"] = {"height": round((m_bot - m_top) * cm, 2), "width": round((m_right - m_left) * cm, 2)}
        res["top_cm"] = round((s_top - m_top) * cm, 2)  # up +
        res["bottom_cm"] = round((s_bot - m_bot) * cm, 2)  # up +
        res["centre_cm"] = round(((m_left + m_right) - (s_left + s_right)) / 2.0 * cm, 2)  # right +
        # outer width per row (whole pixels), model − sheet, averaged over 10 bands of the sheet figure's height
        ext_s, ext_m = bx_extents(sheet), bx_extents(mod)
        bands = []
        r0, r1 = s_box[0], s_box[1]
        for b in range(10):
            ra = r0 + int(round(b * (r1 - r0) / 10.0))
            rb = max(ra + 1, r0 + int(round((b + 1) * (r1 - r0) / 10.0)))
            es, emd = ext_s[ra:rb], ext_m[ra:rb]
            sel = (es > 0) | (emd > 0)
            bands.append(round(float((emd[sel] - es[sel]).mean()) * cm, 2) if sel.any() else None)
        res["bands_cm"] = bands

    marks = []
    dg = bpy.context.evaluated_depsgraph_get()
    for lm in ARGS.get("landmarks") or []:
        name = str(lm.get("name") or lm.get("object"))
        ob = sc.objects.get(str(lm.get("object") or ""))
        if ob is None:
            marks.append({"name": name, "error": f"no object named {lm.get('object')!r}"})
            continue
        u, v = (float(x) for x in to_px(ob.evaluated_get(dg).matrix_world @ mathutils.Vector(lm.get("point") or (0.0, 0.0, 0.0))))
        ac, ar = (float(x) for x in lm["at"])
        marks.append({"name": name, "dx_cm": round((u - ac) * cm, 2), "dy_cm": round((ar - v) * cm, 2), "model_px": [round(u, 1), round(v, 1)], "sheet_px": [ac, ar]})
    res["landmarks"] = marks

    # -- the diff picture: grey both, red sheet only, blue model only ---------------------------------
    f = max(1, min(8, int(ARGS.get("view_px") or 800) // max(W, H)))
    img = np.empty((H, W, 3), np.uint8)
    img[:] = BX_BG
    img[both], img[s_only], img[m_only] = BX_BOTH, BX_SHEET, BX_MODEL
    if f > 1:
        img = np.repeat(np.repeat(img, f, axis=0), f, axis=1)
    hh, ww = img.shape[:2]
    empty = (img == BX_BG).all(-1)
    col, row = int(math.floor(oc * f)), int(math.floor(orow * f))
    if 0 <= col < ww:  # the world's vertical axis (top view: x = 0) and the ground (top view: y = 0), behind both figures
        img[:, col][empty[:, col]] = BX_AXIS
    if 0 <= row < hh:
        img[row][empty[row]] = BX_AXIS

    def cross(x, y, colour):
        cx, cy_, a = int(math.floor(x * f)), int(math.floor(y * f)), max(4, 2 * f)
        for c, grow in (((0, 0, 0), 1), (colour, 0)):
            for ya, yb, xa, xb in ((cy_ - grow, cy_ + 1 + grow, cx - a - grow, cx + a + 1 + grow), (cy_ - a - grow, cy_ + a + 1 + grow, cx - grow, cx + 1 + grow)):
                ya, yb, xa, xb = max(0, ya), min(hh, yb), max(0, xa), min(ww, xb)
                if ya < yb and xa < xb:
                    img[ya:yb, xa:xb] = c

    for m in marks:
        if "error" not in m:
            cross(*m["sheet_px"], BX_MARK_SHEET)
            cross(*m["model_px"], BX_MARK_MODEL)
    rgba = np.empty((hh, ww, 4), np.uint8)
    rgba[..., :3], rgba[..., 3] = img, 255
    bx_write_png(out, rgba)
    res.update(out=out, diff_px=[ww, hh], warnings=warnings, elapsed_s=round(time.time() - t_start, 2))
    print("BX " + json.dumps(res))


bx_compare()
