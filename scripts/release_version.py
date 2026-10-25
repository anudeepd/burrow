from __future__ import annotations

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")


def manifest_text(root: Path) -> dict[Path, str]:
    paths = (
        Path("pyproject.toml"),
        Path("Cargo.toml"),
        Path("Cargo.lock"),
        Path("crates/burrow/Cargo.toml"),
    )
    return {path: (root / path).read_text() for path in paths}


def section_value(contents: str, section: str, key: str) -> str:
    header = re.search(rf"(?m)^\[{re.escape(section)}\]\s*$", contents)
    if header is None:
        raise SystemExit(f"Missing TOML section [{section}]")
    section_contents = contents[header.end() :]
    next_header = re.search(r"(?m)^\[", section_contents)
    if next_header is not None:
        section_contents = section_contents[: next_header.start()]
    match = re.search(rf'(?m)^{re.escape(key)}\s*=\s*"([^"]+)"\s*$', section_contents)
    if match is None:
        raise SystemExit(f"Missing quoted {key} in [{section}]")
    return match.group(1)


def synchronized_version(contents: dict[Path, str]) -> str:
    project_text = contents[Path("pyproject.toml")]
    project_name = section_value(project_text, "project", "name")
    project_version = section_value(project_text, "project", "version")
    workspace_version = section_value(contents[Path("Cargo.toml")], "workspace.package", "version")
    lock_entries = re.findall(
        r'(?m)^\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"$',
        contents[Path("Cargo.lock")],
    )
    lock_versions = {
        name: version for name, version in lock_entries if name in {"burrow", "burrow-core"}
    }
    dependency = re.search(
        r'(?m)^burrow-core = \{\s*version = "([^"]+)"',
        contents[Path("crates/burrow/Cargo.toml")],
    )
    if dependency is None:
        raise SystemExit("Missing the path dependency on burrow-core")
    versions = {
        "pyproject.toml": project_version,
        "Cargo.toml workspace": workspace_version,
        "Cargo.lock burrow": lock_versions.get("burrow"),
        "Cargo.lock burrow-core": lock_versions.get("burrow-core"),
        "burrow-core dependency": dependency.group(1),
    }
    if project_name != "yarn-burrow":
        raise SystemExit(f"Expected Python distribution yarn-burrow, got {project_name!r}")
    if not VERSION_RE.fullmatch(project_version):
        raise SystemExit(f"Expected a stable MAJOR.MINOR.PATCH version, got {project_version!r}")
    if (
        len(lock_versions) != 2
        or {name for name, _ in lock_entries} & {"burrow", "burrow-core"} != {"burrow", "burrow-core"}
        or len(set(versions.values())) != 1
    ):
        raise SystemExit(f"Release versions are not synchronized: {versions}")
    return project_version


def next_version(root: Path, bump: str = "patch") -> str:
    major, minor, patch = map(int, synchronized_version(manifest_text(root)).split("."))
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise SystemExit(f"Unsupported version bump: {bump!r}")


def set_version(root: Path, version: str) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit(f"Expected a stable MAJOR.MINOR.PATCH version, got {version!r}")

    contents = manifest_text(root)
    synchronized_version(contents)
    substitutions = {
        Path("pyproject.toml"): (
            re.compile(r'(?m)^(version = ")[^"]+("$)'),
            version,
            1,
        ),
        Path("Cargo.toml"): (
            re.compile(r'(?m)^(version = ")[^"]+("$)'),
            version,
            1,
        ),
        Path("Cargo.lock"): (
            re.compile(r'(?m)^(\[\[package\]\]\nname = "(?:burrow|burrow-core)"\nversion = ")[^"]+("$)'),
            version,
            2,
        ),
        Path("crates/burrow/Cargo.toml"): (
            re.compile(r'(?m)^(burrow-core = \{ version = ")[^"]+(", path = "\.\./burrow-core" \})$'),
            version,
            1,
        ),
    }
    updated: dict[Path, str] = {}
    for path, (pattern, replacement, expected_count) in substitutions.items():
        text, count = pattern.subn(lambda match: f"{match.group(1)}{replacement}{match.group(2)}", contents[path])
        if count != expected_count:
            raise SystemExit(f"Expected {expected_count} version field(s) in {path}, found {count}")
        updated[path] = text

    expected_versions = synchronized_version(updated)
    if expected_versions != version:
        raise SystemExit(f"Version update left inconsistent manifests at {expected_versions!r}")
    for path, text in updated.items():
        (root / path).write_text(text)


def main() -> None:
    parser = argparse.ArgumentParser(description="Read or synchronize Burrow's release version.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("current", help="print the synchronized current version")
    next_command = commands.add_parser("next", help="print the next version for a selected bump")
    next_command.add_argument("--bump", choices=("patch", "minor", "major"), default="patch")
    set_command = commands.add_parser("set", help="set the synchronized version in all manifests")
    set_command.add_argument("version")
    args = parser.parse_args()

    if args.command == "current":
        print(synchronized_version(manifest_text(ROOT)))
    elif args.command == "next":
        print(next_version(ROOT, args.bump))
    else:
        set_version(ROOT, args.version)
        print(f"Synchronized release manifests to {args.version}")


if __name__ == "__main__":
    main()
