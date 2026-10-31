#!/usr/bin/env python3
"""Validate the exact platform wheel set before preparing a release."""

import re
import sys
import zipfile
from email.parser import Parser
from pathlib import Path

EXPECTED_TARGETS = {
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-musl",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
}


def target_for_platform(tag):
    if tag.startswith("manylinux") and tag.endswith("_x86_64"):
        return "x86_64-unknown-linux-gnu"
    if tag.startswith("manylinux") and tag.endswith("_aarch64"):
        return "aarch64-unknown-linux-gnu"
    if tag.startswith("musllinux_1_2_") and tag.endswith("_x86_64"):
        return "x86_64-unknown-linux-musl"
    if tag.startswith("macosx_") and tag.endswith("_arm64"):
        return "aarch64-apple-darwin"
    if tag.startswith("macosx_") and tag.endswith("_x86_64"):
        return "x86_64-apple-darwin"
    if tag == "win_amd64":
        return "x86_64-pc-windows-msvc"
    return None


def one_member(names, suffix, wheel):
    matches = [name for name in names if name.endswith(suffix)]
    if len(matches) != 1:
        raise SystemExit(f"Expected one {suffix} member in {wheel.name}, found {matches}")
    return matches[0]


def validate_wheel(wheel, expected_version):
    parts = wheel.name[:-4].split("-")
    if len(parts) != 5:
        raise SystemExit(f"Invalid wheel filename: {wheel.name}")
    distribution, version, python_tags, abi_tags, platform_field = parts
    if distribution != "yarn_burrow" or version != expected_version:
        raise SystemExit(f"Wheel name does not match yarn-burrow {expected_version}: {wheel.name}")
    if python_tags != "py3" or abi_tags != "none":
        raise SystemExit(f"Expected a py3-none binary wheel: {wheel.name}")

    platform_tags = platform_field.split(".")
    if not platform_tags or len(set(platform_tags)) != len(platform_tags):
        raise SystemExit(f"Invalid or duplicate platform tags in {wheel.name}: {platform_field}")
    targets = {target_for_platform(tag) for tag in platform_tags}
    if None in targets or len(targets) != 1:
        raise SystemExit(f"Platform tags do not identify one release target in {wheel.name}: {platform_tags}")
    target = next(iter(targets))

    try:
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
            metadata_member = one_member(names, ".dist-info/METADATA", wheel)
            wheel_member = one_member(names, ".dist-info/WHEEL", wheel)
            metadata = Parser().parsestr(archive.read(metadata_member).decode("utf-8"))
            wheel_metadata = Parser().parsestr(archive.read(wheel_member).decode("utf-8"))
    except (OSError, zipfile.BadZipFile, UnicodeDecodeError) as error:
        raise SystemExit(f"Could not inspect {wheel.name}: {error}") from error

    normalized_name = re.sub(r"[-_.]+", "_", metadata.get("Name", "")).lower()
    if normalized_name != "yarn_burrow" or metadata.get("Version") != expected_version:
        raise SystemExit(f"Wheel METADATA does not match yarn-burrow {expected_version}: {wheel.name}")
    filename_tags = {f"{python_tags}-{abi_tags}-{tag}" for tag in platform_tags}
    metadata_tags = set(wheel_metadata.get_all("Tag", []))
    if metadata_tags != filename_tags:
        raise SystemExit(f"Filename and WHEEL tags differ in {wheel.name}: {filename_tags} != {metadata_tags}")
    return target


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: verify_release_wheels.py DIST_DIRECTORY RELEASE_VERSION")
    dist = Path(sys.argv[1])
    version = sys.argv[2]
    wheels = sorted(dist.glob("*.whl"))
    if len(wheels) != len(EXPECTED_TARGETS):
        raise SystemExit(f"Expected six release wheels, found {len(wheels)}: {[wheel.name for wheel in wheels]}")

    found = {}
    for wheel in wheels:
        target = validate_wheel(wheel, version)
        if target in found:
            raise SystemExit(f"Two wheels target {target}: {found[target]} and {wheel.name}")
        found[target] = wheel.name

    missing = sorted(EXPECTED_TARGETS - set(found))
    if missing:
        raise SystemExit(f"Missing platform wheels: {missing}")
    print("Validated exact release wheel set:")
    for target in sorted(found):
        print(f"- {target}: {found[target]}")


if __name__ == "__main__":
    main()
