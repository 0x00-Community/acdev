"""Upload a release to the Tencent Cloud COS bucket (the release workflow's upload and latest jobs).

  python scripts/release/cos.py put <version-dir> <dest>      version directory, e.g. pkgs/0.0.9 -> acdert/0.0.9
  python scripts/release/cos.py verify <version-dir> <dest>   every object is there with the local sha256
  python scripts/release/cos.py latest <file> <dest>          latest.json, replaced, Cache-Control: no-cache
  python scripts/release/cos.py selftest                      the rules against an in-memory bucket (no SDK, no network)

The bucket, region and key prefix come from COS_BUCKET, COS_REGION and COS_PREFIX, the credentials from COS_SECRET_ID and
COS_SECRET_KEY (never printed). The bucket is shared: every key is <COS_PREFIX>/<dest>/<file>, nothing outside the prefix
is written. Each object carries its SHA-256 as x-cos-meta-sha256. In a version directory an object that is already there
with the same digest is skipped; one with a different or missing digest is an error and is not overwritten.
"""

import hashlib
import os
import pathlib
import sys

IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"
TEXT = {"LICENSE", "SHA256SUMS"}


class Refused(Exception):
    pass


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def content_type(name: str) -> str:
    if name.endswith(".json"):
        return "application/json"
    if name.endswith(".tar.xz"):
        return "application/x-xz"
    if name.endswith((".tar.gz", ".tgz")):
        return "application/gzip"
    if name in TEXT:
        return "text/plain; charset=utf-8"
    return "application/octet-stream"


def key(prefix: str, dest: str, name: str) -> str:
    prefix = prefix.strip("/")
    parts = [p for p in f"{dest}/{name}".split("/") if p]
    if not prefix or "/" in prefix or prefix in (".", ".."):
        raise Refused(f"COS_PREFIX must be one path segment, not {prefix!r}")
    if not parts or any(p in (".", "..") for p in parts):
        raise Refused(f"refusing the key {dest}/{name}: no empty, . or .. segments")
    return "/".join([prefix, *parts])


def missing(error: Exception) -> bool:
    status = getattr(error, "get_status_code", None)
    return callable(status) and status() == 404


def remote_sha(client, bucket: str, name: str):
    try:
        head = client.head_object(Bucket=bucket, Key=name)
    except Exception as e:
        if missing(e):
            return None
        raise
    return head.get("x-cos-meta-sha256") or ""


def upload(client, bucket: str, path: pathlib.Path, name: str, digest: str, cache: str) -> None:
    client.upload_file(Bucket=bucket, Key=name, LocalFilePath=str(path), PartSize=8, MAXThread=4,
                       ContentType=content_type(path.name), CacheControl=cache, Metadata={"x-cos-meta-sha256": digest})
    back = remote_sha(client, bucket, name)
    if back != digest:
        raise Refused(f"{name}: uploaded, but the bucket reports sha256 {back!r}, not {digest}")


def files(local: str) -> list:
    base = pathlib.Path(local)
    entries = sorted(base.iterdir())
    odd = [p.name for p in entries if not p.is_file() or p.is_symlink()]
    if odd:
        raise Refused(f"{local} must hold only regular files, not {odd}")
    if not entries:
        raise Refused(f"{local} is empty")
    return entries


def put(client, bucket: str, prefix: str, local: str, dest: str) -> None:
    for path in files(local):
        name = key(prefix, dest, path.name)
        digest = sha256(path)
        have = remote_sha(client, bucket, name)
        if have == digest:
            print(f"skip {name}: the same content is already in the bucket")
            continue
        if have is not None:
            raise Refused(f"{name} is in the bucket with sha256 {have or '(none)'}, not {digest}; refusing to overwrite")
        upload(client, bucket, path, name, digest, IMMUTABLE)
        print(f"put {name} {path.stat().st_size}")


def verify(client, bucket: str, prefix: str, local: str, dest: str) -> None:
    for path in files(local):
        name = key(prefix, dest, path.name)
        digest = sha256(path)
        have = remote_sha(client, bucket, name)
        if have != digest:
            raise Refused(f"{name} does not match the local file ({have!r}, not {digest})")
        print(f"ok {name}")


def latest(client, bucket: str, prefix: str, local: str, dest: str) -> None:
    path = pathlib.Path(local)
    if not path.is_file() or path.is_symlink():
        raise Refused(f"{local} is not a regular file")
    name = key(prefix, dest, "")
    upload(client, bucket, path, name, sha256(path), NO_CACHE)
    print(f"put {name} (no-cache)")


def real_client():
    from qcloud_cos import CosConfig, CosS3Client

    config = CosConfig(Region=os.environ["COS_REGION"], SecretId=os.environ["COS_SECRET_ID"],
                       SecretKey=os.environ["COS_SECRET_KEY"], Scheme="https")
    return CosS3Client(config)


class FakeMissing(Exception):
    def get_status_code(self):
        return 404


class FakeBucket:
    def __init__(self):
        self.objects = {}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FakeMissing(Key)
        return dict(self.objects[Key][1])

    def upload_file(self, Bucket, Key, LocalFilePath, ContentType, CacheControl, Metadata, **_):
        headers = {"Content-Type": ContentType, "Cache-Control": CacheControl, **Metadata}
        self.objects[Key] = (pathlib.Path(LocalFilePath).read_bytes(), headers)


def selftest() -> None:
    import tempfile

    def refused(call, text: str) -> None:
        try:
            call()
        except Refused as e:
            assert text in str(e), f"refused for another reason: {e}"
            return
        raise AssertionError(f"not refused: {text}")

    with tempfile.TemporaryDirectory() as work:
        version = pathlib.Path(work, "0.0.0-dry")
        version.mkdir()
        (version / "acdert-x86_64-unknown-linux-gnu.tar.xz").write_bytes(b"binary")
        (version / "SHA256SUMS").write_bytes(b"sums\n")
        bucket = FakeBucket()
        put(bucket, "b", "pkgs", str(version), "acdert/0.0.0-dry")
        keys = sorted(bucket.objects)
        assert keys == ["pkgs/acdert/0.0.0-dry/SHA256SUMS", "pkgs/acdert/0.0.0-dry/acdert-x86_64-unknown-linux-gnu.tar.xz"], keys
        head = bucket.objects["pkgs/acdert/0.0.0-dry/SHA256SUMS"][1]
        assert head["Cache-Control"] == IMMUTABLE and head["Content-Type"].startswith("text/plain"), head
        put(bucket, "b", "pkgs", str(version), "acdert/0.0.0-dry")
        verify(bucket, "b", "pkgs", str(version), "acdert/0.0.0-dry")
        (version / "SHA256SUMS").write_bytes(b"other\n")
        refused(lambda: put(bucket, "b", "pkgs", str(version), "acdert/0.0.0-dry"), "refusing to overwrite")
        refused(lambda: verify(bucket, "b", "pkgs", str(version), "acdert/0.0.0-dry"), "does not match")
        assert bucket.objects["pkgs/acdert/0.0.0-dry/SHA256SUMS"][0] == b"sums\n", "the different object is left as it was"
        bucket.objects["pkgs/acdert/0.0.0-dry/SHA256SUMS"][1].pop("x-cos-meta-sha256")
        refused(lambda: put(bucket, "b", "pkgs", str(version), "acdert/0.0.0-dry"), "(none)")
        refused(lambda: put(bucket, "b", "pkgs", str(version), "../other"), "segments")
        refused(lambda: put(bucket, "b", "", str(version), "acdert/x"), "COS_PREFIX")
        refused(lambda: put(bucket, "b", "a/b", str(version), "acdert/x"), "COS_PREFIX")
        (version / "sub").mkdir()
        refused(lambda: put(bucket, "b", "pkgs", str(version), "acdert/y"), "regular files")
        info = pathlib.Path(work, "latest.json")
        info.write_bytes(b'{"version": "0.0.0-dry"}\n')
        latest(bucket, "b", "pkgs", str(info), "acdert/latest.json")
        info.write_bytes(b'{"version": "0.0.1-dry"}\n')
        latest(bucket, "b", "pkgs", str(info), "acdert/latest.json")
        body, head = bucket.objects["pkgs/acdert/latest.json"]
        assert body == b'{"version": "0.0.1-dry"}\n', "latest.json is replaced"
        assert head["Cache-Control"] == NO_CACHE and head["Content-Type"] == "application/json", head
        assert all(k.startswith("pkgs/") for k in bucket.objects), sorted(bucket.objects)
    print("cos.py rules hold")


def main(argv: list) -> int:
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "selftest":
        selftest()
        return 0
    if cmd not in ("put", "verify", "latest") or len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    bucket, prefix = os.environ["COS_BUCKET"], os.environ["COS_PREFIX"]
    run = {"put": put, "verify": verify, "latest": latest}[cmd]
    try:
        run(real_client(), bucket, prefix, argv[2], argv[3])
    except Refused as e:
        print(f"::error::{e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
