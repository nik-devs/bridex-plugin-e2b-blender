"""E2B template for the Bridex Blender plugin: Blender (headless) + MCP for
Blender over HTTP (:8000/mcp) + the Bridex job/file API (:8001)."""
from e2b import Template, wait_for_port

BLENDER = "5.2.2"
MCP_FOR_BLENDER = "2.1.0"

template = (
    Template()
    .from_ubuntu_image("24.04")
    .set_user("root")
    .apt_install([
        "ca-certificates", "curl", "xz-utils", "python3", "python3-venv",
        # the shared libraries Blender's Linux build loads even with -b
        "libx11-6", "libxi6", "libxxf86vm1", "libxfixes3", "libxrender1", "libxkbcommon0",
        "libxkbcommon-x11-0", "libsm6", "libice6", "libgl1", "libegl1", "libglib2.0-0",
        "libwayland-client0", "libwayland-cursor0", "libwayland-egl1", "libdecor-0-0",
    ])
    .run_cmd(
        f"curl -fsSL https://download.blender.org/release/Blender{BLENDER.rsplit('.', 1)[0]}/blender-{BLENDER}-linux-x64.tar.xz"
        " | tar -xJ -C /opt && mv /opt/blender-*-linux-x64 /opt/blender"
    )
    .run_cmd(
        "python3 -m venv /opt/bmcp/venv"
        f" && /opt/bmcp/venv/bin/pip install --no-cache-dir mcp-for-blender=={MCP_FOR_BLENDER}"
    )
    .copy("headless.py", "/opt/bmcp/headless.py")
    .copy("serve.py", "/opt/bmcp/serve.py")
    .copy("bridex_api.py", "/opt/bmcp/bridex_api.py")
    .copy("start.sh", "/opt/bmcp/start.sh")
    .set_envs({"DISABLE_TELEMETRY": "1", "PREVIEW_SAMPLES": "16"})
    .set_start_cmd("/opt/bmcp/start.sh", wait_for_port(8001))
)
