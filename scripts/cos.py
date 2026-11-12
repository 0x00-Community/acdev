import hashlib
import os
import pathlib
import sys

from qcloud_cos import CosConfig, CosS3Client
from qcloud_cos.cos_exception import CosServiceError

USAGE = """usage: python scripts/cos.py once <file> <key> <content-type> <cache-control>
       python scripts/cos.py pointer <file> <key> <content-type> <cache-control>

<key> is under COS_PREFIX (pkgs/<key>). once: a key that exists with the same sha256 is skipped, with another
one the run fails, nothing is overwritten. pointer: always written (install.*, latest, latest.json).
Every object carries x-cos-meta-sha256 and is read back with a HEAD before the next one.
Environment: COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, COS_PREFIX."""


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"cos: {name} is not set")
    return value


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def full_key(prefix: str, key: str) -> str:
    parts = key.split("/")
    if key.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise SystemExit(f"cos: {key}: not a plain relative key")
    return f"{prefix.strip('/')}/{key}"


def remote(client: CosS3Client, bucket: str, key: str) -> dict[str, str] | None:
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except CosServiceError as error:
        if error.get_status_code() == 404:
            return None
        raise


def main(argv: list[str]) -> None:
    if len(argv) != 5 or argv[0] not in ("once", "pointer"):
        raise SystemExit(USAGE)
    mode, local, key, kind, cache = argv
    path = pathlib.Path(local)
    if not path.is_file():
        raise SystemExit(f"cos: {local}: no such file")
    prefix = env("COS_PREFIX")
    if prefix.strip("/") != "pkgs":
        raise SystemExit(f"cos: COS_PREFIX is {prefix}: this release writes only under pkgs/")
    config = CosConfig(Region=env("COS_REGION"), SecretId=env("COS_SECRET_ID"), SecretKey=env("COS_SECRET_KEY"),
                       Scheme="https")
    client = CosS3Client(config)
    bucket = env("COS_BUCKET")
    name = full_key(prefix, key)
    digest = sha256(path)
    size = path.stat().st_size
    if mode == "once":
        head = remote(client, bucket, name)
        if head is not None:
            have = head.get("x-cos-meta-sha256")
            if have == digest:
                print(f"already published, identical: {name}")
                return
            raise SystemExit(f"cos: {name} is already published with sha256 {have}, not {digest}: "
                             "a version is never overwritten")
    with path.open("rb") as body:
        client.put_object(Bucket=bucket, Body=body, Key=name, ContentType=kind, CacheControl=cache,
                          Metadata={"x-cos-meta-sha256": digest})
    head = remote(client, bucket, name)
    if head is None or head.get("x-cos-meta-sha256") != digest or int(head.get("Content-Length", -1)) != size:
        raise SystemExit(f"cos: {name} does not read back as uploaded")
    print(f"put {name} {size} {digest}")


if __name__ == "__main__":
    main(sys.argv[1:])
