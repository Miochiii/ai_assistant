#!/usr/bin/env python3
"""把 location_test 里的点击记录画成带十字线的图，方便肉眼判断"点偏了没有"。

用法（在项目根目录）：
    .venv/Scripts/python.exe tools/location-test/annotate.py
    .venv/Scripts/python.exe tools/location-test/annotate.py --dir log/location_test

它读 <dir>/events.jsonl，对每条带 shot 的记录，在截图上画两个十字：
    - 蓝：换算后的全局点（按 bounds 反算到图像坐标系）
    - 红圈：图像中心（用来对比"是不是整体偏移"）
输出到 <dir>/annotated/<id>.png，并打印一张每条的坐标摘要表。

不改动原图，不联网。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]


def load_events(directory: Path) -> list[dict]:
    path = directory / 'events.jsonl'
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def draw(record: dict, directory: Path, out_dir: Path) -> str | None:
    shot = record.get('shot')
    if not shot:
        return None
    image_path = directory / shot
    if not image_path.exists():
        return None
    try:
        image = Image.open(image_path).convert('RGB')
    except Exception as error:  # 假图 / 半截图不该让整批失败
        print(f'  跳过 {image_path.name}: {error}')
        return None
    width, height = image.size
    draw = ImageDraw.Draw(image)

    bounds = record.get('screen', {}).get('bounds') or {}
    # 以 hidPosition（0–1000）为准重算：早期日志里的 global 有过单位 bug（当成 0–1 用了）
    hid = record.get('hidPosition') or []
    point = record.get('global') or {}
    if len(hid) == 2 and bounds.get('width') and bounds.get('height'):
        fx = min(max(hid[0] / 1000, 0), 1)
        fy = min(max(hid[1] / 1000, 0), 1)
        point = {
            'x': bounds['x'] + min(fx * bounds['width'], max(0, bounds['width'] - 1)),
            'y': bounds['y'] + min(fy * bounds['height'], max(0, bounds['height'] - 1)),
        }
    # 全局点 -> 图像像素：图像覆盖的是 bounds 这块区域
    px = py = None
    if bounds.get('width') and bounds.get('height') and point:
        px = (point['x'] - bounds['x']) / bounds['width'] * width
        py = (point['y'] - bounds['y']) / bounds['height'] * height

    # 蓝十字：点击点
    if px is not None and py is not None:
        size = 14
        draw.line([(px - size, py), (px + size, py)], fill=(0, 122, 255), width=2)
        draw.line([(px, py - size), (px, py + size)], fill=(0, 122, 255), width=2)
        draw.ellipse([px - 4, py - 4, px + 4, py + 4], outline=(0, 122, 255), width=2)

    # 红圈：图像中心，用来判断"整体偏移"
    cx, cy = width / 2, height / 2
    draw.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], outline=(255, 64, 64), width=2)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{record.get('id', 'unknown')}.png"
    image.save(out_path)
    return str(out_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default=str(ROOT / 'log' / 'location_test'))
    args = parser.parse_args()

    directory = Path(args.dir)
    events = load_events(directory)
    if not events:
        print(f'没有记录：{directory / "events.jsonl"}')
        return 0

    print(f'{"id":34} {"mode":13} {"model":>16} {"global":>16} {"in?":>4} {"raster":>12}')
    annotated = 0
    for record in events:
        screen = record.get('screen') or {}
        model = record.get('modelPosition') or []
        point = record.get('global') or {}
        raster = record.get('raster') or {}
        path = draw(record, directory, directory / 'annotated')
        if path:
            annotated += 1
        print(
            f'{str(record.get("id"))[:34]:34} {str(record.get("mode")):13} '
            f'{str([round(v, 1) for v in model]):>16} '
            f'{"(" + str(point.get("x")) + "," + str(point.get("y")) + ")":>16} '
            f'{str(record.get("insideObservation")):>4} '
            f'{str(raster.get("width")) + "x" + str(raster.get("height")):>12}'
        )
        bounds = screen.get('bounds') or {}
        print(f'    bounds={bounds} scale={screen.get("scale")} windowId={screen.get("windowId")} app={screen.get("appName")}')
    print(f'\n共 {len(events)} 条记录，标注图 {annotated} 张 -> {directory / "annotated"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
