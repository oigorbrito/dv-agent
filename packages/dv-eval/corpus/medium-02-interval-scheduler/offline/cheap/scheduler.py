"""Agenda de salas. Contrato em SPEC.md."""
from datetime import datetime, timedelta, timezone


class ScheduleError(ValueError):
    pass


def parse_instant(text):
    try:
        moment = datetime.fromisoformat(text)
    except (TypeError, ValueError) as exc:
        raise ScheduleError(f"instante inválido: {text}") from exc
    if moment.tzinfo is None:
        raise ScheduleError(f"instante sem deslocamento: {text}")
    return moment.astimezone(timezone.utc)


def make_interval(start, end):
    s = parse_instant(start)
    e = parse_instant(end)
    if e <= s:
        raise ScheduleError(f"fim não posterior ao início: {start} .. {end}")
    return (s, e)


def overlap_kind(a, b):
    (a1, a2), (b1, b2) = a, b
    if min(a2, b2) <= max(a1, b1):
        return "none"
    if (a1 <= b1 and b2 <= a2) or (b1 <= a1 and a2 <= b2):
        return "total"
    return "partial"


def merge_intervals(pairs, buffer_minutes=0):
    gap = timedelta(minutes=buffer_minutes)
    merged = []
    for s, e in sorted(make_interval(start, end) for start, end in pairs):
        if merged and s <= merged[-1][1] + gap:
            if e > merged[-1][1]:
                merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def can_book(existing, request, buffer_minutes):
    gap = timedelta(minutes=buffer_minutes)
    s, e = request
    for a, b in existing:
        if overlap_kind((a, b), (s, e)) != "none":
            return False
        if s >= b:
            if s - b <= gap:
                return False
        elif a - e <= gap:
            return False
    return True


def _reason(existing, request, buffer_minutes):
    kinds = [overlap_kind(booked, request) for booked in existing]
    if "total" in kinds:
        return "overlap_total"
    if "partial" in kinds:
        return "overlap_partial"
    if can_book(existing, request, buffer_minutes):
        return None
    return "buffer"


def schedule(existing, requests, buffer_minutes):
    booked = [make_interval(start, end) for start, end in existing]
    accepted = []
    rejected = []
    for index, (start, end) in enumerate(requests):
        request = make_interval(start, end)
        reason = _reason(booked, request, buffer_minutes)
        if reason is None:
            booked.append(request)
            accepted.append(index)
        else:
            rejected.append({"index": index, "reason": reason})
    return {"accepted": accepted, "rejected": rejected}
