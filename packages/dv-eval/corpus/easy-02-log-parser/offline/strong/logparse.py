"""Parser de logs. Contrato em SPEC.md."""
import re
from datetime import datetime, timezone

LEVELS = ("DEBUG", "INFO", "WARN", "ERROR")
_LINE = re.compile(r"(\S+) (DEBUG|INFO|WARN|ERROR) (.+)")


def parse_line(line):
    text = line.strip()
    match = _LINE.fullmatch(text)
    if match is None:
        return None
    ts_text, level, message = match.groups()
    try:
        ts = datetime.fromisoformat(ts_text)
    except ValueError:
        return None
    if ts.tzinfo is None:
        return None
    return {"ts": ts.astimezone(timezone.utc), "level": level, "message": message}


def summarize(lines):
    total = 0
    malformed = 0
    by_level = {level: 0 for level in LEVELS}
    stamps = []
    for raw in lines:
        if raw.strip() == "":
            continue
        record = parse_line(raw)
        if record is None:
            malformed += 1
            continue
        total += 1
        by_level[record["level"]] += 1
        stamps.append(record["ts"])
    first = min(stamps) if stamps else None
    last = max(stamps) if stamps else None
    duration = (last - first).total_seconds() if stamps else 0.0
    error_rate = round(by_level["ERROR"] / total, 4) if total else 0.0
    return {
        "total": total,
        "malformed": malformed,
        "by_level": by_level,
        "first": first,
        "last": last,
        "duration_s": duration,
        "error_rate": error_rate,
    }
