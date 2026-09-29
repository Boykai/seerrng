#!/usr/bin/env python3
"""Wait for a PPA source and its binaries, retrying Launchpad's upload race."""

from __future__ import annotations

import argparse
import gzip
import io
import os
import sys
import time
from typing import Any
from urllib.request import urlopen

from launchpadlib.credentials import Credentials
from launchpadlib.launchpad import Launchpad


POLL_INTERVAL_SECONDS = 60
MAX_UPLOAD_RETRIES = 2
PUBLISHED = "Published"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive-url", required=True)
    parser.add_argument("--archive-web", required=True)
    parser.add_argument("--series", choices=("jammy", "noble"), required=True)
    parser.add_argument("--source-version", required=True)
    parser.add_argument("--timeout-minutes", type=int, default=150)
    return parser.parse_args()


def create_launchpad_client() -> Launchpad:
    credential_text = os.environ.get("LAUNCHPAD_CREDENTIALS", "")
    if not credential_text:
        raise RuntimeError(
            "LAUNCHPAD_CREDENTIALS is required so failed binary uploads can be retried."
        )

    credentials = Credentials()
    credentials.load(io.StringIO(credential_text))
    return Launchpad(
        credentials=credentials,
        service_root="production",
        version="devel",
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
        if binary.binary_package_name == "seerrng"
        and binary.status == PUBLISHED
    ]


def retry_failed_upload(
    launchpad: Launchpad,
    build: Any,
    retry_counts: dict[str, int],
    archive_web: str,
    source_version: str,
    series: str,
) -> bool:
    build_url = build.web_link
    upload_log_url = build.upload_log_url
    if not upload_log_url:
        raise RuntimeError(
            f"Launchpad marked {build_url} as 'Failed to upload' without an upload "
            "log; refusing to retry an unclassified failure."
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
            f"Launchpad marked {build_url} as 'Failed to upload', but its log does "
            f"not match the known source-publication race. Inspect {upload_log_url}."
        )

    retries = retry_counts.get(build_url, 0)
    if retries >= MAX_UPLOAD_RETRIES:
        raise RuntimeError(
            f"Launchpad rejected the binary upload {retries} times; "
            f"inspect {build.upload_log_url or build_url} and retry manually."
        )

    authenticated_build = launchpad.load(build.self_link)
    if not authenticated_build.can_be_retried:
        raise RuntimeError(
            "Launchpad marked the failed upload as non-retryable. "
            f"Inspect {build.upload_log_url or build_url}."
        )

    authenticated_build.retry()
    retry_counts[build_url] = retries + 1
    print(
        f"Launchpad rejected a binary before source publication. Retried build "
        f"{build_url} ({retry_counts[build_url]}/{MAX_UPLOAD_RETRIES}); "
        f"archive: {archive_web}",
        flush=True,
    )
    return True


def fail_for_build(build: Any) -> None:
    state = build.buildstate
    log_url = build.upload_log_url or build.build_log_url or build.web_link
    raise RuntimeError(
        f"Launchpad build {build.web_link} ended in '{state}'. Inspect {log_url}."
    )


def main() -> int:
    args = parse_args()
    try:
        launchpad = create_launchpad_client()
        archive = launchpad.load(args.archive_url)
        distribution = launchpad.distributions["ubuntu"]
        series = distribution.getSeries(name_or_version=args.series)
    except Exception as error:
        print(f"Unable to authenticate to or load Launchpad: {error}", file=sys.stderr)
        return 1

    deadline = time.monotonic() + args.timeout_minutes * 60
    retry_counts: dict[str, int] = {}
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
                if publication_status != PUBLISHED:
                    if publication_status in ("Superseded", "Deleted", "Obsolete"):
                        raise RuntimeError(
                            f"Launchpad source publication {publication.self_link} "
                            f"ended in '{publication_status}'."
                        )
                    report = (
                        f"Waiting for source publication {publication.self_link} "
                        f"to become Published (currently {publication_status})."
                    )
                else:
                    builds = get_builds(publication)
                    amd64_builds = [build for build in builds if build.arch_tag == "amd64"]
                    if not amd64_builds:
                        raise RuntimeError(
                            f"No amd64 build record exists for {publication.self_link}."
                        )

                    retry_started = False
                    for build in amd64_builds:
                        if build.buildstate == "Failed to upload":
                            retry_started = retry_failed_upload(
                                launchpad,
                                build,
                                retry_counts,
                                args.archive_web,
                                args.source_version,
                                args.series,
                            )
                            break
                        if build.buildstate in (
                            "Failed to build",
                            "Build for superseded Source",
                            "Cancelled build",
                        ):
                            fail_for_build(build)

                    if retry_started:
                        report = "Waiting for retried Launchpad build to finish."
                    else:
                        completed = all(
                            build.buildstate == "Successfully built"
                            for build in amd64_builds
                        )
                        binaries = published_package_binaries(publication)
                        if completed and binaries:
                            print(
                                f"Published {args.source_version} for {args.series}: "
                                f"{publication.web_link}",
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
