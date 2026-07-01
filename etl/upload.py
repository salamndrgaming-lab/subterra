"""
Upload ETL artifacts (pmtiles + manifest) to Cloudflare R2 via the
S3-compatible API.

We use this instead of `wrangler r2 object put` because wrangler caps
single-shot uploads at 300 MiB — our pmtiles will routinely exceed that
once all data layers are included. boto3's upload_file() automatically
multiparts files above 8 MiB and parallelizes the parts, so a 1 GB
pmtiles uploads in a few minutes regardless of size.

Requires three env vars in GitHub Actions:
  CLOUDFLARE_ACCOUNT_ID  — your CF account id (already a secret)
  R2_ACCESS_KEY_ID       — new: from CF dashboard → R2 → API Tokens
  R2_SECRET_ACCESS_KEY   — new: paired secret created with the token
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import boto3
from botocore.config import Config

BUCKET = "subterra-tiles"
OUT = Path(__file__).resolve().parent / "out"


def _env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        print(f"::error::missing env var {name}", file=sys.stderr)
        sys.exit(2)
    return v


def make_client() -> "boto3.client":
    account_id = _env("CLOUDFLARE_ACCOUNT_ID")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(
            retries={"max_attempts": 5, "mode": "adaptive"},
            connect_timeout=30,
            read_timeout=300,
        ),
    )


def upload(client, local_path: Path, key: str, content_type: str | None = None) -> None:
    size_mb = local_path.stat().st_size / 1e6
    print(f"uploading {local_path.name} ({size_mb:.1f} MB) → s3://{BUCKET}/{key}")
    extra: dict[str, str] = {}
    if content_type:
        extra["ContentType"] = content_type
    client.upload_file(str(local_path), BUCKET, key, ExtraArgs=extra)
    print(f"  done")


def main() -> int:
    if not OUT.exists():
        print(f"::error::output directory {OUT} doesn't exist — did the ETL run?", file=sys.stderr)
        return 1

    pmtiles = OUT / "subterra.pmtiles"
    manifest = OUT / "manifest.json"
    if not pmtiles.exists() or not manifest.exists():
        print("::error::expected etl/out/subterra.pmtiles + manifest.json", file=sys.stderr)
        return 1

    client = make_client()
    upload(client, pmtiles, "tiles/subterra.pmtiles", "application/octet-stream")
    upload(client, manifest, "manifest.json", "application/json")

    # features.db is optional — it's built by etl/build_features.py when
    # tippecanoe runs, but a verification run (--skip-tippecanoe) or a
    # build failure leaves it absent. Upload it only when present so the
    # Worker's /features route serves fresh data; skip silently otherwise.
    features_db = OUT / "subterra-features.db"
    if features_db.exists():
        upload(client, features_db, "features/subterra-features.db", "application/vnd.sqlite3")
    else:
        print("note: no subterra-features.db to upload (skip-tippecanoe or build skipped)")

    print("--- verifying remote bucket (HEAD + first 400 bytes of manifest) ---")
    obj = client.head_object(Bucket=BUCKET, Key="tiles/subterra.pmtiles")
    print(f"  pmtiles: {obj['ContentLength'] / 1e6:.1f} MB, etag={obj['ETag']}")
    obj = client.get_object(Bucket=BUCKET, Key="manifest.json")
    print(obj["Body"].read(400).decode("utf-8", errors="replace"))
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
