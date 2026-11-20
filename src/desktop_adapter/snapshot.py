"""Bounded tree collection independent of the Windows backend."""
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from time import monotonic
from uuid import uuid4


@dataclass(frozen=True)
class Limits:
    max_nodes: int = 200
    max_depth: int = 8
    max_text_chars: int = 6000
    max_field_chars: int = 512
    seconds: float = 12

    def __post_init__(self):
        if not (1 <= self.max_nodes <= 500 and 0 <= self.max_depth <= 12
                and 1 <= self.max_text_chars <= 16000 and 1 <= self.max_field_chars <= 2000
                and 0 < self.seconds <= 30):
            raise ValueError("invalid observation bounds")


def collect(root, identity, limits=Limits()):
    """Node protocol: pid, password, visible, read(text_limit), children().

    Password checks precede every text read. Unknown security state skips a
    subtree. Backend exceptions make the observation incomplete, not successful.
    """
    observation_id = str(uuid4())
    captured_at = datetime.now(timezone.utc).isoformat()
    started = monotonic()
    nodes, issues = [], []
    visited, remaining = 0, limits.max_text_chars
    stack = [(iter([root]), 0, None)]

    def clip(value):
        nonlocal remaining
        value = "" if value is None else str(value)
        count = min(len(value), limits.max_field_chars, remaining)
        if count < len(value):
            issues.append("TEXT_LIMIT")
        remaining -= count
        return value[:count]

    while stack:
        if monotonic() - started > limits.seconds:
            issues.append("TIMEOUT")
            break
        if visited >= limits.max_nodes:
            issues.append("NODE_LIMIT")
            break
        if remaining <= 0:
            issues.append("TEXT_LIMIT")
            break
        iterator, depth, parent = stack[-1]
        try:
            node = next(iterator)
        except StopIteration:
            stack.pop()
            continue
        except Exception:
            issues.append("CHILD_READ_FAILED")
            stack.pop()
            continue
        visited += 1
        try:
            if node.pid != identity["pid"]:
                issues.append("CROSS_PROCESS_SKIPPED")
                continue
            if node.password:
                issues.append("PASSWORD_SUBTREE_SKIPPED")
                continue
            if not node.visible:
                continue
        except Exception:
            issues.append("SECURITY_STATE_UNAVAILABLE")
            continue
        try:
            values = node.read(min(limits.max_field_chars, remaining))
            index = len(nodes) + 1
            entry = {"element_id": f"{observation_id}:{index}", "index": index,
                     "parent_index": parent, "depth": depth, "pid": identity["pid"],
                     "name": clip(values.get("name")), "control_type": clip(values.get("control_type")),
                     "automation_id": clip(values.get("automation_id")), "text": clip(values.get("text")),
                     "text_status": values.get("text_status", "not_requested"),
                     "rectangle": values.get("rectangle"), "enabled": values.get("enabled"),
                     "runtime_id": values.get("runtime_id")}
            if entry["text_status"] == "truncated":
                issues.append("TEXT_LIMIT")
            nodes.append(entry)
            if depth < limits.max_depth:
                stack.append((iter(node.children()), depth + 1, index))
            else:
                # Conservative: do not descend just to find whether hidden children exist.
                issues.append("DEPTH_BOUNDARY")
        except Exception:
            issues.append("ELEMENT_READ_FAILED")

    fingerprint_nodes = [{k: v for k, v in n.items() if k != "element_id"} for n in nodes]
    fingerprint = sha256(json.dumps({"identity": identity, "nodes": fingerprint_nodes}, sort_keys=True,
                                    ensure_ascii=False).encode("utf-8")).hexdigest()
    return {"schema_version": 1, "observation_id": observation_id, "captured_at": captured_at,
            "window": identity, "interface_version": fingerprint, "nodes": nodes,
            "visited_nodes": visited, "text_chars": limits.max_text_chars - remaining,
            "issues": sorted(set(issues)), "complete": not issues, "read_only": True,
            "actionable": False, "elapsed_seconds": round(monotonic() - started, 4)}
