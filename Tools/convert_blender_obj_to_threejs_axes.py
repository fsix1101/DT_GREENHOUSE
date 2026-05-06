from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TransformResult:
    vertex_count: int
    normal_count: int


def _format_float(value: float) -> str:
    if abs(value) < 1e-12:
        return "0"
    s = f"{value:.8f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def _transform_xyz_blender_zup_to_three_yup(x: float, y: float, z: float) -> tuple[float, float, float]:
    return (x, z, -y)


def transform_obj_text_blender_to_three(text: str) -> tuple[str, TransformResult]:
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    vertex_count = 0
    normal_count = 0

    for line in lines:
        stripped_nl = line.rstrip("\r\n")
        nl = line[len(stripped_nl) :]
        leading = stripped_nl[: len(stripped_nl) - len(stripped_nl.lstrip(" \t"))]
        body = stripped_nl[len(leading) :]

        if body.startswith("v "):
            parts = body.split()
            if len(parts) >= 4:
                x, y, z = (float(parts[1]), float(parts[2]), float(parts[3]))
                x2, y2, z2 = _transform_xyz_blender_zup_to_three_yup(x, y, z)
                rest = parts[4:]
                nums = [_format_float(x2), _format_float(y2), _format_float(z2)]
                if rest:
                    nums.extend(rest)
                out.append(f"{leading}v {' '.join(nums)}{nl}")
                vertex_count += 1
                continue

        if body.startswith("vn "):
            parts = body.split()
            if len(parts) >= 4:
                x, y, z = (float(parts[1]), float(parts[2]), float(parts[3]))
                x2, y2, z2 = _transform_xyz_blender_zup_to_three_yup(x, y, z)
                rest = parts[4:]
                nums = [_format_float(x2), _format_float(y2), _format_float(z2)]
                if rest:
                    nums.extend(rest)
                out.append(f"{leading}vn {' '.join(nums)}{nl}")
                normal_count += 1
                continue

        out.append(line)

    return ("".join(out), TransformResult(vertex_count=vertex_count, normal_count=normal_count))


def _iter_obj_files(root: Path) -> list[Path]:
    return sorted([p for p in root.rglob("*.obj") if p.is_file()])


def _read_text_preserve_bytes(path: Path) -> str:
    return path.read_bytes().decode("utf-8", errors="surrogateescape")


def _write_text_preserve_bytes(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8", errors="surrogateescape"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        default=r"d:\Code\Agti_sub\src\models",
        help="OBJ 模型根目录（递归查找 *.obj）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只统计与预览，不写回文件",
    )
    parser.add_argument(
        "--backup-suffix",
        default=".bak",
        help="写回前创建备份文件的后缀（空字符串表示不备份）",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="最多处理多少个文件（0 表示不限）",
    )
    args = parser.parse_args()

    root = Path(args.root)
    if not root.exists():
        raise SystemExit(f"root 不存在: {root}")

    obj_files = _iter_obj_files(root)
    if args.limit and args.limit > 0:
        obj_files = obj_files[: args.limit]

    total_vertices = 0
    total_normals = 0
    changed_files = 0

    for obj_path in obj_files:
        original = _read_text_preserve_bytes(obj_path)
        transformed, result = transform_obj_text_blender_to_three(original)
        total_vertices += result.vertex_count
        total_normals += result.normal_count

        if transformed == original:
            continue

        changed_files += 1
        if args.dry_run:
            continue

        if args.backup_suffix:
            backup_path = obj_path.with_suffix(obj_path.suffix + args.backup_suffix)
            if not backup_path.exists():
                backup_path.write_bytes(obj_path.read_bytes())

        _write_text_preserve_bytes(obj_path, transformed)

    print(
        f"扫描 OBJ: {len(obj_files)} 个；实际变更: {changed_files} 个；"
        f"处理 v: {total_vertices} 行；处理 vn: {total_normals} 行"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

