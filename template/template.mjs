import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Template, waitForPort } from "e2b";

/**
 * The sandbox template: Blender (headless) + MCP for Blender over HTTP
 * (:8000/mcp) + the Bridex job/file API (:8001). Built by the plugin itself in
 * the E2B account of the instance's own key — a template lives in one E2B
 * team, so it cannot be built once for everybody.
 */

export const BLENDER = "5.2.2";
export const MCP_FOR_BLENDER = "2.1.0";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["headless.py", "serve.py", "bridex_api.py", "start.sh"];

export function blenderTemplate() {
  return Template({ fileContextPath: DIR })
    .fromUbuntuImage("24.04")
    .setUser("root")
    .aptInstall([
      "ca-certificates", "curl", "xz-utils", "python3", "python3-venv",
      // the shared libraries Blender's Linux build loads even with -b
      "libx11-6", "libxi6", "libxxf86vm1", "libxfixes3", "libxrender1", "libxkbcommon0",
      "libxkbcommon-x11-0", "libsm6", "libice6", "libgl1", "libegl1", "libglib2.0-0",
      "libwayland-client0", "libwayland-cursor0", "libwayland-egl1", "libdecor-0-0",
    ])
    .runCmd(
      `curl -fsSL https://download.blender.org/release/Blender${BLENDER.split(".").slice(0, 2).join(".")}/blender-${BLENDER}-linux-x64.tar.xz` +
        " | tar -xJ -C /opt && mv /opt/blender-*-linux-x64 /opt/blender",
    )
    .runCmd(`python3 -m venv /opt/bmcp/venv && /opt/bmcp/venv/bin/pip install --no-cache-dir mcp-for-blender==${MCP_FOR_BLENDER}`)
    .copy("headless.py", "/opt/bmcp/headless.py")
    .copy("serve.py", "/opt/bmcp/serve.py")
    .copy("bridex_api.py", "/opt/bmcp/bridex_api.py")
    .copy("start.sh", "/opt/bmcp/start.sh", { mode: 0o755 })
    .setEnvs({ DISABLE_TELEMETRY: "1", PREVIEW_SAMPLES: "16" })
    .setStartCmd("/opt/bmcp/start.sh", waitForPort(8001));
}

/** Name of the template for this exact content: a change in any file is a new build. */
export function templateName() {
  const h = crypto.createHash("sha256");
  h.update(`${BLENDER}|${MCP_FOR_BLENDER}|`);
  h.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  for (const f of FILES) h.update(fs.readFileSync(path.join(DIR, f)));
  return `bridex-blender-${h.digest("hex").slice(0, 10)}`;
}
