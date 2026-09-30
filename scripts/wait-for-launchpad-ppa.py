#!/usr/bin/env python3
"""Wait for a PPA source and binary publication using Launchpad's public API.

Exit status 2 means a fresh source version is needed to recover from the known
publication race or a stalled binary upload.
"""

from __future__ import annotations

import argparse
import gzip
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.request import urlopen

from launchpadlib.launchpad import Launchpad


POLL_INTERVAL_SECONDS = 60
STALE_UPLOAD_TIMEOUT = timedelta(minutes=45)
PUBLISHED = "Published"


class FreshUploadRequired(RuntimeError):
    """Launchpad needs a fresh source version to recover the PPA build."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive-url", required=True)
    parser.add_argument("--archive-web", required=True)
    parser.add_argument("--series", choices=("jammy", "noble"), required=True)
    parser.add_argument("--source-version", required=True)
    parser.add_argument("--timeout-minutes", type=int, default=150)
    return parser.parse_args()


def create_launchpad_client() -> Launchpad:
    # This client is deliberately anonymous and read-only. Upload authorization
    # continues to come from the GPG-signed source package and PPA permissions.
    return Launchpad.login_anonymously(
        "seerrng-ppa-monitor",
        service_root="production",
        version="1.0",
    )


def matching_source_publications(
    archive: Any, series: Any, source_version: str
) -> list[Any]:
    return list(
        archive.getPublishedSources(
            source_name="seerrng",
            version=source_version,
            distro_series=series,
            exact_match=True,
            pocket="Release",
        )
    )


def get_builds(source_publication: Any) -> list[Any]:
    return list(source_publication.getBuilds())


def published_package_binaries(source_publication: Any) -> list[Any]:
    return [
        binary
        for binary in source_publication.getPublishedBinaries()
        if binary.binary_package_name == "seerrng" and binary.status == PUBLISHED
    ]


def classify_failed_upload(
    build: Any,
    archive_web: str,
    source_version: str,
    series: str,
) -> None:
    upload_log_url = build.upload_log_url
    if not upload_log_url:
        raise RuntimeError(
            f"Launchpad marked {build.web_link} as 'Failed to upload' without an "
            "upload log; refusing to republish an unclassified failure."
        )

    with urlopen(upload_log_url, timeout=30) as response:
        upload_log = response.read()
    if upload_log_url.endswith(".gz"):
        upload_log = gzip.decompress(upload_log)
    upload_log_text = upload_log.decode("utf-8", errors="replace")
    expected_error = (
        f"Unable to find source publication seerrng/{source_version} in {series}"
    )
    if expected_error not in upload_log_text:
        raise RuntimeError(
            f"Launchpad marked {build.web_link} as 'Failed to upload', but its log "
            "does not match the known source-publication race. "
            f"Inspect {upload_log_url}."
        )

    raise FreshUploadRequired(
        f"Launchpad rejected the binary for {source_version} before its source "
        f"publication was available. A fresh signed source version can be uploaded "
        f"to {archive_web}. Build log: {upload_log_url}"
    )


def classify_stalled_upload(build: Any, source_version: str, archive_web: str) -> None:
    if build.buildstate != "Uploading build" or not build.datebuilt:
        return

    build_finished = build.datebuilt
    if not isinstance(build_finished, datetime):
        build_finished = datetime.fromisoformat(
            str(build_finished).replace("Z", "+00:00")
        )
    if build_finished.tzinfo is None:
        build_finished = build_finished.replace(tzinfo=timezone.utc)

    stalled_for = datetime.now(timezone.utc) - build_finished.astimezone(timezone.utc)
    if stalled_for < STALE_UPLOAD_TIMEOUT:
        return

    minutes = int(stalled_for.total_seconds() // 60)
    raise FreshUploadRequired(
        f"Launchpad built {source_version} but left {build.web_link} in "
        f"'Uploading build' for {minutes} minutes without publishing a binary. "
        f"Republishing a fresh signed source version to {archive_web}."
    )


def fail_for_build(build: Any) -> None:
    state = build.buildstate
    log_url = build.upload_log_url or build.build_log_url or build.web_link
    raise RuntimeError(
        f"Launchpad build {build.web_link} ended in '{state}'. Inspect {log_url}."
    )


def main() -> int:
    args = parse_args()
    if args.timeout_minutes < 1:
        print("--timeout-minutes must be positive.", file=sys.stderr)
        return 1

    try:
        launchpad = create_launchpad_client()
        archive = launchpad.load(args.archive_url)
        distribution = launchpad.distributions["ubuntu"]
        series = distribution.getSeries(name_or_version=args.series)
    except Exception as error:
        print(
            f"Unable to read public Launchpad publication data: {error}",
            file=sys.stderr,
        )
        return 1

    deadline = time.monotonic() + args.timeout_minutes * 60
    last_report = ""

    while time.monotonic() < deadline:
        try:
            publications = matching_source_publications(
                archive, series, args.source_version
            )
            if not publications:
                report = (
                    f"Waiting for {args.source_version} source publication in "
                    f"{args.series} ({args.archive_web})."
                )
            else:
                publication = max(publications, key=lambda item: item.date_created)
                publication_status = publication.status
                builds = get_builds(publication)
                amd64_builds = [
                    build for build in builds if build.arch_tag == "amd64"
                ]

                for build in amd64_builds:
                    if build.buildstate == "Failed to upload":
                        classify_failed_upload(
                            build,
                            args.archive_web,
                            args.source_version,
                            args.series,
                        )
                    if build.buildstate in (
                        "Failed to build",
                        "Build for superseded Source",
                        "Cancelled build",
                    ):
                        fail_for_build(build)
                    classify_stalled_upload(
                        build,
                        args.source_version,
                        args.archive_web,
                    )

                if publication_status != PUBLISHED:
                    if publication_status in ("Superseded", "Deleted", "Obsolete"):
                        raise RuntimeError(
                            f"Launchpad source publication {publication.self_link} "
                            f"ended in '{publication_status}'."
                        )
                    build_states = ", ".join(
                        build.buildstate for build in amd64_builds
                    ) or "no build records"
                    report = (
                        f"Waiting for source publication {publication.self_link} "
                        f"to become Published (currently {publication_status}; "
                        f"builds [{build_states}])."
                    )
                else:
                    if not amd64_builds:
                        raise RuntimeError(
                            f"No amd64 build record exists for {publication.self_link}."
                        )

                    completed = all(
                        build.buildstate == "Successfully built"
                        for build in amd64_builds
                    )
                    binaries = published_package_binaries(publication)
                    if completed and binaries:
                        print(
                            f"Published {args.source_version} for {args.series}: "
                            f"{publication.self_link}",
                            flush=True,
                        )
                        for binary in binaries:
                            print(f"Published binary: {binary.web_link}", flush=True)
                        return 0

                    states = ", ".join(
                        f"{build.arch_tag}={build.buildstate}" for build in amd64_builds
                    )
                    binary_states = ", ".join(
                        f"{binary.binary_package_name}={binary.status}"
                        for binary in publication.getPublishedBinaries()
                    ) or "no binary publication records"
                    report = (
                        f"Waiting for binary publication in {args.series}: "
                        f"builds [{states}], binaries [{binary_states}]."
                    )

            if report != last_report:
                print(report, flush=True)
                last_report = report
        except FreshUploadRequired as error:
            print(error, file=sys.stderr)
            return 2
        except Exception as error:
            print(f"Launchpad publication check failed: {error}", file=sys.stderr)
            return 1

        time.sleep(POLL_INTERVAL_SECONDS)

    print(
        f"Timed out waiting for {args.source_version} and its published binary "
        f"in {args.series}. Check {args.archive_web}.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
