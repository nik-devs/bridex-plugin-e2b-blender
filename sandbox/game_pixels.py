# blender_preview game_px: a render made at game size, enlarged with hard pixels (every pixel a
# factor×factor block, nearest neighbour) so it can be seen the way the game will show it.
# ARGS: src (the small render), dst, factor.
src, dst = ARGS["src"], ARGS["dst"]
k = max(1, int(ARGS.get("factor") or 1))
px = np.clip(np.rint(bx_read_rgba(src) * 255.0), 0, 255).astype(np.uint8)
if k > 1:
    px = np.repeat(np.repeat(px, k, axis=0), k, axis=1)
bx_write_png(dst, px)
print("BX " + json.dumps({"path": dst, "width": int(px.shape[1]), "height": int(px.shape[0]), "factor": k}))
