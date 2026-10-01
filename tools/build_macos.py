#!/usr/bin/env python3
"""Build a universal macOS .app and a ZIP preserving its Unix permissions.

Requires Go 1.26+ and Python 3.9+ on the build machine; no macOS SDK is needed.
Usage: python tools/build_macos.py 2.19.1
"""

import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXECUTABLE = "antigravity-cn"
COMMAND = "双击运行中文汉化工具.command"


def universal_binary(slices):
    """Assemble FAT_MAGIC with independently linked, 16 KiB aligned slices."""
    alignment = 14
    offset = 1 << alignment
    entries = []
    bodies = []
    for cpu, subtype, content in slices:
        magic, actual_cpu, actual_subtype = struct.unpack_from("<III", content)
        if (magic, actual_cpu, actual_subtype) != (0xFEEDFACF, cpu, subtype):
            raise ValueError("Unexpected Mach-O architecture")
        entries.append(struct.pack(">IIIII", cpu, subtype, offset, len(content), alignment))
        bodies.append((offset, content))
        offset = (offset + len(content) + (1 << alignment) - 1) & ~((1 << alignment) - 1)
    result = bytearray(struct.pack(">II", 0xCAFEBABE, len(slices)) + b"".join(entries))
    for offset, content in bodies:
        result.extend(bytes(offset - len(result)))
        result.extend(content)
    return bytes(result)


def build(version):
    (ROOT / "temp").mkdir(exist_ok=True)
    release = ROOT / "release"
    release.mkdir(exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="macos-build-", dir=ROOT / "temp"))
    app = stage / f"v{version}.app"
    contents = app / "Contents"
    binary = contents / "MacOS" / EXECUTABLE
    payload = contents / "Resources" / "payload"
    binary.parent.mkdir(parents=True)
    payload.mkdir(parents=True)

    slices = []
    for arch, cpu, subtype in (("amd64", 0x01000007, 3), ("arm64", 0x0100000C, 0)):
        print(f"Building macOS {arch} launcher...", flush=True)
        output = stage / f"launcher-{arch}"
        env = dict(os.environ, GOOS="darwin", GOARCH=arch, CGO_ENABLED="0", GOAMD64="v1")
        subprocess.run([
            "go", "build", "-trimpath", "-ldflags=-s -w -buildid=",
            "-o", str(output), str(ROOT / "tools" / "macos_launcher.go"),
        ], check=True, cwd=ROOT, env=env)
        slices.append((cpu, subtype, output.read_bytes()))
    binary.write_bytes(universal_binary(slices))
    binary.chmod(0o755)

    files = ["dictionary.js", "localization_engine.js", "terminology.js", "LICENSE", COMMAND,
             "locales/zh-CN.json", "tools/localize_vscode_extension.js", "tools/localize_both.js"]
    for directory in ("dicts_src", "src_layer"):
        files.extend(p.relative_to(ROOT).as_posix() for p in sorted((ROOT / directory).rglob("*")) if p.is_file())
    for relative in files:
        source = ROOT / relative
        if source.is_symlink():
            raise ValueError(f"Payload cannot contain symbolic links: {source}")
        destination = payload / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = source.read_bytes()
        if relative == COMMAND:
            data = data.removeprefix(b"\xef\xbb\xbf").replace(b"\r\n", b"\n")
        destination.write_bytes(data)
        destination.chmod(0o755 if relative == COMMAND else 0o644)

    metadata = {
        "CFBundleName": f"v{version}",
        "CFBundleDisplayName": f"v{version}",
        "CFBundleIdentifier": "io.github.yuanhhs.antigravity-chinese",
        "CFBundleExecutable": EXECUTABLE,
        "CFBundlePackageType": "APPL",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "LSMinimumSystemVersion": "12.0",
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
    }
    (contents / "Info.plist").write_bytes(plistlib.dumps(metadata, sort_keys=False))
    (contents / "PkgInfo").write_bytes(b"APPL????")
    instructions = (ROOT / "docs" / "macos-app.md").read_bytes()
    (contents / "Resources" / "使用说明.md").write_bytes(instructions)

    archive_path = release / f"v{version}.app.zip"
    staged_zip = stage / archive_path.name
    with zipfile.ZipFile(staged_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in [app, *sorted(app.rglob("*"))]:
            name = source.relative_to(stage).as_posix()
            is_dir = source.is_dir()
            info = zipfile.ZipInfo(name + ("/" if is_dir else ""))
            info.create_system = 3
            executable = source == binary or source == payload / COMMAND
            mode = (stat.S_IFDIR | 0o755) if is_dir else (stat.S_IFREG | (0o755 if executable else 0o644))
            info.external_attr = (mode << 16) | (0x10 if is_dir else 0)
            archive.writestr(info, b"" if is_dir else source.read_bytes(),
                             compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        archive.writestr("使用说明.md", instructions)
    with zipfile.ZipFile(staged_zip) as archive:
        if archive.testzip() is not None:
            raise ValueError("ZIP integrity check failed")
    shutil.copyfile(staged_zip, archive_path)
    app_output = release / app.name
    if app_output.is_symlink():
        raise ValueError("App output cannot be a symbolic link")
    shutil.copytree(app, app_output, dirs_exist_ok=True)
    print(f"App: {app_output}")
    print(f"ZIP: {archive_path} ({archive_path.stat().st_size / 1048576:.2f} MiB)")
    print(f"SHA256: {hashlib.sha256(archive_path.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="Antigravity version, e.g. 2.19.1")
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        parser.error("version must have the form major.minor.patch")
    build(args.version)
