#!/usr/bin/env python3
"""Install one release wheel and verify its CLI, health endpoint, and embedded SPA."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import venv
from pathlib import Path
from typing import TextIO


def fail(message: str, log: TextIO | None = None) -> None:
    if log is not None:
        log.flush()
        log.seek(0)
        details = log.read().strip()
        if details:
            message = f"{message}\nBurrow output:\n{details}"
    raise SystemExit(message)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: smoke_release_wheel.py WHEEL_DIRECTORY")
    version = os.environ.get("RELEASE_VERSION")
    if not version:
        raise SystemExit("RELEASE_VERSION must be set")

    wheel_dir = Path(sys.argv[1])
    wheels = sorted(wheel_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise SystemExit(f"Expected one wheel in {wheel_dir}, found {len(wheels)}: {[wheel.name for wheel in wheels]}")
    wheel = wheels[0].resolve()
    if not wheel.name.startswith(f"yarn_burrow-{version}-"):
        raise SystemExit(f"Wheel does not match release version {version}: {wheel.name}")

    with tempfile.TemporaryDirectory(prefix="burrow-wheel-smoke-") as temporary:
        environment = Path(temporary) / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        burrow = scripts / ("burrow.exe" if os.name == "nt" else "burrow")

        subprocess.run(
            [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-deps", str(wheel)],
            check=True,
        )
        version_result = subprocess.run([str(burrow), "--version"], check=True, capture_output=True, text=True)
        if version not in f"{version_result.stdout}\n{version_result.stderr}":
            fail(f"Installed wheel did not report release version {version}: {version_result.stdout.strip()}")
        subprocess.run([str(burrow), "--help"], check=True, stdout=subprocess.DEVNULL)

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]

        with tempfile.TemporaryFile(mode="w+t") as output:
            server = subprocess.Popen(
                [str(burrow), "--no-open", "--port", str(port), "--rm", "http://127.0.0.1:1"],
                stdout=output,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        fail(f"Burrow exited before health check (status {server.returncode})", output)
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/healthz", timeout=1) as response:
                            if response.status == 200:
                                break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.25)
                else:
                    fail(f"Burrow did not answer /api/healthz on port {port} within 20 seconds", output)

                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as response:
                    shell = response.read().decode("utf-8")
                if response.status != 200 or "<title>Burrow</title>" not in shell:
                    fail("Burrow did not serve the embedded SPA shell", output)
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()

    print(f"Wheel smoke passed: {wheel.name}")


if __name__ == "__main__":
    main()
