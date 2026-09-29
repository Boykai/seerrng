#!/usr/bin/env python3
"""Build, upload, and verify a PPA package with bounded race recovery.

The only write credential required by this workflow is the existing GPG upload
key. Launchpad status is read anonymously. If the known source-publication race
occurs, this script republishes the same payload with a fresh, higher package
version, up to the configured limit.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


MAX_ATTEMPTS = 3
KNOWN_RACE_EXIT_CODE = 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--upstream-version", required=True)
    parser.add_argument("--series", choices=("jammy", "noble"), required=True)
    parser.add_argument("--archive-url", required=True)
    parser.add_argument("--archive-web", required=True)
    parser.add_argument("--gpg-key-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--timeout-minutes", type=int, default=300)
    parser.add_argument("--max-attempts", type=int, default=MAX_ATTEMPTS)
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> Path:
    if not re.fullmatch(r"v[0-9][0-9A-Za-z._+-]{0,127}", args.tag):
        raise ValueError(f"Invalid release tag: {args.tag}")
    if "-" in args.tag:
        raise ValueError(f"Stable PPA publishing rejects pre-release tags: {args.tag}")
    if args.tag[1:] != args.upstream_version:
        raise ValueError("Release tag and upstream version do not match.")
    if not re.fullmatch(r"[A-Fa-f0-9]{40,64}", args.gpg_key_id):
        raise ValueError("--gpg-key-id must be a GPG key fingerprint.")
    if not re.fullmatch(r"[0-9]+", args.run_id) or not re.fullmatch(
        r"[0-9]+", args.run_attempt
    ):
        raise ValueError("GitHub run ID and attempt must be numeric.")
    if args.timeout_minutes < 1:
        raise ValueError("--timeout-minutes must be positive.")
    if args.max_attempts < 1 or args.max_attempts > MAX_ATTEMPTS:
        raise ValueError(f"--max-attempts must be between 1 and {MAX_ATTEMPTS}.")

    package_dir = args.package_dir.resolve()
    if not package_dir.is_dir():
        raise ValueError(f"Package source directory does not exist: {package_dir}")
    if not (package_dir / "debian" / "source" / "format").is_file():
        raise ValueError(f"Missing Debian source format in {package_dir}.")
    return package_dir


def package_version(args: argparse.Namespace, attempt: int) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return (
        f"{args.upstream_version}+ppa{timestamp}"
        f".r{int(args.run_id):020d}"
        f".a{int(args.run_attempt):04d}"
        f".n{attempt:02d}~{args.series}"
    )


def write_changelog(package_dir: Path, args: argparse.Namespace, version: str) -> None:
    date = datetime.now(timezone.utc).astimezone().strftime("%a, %d %b %Y %H:%M:%S %z")
    changelog = (
        f"seerrng ({version}) {args.series}; urgency=medium\n\n"
        f"  * Release {args.tag}.\n\n"
        f" -- snapetech <seerrng@proton.me>  {date}\n"
    )
    (package_dir / "debian" / "changelog").write_text(changelog, encoding="utf-8")


def run_attempt(
    source_dir: Path,
    attempt_dir: Path,
    args: argparse.Namespace,
    version: str,
    deadline: float,
) -> int:
    package_dir = attempt_dir / source_dir.name
    shutil.copytree(source_dir, package_dir, symlinks=True)
    write_changelog(package_dir, args, version)

    print(f"Building signed source package {version}.", flush=True)
    subprocess.run(
        ["debuild", "-S", "-sa", f"-k{args.gpg_key_id}"],
        cwd=package_dir,
        check=True,
    )

    changes_files = sorted(attempt_dir.glob("*.changes"))
    if len(changes_files) != 1:
        raise RuntimeError(
            f"Expected one .changes file after building {version}, found "
            f"{len(changes_files)}."
        )

    print(f"Uploading {changes_files[0].name} to {args.archive_web}.", flush=True)
    subprocess.run(
        ["dput", "-f", "seerrng-ppa", str(changes_files[0])],
        cwd=attempt_dir,
        check=True,
    )

    remaining_seconds = deadline - time.monotonic()
    if remaining_seconds < 60:
        raise TimeoutError("The PPA publication deadline expired after upload.")
    remaining_minutes = max(1, int(remaining_seconds // 60))
    waiter = Path(__file__).with_name("wait-for-launchpad-ppa.py")
    result = subprocess.run(
        [
            sys.executable,
            str(waiter),
            "--archive-url",
            args.archive_url,
            "--archive-web",
            args.archive_web,
            "--series",
            args.series,
            "--source-version",
            version,
            "--timeout-minutes",
            str(remaining_minutes),
        ],
        check=False,
    )
    return result.returncode


def main() -> int:
    args = parse_args()
    try:
        source_dir = validate_args(args)
        deadline = time.monotonic() + args.timeout_minutes * 60
        with tempfile.TemporaryDirectory(prefix="seerrng-ppa-") as temporary_root:
            root = Path(temporary_root)
            for attempt in range(1, args.max_attempts + 1):
                if time.monotonic() >= deadline:
                    raise TimeoutError("The PPA publication deadline expired.")
                version = package_version(args, attempt)
                attempt_dir = root / f"attempt-{attempt}"
                attempt_dir.mkdir()
                try:
                    status = run_attempt(
                        source_dir,
                        attempt_dir,
                        args,
                        version,
                        deadline,
                    )
                except subprocess.CalledProcessError as error:
                    raise RuntimeError(
                        "PPA build/upload command failed with exit status "
                        f"{error.returncode}."
                    ) from error

                if status == 0:
                    print(
                        f"PPA publication completed for {args.tag} ({args.series}) "
                        f"as {version}.",
                        flush=True,
                    )
                    return 0
                if status != KNOWN_RACE_EXIT_CODE:
                    raise RuntimeError(
                        f"Launchpad monitoring failed with exit status {status}; "
                        "see the preceding diagnostic."
                    )
                if attempt == args.max_attempts:
                    raise RuntimeError(
                        f"Launchpad hit the known source-publication race on all "
                        f"{args.max_attempts} package versions."
                    )
                print(
                    f"Known Launchpad source-publication race on attempt {attempt}; "
                    "retrying the same payload with a fresh package version.",
                    flush=True,
                )

        raise RuntimeError("PPA publication did not complete.")
    except Exception as error:
        print(f"PPA publication failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
