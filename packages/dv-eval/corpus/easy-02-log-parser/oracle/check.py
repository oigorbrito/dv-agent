# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import sys
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
RESULTS = []


def check(name, fn):
    try:
        ok = bool(fn())
    except Exception as exc:  # exceção conta como falha, com diagnóstico
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        RESULTS.append(False)
        return
    print(("OK   " if ok else "FAIL ") + name)
    RESULTS.append(ok)


try:
    import logparse
except Exception as exc:
    print(f"FAIL import logparse: {exc}")
    sys.exit(1)

d = lambda *a: datetime(*a, tzinfo=UTC)  # noqa: E731

check("Z normalizado", lambda: logparse.parse_line("2024-05-01T10:00:00Z INFO servidor iniciado")
      == {"ts": d(2024, 5, 1, 10), "level": "INFO", "message": "servidor iniciado"})
check("offset convertido para UTC", lambda: (r := logparse.parse_line("2024-05-01T07:00:00-03:00 WARN x"))
      is not None and r["ts"] == d(2024, 5, 1, 10) and r["ts"].utcoffset() == timedelta(0))
check("fração de segundo", lambda: logparse.parse_line("2024-05-01T10:00:00.500Z DEBUG x")["ts"].microsecond == 500000)
check("mensagem com espaços preservada", lambda: logparse.parse_line("2024-05-01T10:00:00Z ERROR falha: a b  c")["message"] == "falha: a b  c")
check("espaços nas bordas ignorados", lambda: logparse.parse_line("   2024-05-01T10:00:00Z INFO ok   ") is not None)
check("timestamp sem fuso é inválido", lambda: logparse.parse_line("2024-05-01T10:00:00 INFO x") is None)
check("nível minúsculo é inválido", lambda: logparse.parse_line("2024-05-01T10:00:00Z info x") is None)
check("nível desconhecido é inválido", lambda: logparse.parse_line("2024-05-01T10:00:00Z FATAL x") is None)
check("sem mensagem é inválido", lambda: logparse.parse_line("2024-05-01T10:00:00Z INFO") is None)
check("linha em branco não é válida", lambda: logparse.parse_line("   ") is None)

LINES = [
    "2024-05-01T10:00:00Z INFO a",
    "",
    "lixo sem formato",
    "2024-05-01T12:00:00+02:00 ERROR b",
    "2024-05-01T10:30:00Z WARN c",
    "   ",
]


def summary_ok():
    s = logparse.summarize(LINES)
    return (
        s["total"] == 3
        and s["malformed"] == 1
        and s["by_level"] == {"DEBUG": 0, "INFO": 1, "WARN": 1, "ERROR": 1}
        and s["first"] == d(2024, 5, 1, 10)
        and s["last"] == d(2024, 5, 1, 10, 30)
        and abs(s["duration_s"] - 1800.0) < 1e-9
        and s["error_rate"] == 0.3333
    )


check("summarize: brancos ignorados, malformados contados, UTC", summary_ok)
check("summarize: vazio", lambda: logparse.summarize([]) == {
    "total": 0, "malformed": 0, "by_level": {"DEBUG": 0, "INFO": 0, "WARN": 0, "ERROR": 0},
    "first": None, "last": None, "duration_s": 0.0, "error_rate": 0.0})
check("summarize: só malformados", lambda: logparse.summarize(["x", "y"])["malformed"] == 2
      and logparse.summarize(["x"])["total"] == 0)
check("duration com fusos mistos", lambda: abs(logparse.summarize([
    "2024-05-01T10:00:00+00:00 INFO a", "2024-05-01T09:00:01.500-01:00 INFO b"])["duration_s"] - 1.5) < 1e-9)

sys.exit(0 if all(RESULTS) else 1)
