import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


def write(path, value):
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temp, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel-dir", required=True)
    parser.add_argument("--exclude-capture", action="store_true")
    parser.add_argument("--no-sound", action="store_true")
    args = parser.parse_args()
    root = Path(args.channel_dir)
    instance = json.loads((root / "instance.json").read_text(encoding="utf-8"))
    write(root / "ui-ready.json", {
        "assistant_session_id": instance["assistant_session_id"],
        "pid": os.getpid(),
        "at": datetime.now(timezone.utc).isoformat(),
    })
    while True:
        write(root / "ui-heartbeat.json", {
            "assistant_session_id": instance["assistant_session_id"],
            "pid": os.getpid(),
            "at": datetime.now(timezone.utc).isoformat(),
        })
        time.sleep(0.2)


if __name__ == "__main__":
    main()
