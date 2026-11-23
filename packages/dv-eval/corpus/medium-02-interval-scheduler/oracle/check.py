# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import sys
from datetime import datetime, timezone

RESULTS = []


def check(name, fn):
    try:
        ok = bool(fn())
    except Exception as exc:
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        RESULTS.append(False)
        return
    print(("OK   " if ok else "FAIL ") + name)
    RESULTS.append(ok)


try:
    import scheduler as sc
except Exception as exc:
    print(f"FAIL import scheduler: {exc}")
    sys.exit(1)


def utc(h, m=0, day=10):
    return datetime(2024, 3, day, h, m, tzinfo=timezone.utc)


def raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return True
    return False


check("parse_instant converte offset para UTC", lambda: sc.parse_instant("2024-03-10T09:00-03:00") == utc(12))
check("parse_instant aceita Z e fração", lambda: sc.parse_instant("2024-03-10T12:00:30.250Z").microsecond == 250000)
check("parse_instant sem fuso é ScheduleError", lambda: raises(sc.ScheduleError, lambda: sc.parse_instant("2024-03-10T12:00")))
check("make_interval fim <= início é ScheduleError", lambda: raises(
    sc.ScheduleError, lambda: sc.make_interval("2024-03-10T12:00Z", "2024-03-10T12:00:00+00:00")))

A = (utc(9), utc(11))
check("overlap: parcial", lambda: sc.overlap_kind(A, (utc(10), utc(12))) == "partial")
check("overlap: total por contenção", lambda: sc.overlap_kind(A, (utc(9, 30), utc(10))) == "total")
check("overlap: total com intervalos iguais", lambda: sc.overlap_kind(A, A) == "total")
check("overlap: encostado não é sobreposição", lambda: sc.overlap_kind(A, (utc(11), utc(12))) == "none")
check("overlap: disjunto", lambda: sc.overlap_kind(A, (utc(13), utc(14))) == "none")


def merge_touch():
    out = sc.merge_intervals([("2024-03-10T09:00Z", "2024-03-10T10:00Z"), ("2024-03-10T10:00Z", "2024-03-10T11:00Z")])
    return out == [(utc(9), utc(11))]


def merge_buffer():
    pairs = [("2024-03-10T09:00Z", "2024-03-10T10:00Z"), ("2024-03-10T10:10Z", "2024-03-10T11:00Z"),
             ("2024-03-10T12:00Z", "2024-03-10T13:00Z")]
    return sc.merge_intervals(pairs, 15) == [(utc(9), utc(11)), (utc(12), utc(13))] and \
        sc.merge_intervals(pairs, 5) == [(utc(9), utc(10)), (utc(10, 10), utc(11)), (utc(12), utc(13))]


def merge_tz_and_order():
    pairs = [("2024-03-10T08:00-03:00", "2024-03-10T09:30-03:00"), ("2024-03-10T10:00Z", "2024-03-10T10:30Z")]
    return sc.merge_intervals(pairs) == [(utc(10), utc(10, 30)), (utc(11), utc(12, 30))]


check("merge: encostados se fundem com buffer 0", merge_touch)
check("merge: buffer 15 funde gap de 10 min, buffer 5 não", merge_buffer)
check("merge: fusos mistos ordenados em UTC", merge_tz_and_order)
check("merge: intervalo de outro fuso se funde quando sobrepõe", lambda: sc.merge_intervals([
    ("2024-03-10T09:00-03:00", "2024-03-10T10:00-03:00"),
    ("2024-03-10T12:30Z", "2024-03-10T13:00Z")]) == [(utc(12), utc(13))])


def book_gap_exact():
    existing = [(utc(10), utc(11))]
    return sc.can_book(existing, (utc(11, 15), utc(12)), 15) and not sc.can_book(existing, (utc(11, 10), utc(12)), 15)


def book_before():
    existing = [(utc(10), utc(11))]
    return sc.can_book(existing, (utc(8, 45), utc(9, 45)), 15) and not sc.can_book(existing, (utc(8, 50), utc(9, 50)), 15)


def book_overlap():
    existing = [(utc(10), utc(11))]
    return not sc.can_book(existing, (utc(10, 30), utc(12)), 0) and not sc.can_book(existing, (utc(9), utc(12)), 0)


check("can_book: folga exatamente igual ao buffer é permitida (depois)", book_gap_exact)
check("can_book: folga antes da reserva respeita o buffer", book_before)
check("can_book: sobreposição sempre recusa", book_overlap)

REQS = [
    ("2024-03-10T10:00Z", "2024-03-10T11:00Z"),   # 0: aceita
    ("2024-03-10T10:30Z", "2024-03-10T11:30Z"),   # 1: partial com 0
    ("2024-03-10T10:10Z", "2024-03-10T10:50Z"),   # 2: total dentro de 0
    ("2024-03-10T11:10Z", "2024-03-10T12:00Z"),   # 3: buffer (gap 10 < 15) com 0
    ("2024-03-10T11:15-00:00", "2024-03-10T12:00Z"),  # 4: gap 15 exato: aceita
]


def schedule_mixed():
    out = sc.schedule([], REQS[:5], 15)
    return out["accepted"] == [0, 4] and out["rejected"] == [
        {"index": 1, "reason": "overlap_partial"},
        {"index": 2, "reason": "overlap_total"},
        {"index": 3, "reason": "buffer"},
    ]


def schedule_existing():
    out = sc.schedule([("2024-03-10T10:00Z", "2024-03-10T12:00Z")], [("2024-03-10T09:00Z", "2024-03-10T10:00Z"),
                                                                    ("2024-03-10T09:30Z", "2024-03-10T11:00Z")], 0)
    return out == {"accepted": [0], "rejected": [{"index": 1, "reason": "overlap_partial"}]}


def schedule_total_wins():
    out = sc.schedule([("2024-03-10T10:00Z", "2024-03-10T12:00Z")], [("2024-03-10T09:00Z", "2024-03-10T13:00Z")], 0)
    return out == {"accepted": [], "rejected": [{"index": 0, "reason": "overlap_total"}]}


check("schedule: motivos e aceitas em ordem, com buffer exato aceito", schedule_mixed)
check("schedule: reservas existentes contam e sobreposição parcial é motivo", schedule_existing)
check("schedule: solicitação que contém reserva existente é overlap_total", schedule_total_wins)

sys.exit(0 if all(RESULTS) else 1)
