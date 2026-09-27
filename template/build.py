"""Build the template in E2B's cloud (no local Docker): E2B_API_KEY=… python build.py [name]"""
import sys
from e2b import Template, default_build_logger
from template import template

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else "bridex-blender"
    Template.build(template, name, cpu_count=4, memory_mb=8192, on_build_logs=default_build_logger())
