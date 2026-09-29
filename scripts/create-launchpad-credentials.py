#!/usr/bin/env python3
"""Create a private Launchpad OAuth credential file for PPA recovery."""

from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from pathlib import Path

from launchpadlib.credentials import Credentials
from launchpadlib.launchpad import Launchpad


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="New file path for the private Launchpad credentials",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = args.output.expanduser()
    if output.exists():
        print(f"Refusing to overwrite existing credentials file: {output}", file=sys.stderr)
        return 1

    credentials = Credentials("launchpad-library")
    authorization_url = credentials.get_request_token(
        context="seerrng-ppa-recovery",
        web_root="production",
    )
    print("Authorize SeerrNG's PPA recovery client in Launchpad.")
    print("Grant the account change access required to retry PPA builds.")
    print(f"Authorization page: {authorization_url}")
    webbrowser.open(authorization_url)
    input("After approving the request in your browser, press Enter here: ")

    credentials.exchange_request_token_for_access_token()
    launchpad = Launchpad(
        credentials=credentials,
        service_root="production",
        version="devel",
    )
    _ = launchpad.me

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as credentials_file:
            credentials.save(credentials_file)
    except Exception:
        output.unlink(missing_ok=True)
        raise

    print(f"Saved Launchpad credentials with mode 0600 to {output}.")
    print("Do not commit this file or paste its contents into chat.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Launchpad authorization cancelled.", file=sys.stderr)
        raise SystemExit(130)
