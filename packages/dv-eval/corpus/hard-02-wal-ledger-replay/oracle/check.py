# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import json
import os
import sys
import tempfile

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
    from kvdb import CorruptLogError, Database, TransactionError, WriteAheadLog
except Exception as exc:
    print(f"FAIL import kvdb: {exc}")
    sys.exit(1)


def new_dir():
    return tempfile.mkdtemp(prefix="kvdb-")


def raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return True
    return False


def wal_path(d):
    return os.path.join(d, "wal.log")


def read_wal_records(d):
    records, _ = WriteAheadLog(wal_path(d)).scan()
    return records


def persisted_ok():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.set("a", 1)
    db.set("b", {"x": [1, 2]})
    db.commit()
    db2 = Database(d)
    return db2.get("a") == 1 and db2.get("b") == {"x": [1, 2]} and db2.committed() == {"a": 1, "b": {"x": [1, 2]}}


def uncommitted_discarded():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.set("z", 9)
    # sem commit: "queda" simulada reabrindo o banco
    db2 = Database(d)
    return db2.get("z") is None and db2.committed() == {}


def read_your_writes_and_delete():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.set("a", 5)
    seen = db.get("a")
    db.delete("a")
    gone = db.get("a") is None
    db.set("keep", "v")
    db.commit()
    return seen == 5 and gone and Database(d).committed() == {"keep": "v"}


def incr_semantics():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.incr("c")
    db.incr("c", by=4)
    db.commit()
    return Database(d).get("c") == 5


def savepoint_partial_rollback():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.set("a", 1)
    db.savepoint("s1")
    db.set("a", 2)
    db.set("b", 3)
    db.savepoint("s2")
    db.incr("n", 1)
    db.rollback_to("s1")
    ok_mem = db.get("a") == 1 and db.get("b") is None and db.get("n") is None
    db.rollback_to("s1")  # s1 continua válido após rollback
    db.set("c", 7)
    db.commit()
    back = Database(d).committed()
    return ok_mem and back == {"a": 1, "c": 7}


def savepoint_errors():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.savepoint("x")
    db.savepoint("y")
    db.rollback_to("x")
    removed = raises(TransactionError, lambda: db.rollback_to("y"))
    unknown = raises(TransactionError, lambda: db.rollback_to("nope"))
    return removed and unknown


def usage_errors():
    d = new_dir()
    db = Database(d)
    results = [
        raises(TransactionError, lambda: db.set("a", 1)),
        raises(TransactionError, lambda: db.commit()),
        raises(TransactionError, lambda: db.abort()),
        raises(TransactionError, lambda: db.savepoint("s")),
    ]
    db.begin()
    results.append(raises(TransactionError, lambda: db.begin()))
    db.set("s", "texto")
    results.append(raises(TransactionError, lambda: db.incr("s")))
    results.append(raises(TransactionError, lambda: db.checkpoint()))
    db.abort()
    return all(results)


def empty_commit_writes_nothing():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.commit()
    return os.path.getsize(wal_path(d)) == 0 and not os.path.exists(os.path.join(d, "snapshot.json"))


def seq_monotonic():
    d = new_dir()
    db = Database(d)
    for value in (1, 2):
        db.begin()
        db.set("k", value)
        db.commit()
    db.begin()
    db.set("k", 3)
    db.abort()
    db.begin()
    db.set("k", 4)
    db.commit()
    seqs = [r["seq"] for r in read_wal_records(d)]
    return seqs == [1, 2, 3] and all(r["op"] == "commit" for r in read_wal_records(d))


def torn_tail_ignored_and_truncated():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.set("a", 1)
    db.commit()
    torn = b'{"op":"commit","ops":[{"op":"set","key":"b","value":2}],"seq":2}'  # sem \n: não durável
    with open(wal_path(d), "ab") as fh:
        fh.write(torn)
    db2 = Database(d)
    if db2.get("b") is not None or db2.get("a") != 1:
        return False
    if os.path.getsize(wal_path(d)) != len(open(wal_path(d), "rb").read().split(b"\n", 1)[0]) + 1:
        return False
    db2.begin()
    db2.set("c", 3)
    db2.commit()
    final = Database(d).committed()
    return final == {"a": 1, "c": 3} and [r["seq"] for r in read_wal_records(d)] == [1, 2]


def torn_tail_scan_contract():
    d = new_dir()
    w = WriteAheadLog(wal_path(d))
    w.append({"op": "x", "seq": 1})
    good = os.path.getsize(wal_path(d))
    with open(wal_path(d), "ab") as fh:
        fh.write(b'{"op":"x"')
    records, valid = w.scan()
    return len(records) == 1 and valid == good and w.truncate_torn_tail() is True and w.truncate_torn_tail() is False


def corrupt_middle_line_raises():
    d = new_dir()
    w = WriteAheadLog(wal_path(d))
    w.append({"op": "x", "seq": 1})
    with open(wal_path(d), "ab") as fh:
        fh.write(b"isto nao e json\n")
    w.append({"op": "x", "seq": 2})
    return raises(CorruptLogError, lambda: Database(d))


def checkpoint_skips_replayed_commits():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.incr("k", 5)
    db.commit()
    db.checkpoint()
    snap = json.load(open(os.path.join(d, "snapshot.json"), encoding="utf-8"))
    if snap["last_seq"] != 1 or snap["state"] != {"k": 5}:
        return False
    # o WAL ainda contém o commit 1 (já coberto pelo snapshot): reabrir não pode somá-lo de novo
    if Database(d).get("k") != 5:
        return False
    db2 = Database(d)
    db2.begin()
    db2.incr("k", 2)
    db2.commit()
    return Database(d).get("k") == 7 and [r["seq"] for r in read_wal_records(d)] == [1, 2]


def checkpoint_seq_continues():
    d = new_dir()
    db = Database(d)
    db.begin()
    db.set("a", 1)
    db.commit()
    db.checkpoint()
    db2 = Database(d)
    db2.begin()
    db2.set("b", 2)
    db2.commit()
    db3 = Database(d)
    return db3.committed() == {"a": 1, "b": 2} and [r["seq"] for r in read_wal_records(d)] == [1, 2]


def checkpoint_with_later_crash():
    d = new_dir()
    db = Database(d)
    for i in range(3):
        db.begin()
        db.incr("n", 1)
        db.commit()
    db.checkpoint()
    db.begin()
    db.incr("n", 10)
    db.commit()
    with open(wal_path(d), "ab") as fh:
        fh.write(b'{"op":"commit","seq":5,"ops":[{"op":"incr","key":"n","by":100}')
    return Database(d).get("n") == 13


check("persistência de commit e reabertura", persisted_ok)
check("transação não comitada é descartada na recuperação", uncommitted_discarded)
check("read-your-writes e deleção dentro da transação", read_your_writes_and_delete)
check("incr: ausente conta como 0, soma acumulada", incr_semantics)
check("savepoint: rollback parcial e savepoint reutilizável", savepoint_partial_rollback)
check("savepoint: removidos após rollback, nome inexistente é erro", savepoint_errors)
check("erros de uso levantam TransactionError", usage_errors)
check("commit vazio não grava nada", empty_commit_writes_nothing)
check("seq monotônico, sem consumir em transação abortada", seq_monotonic)
check("registro truncado no fim é ignorado e removido antes do próximo append", torn_tail_ignored_and_truncated)
check("scan e truncate_torn_tail: contrato de bytes válidos", torn_tail_scan_contract)
check("linha corrompida no meio levanta CorruptLogError", corrupt_middle_line_raises)
check("checkpoint: recuperação não reaplica commits cobertos pelo snapshot", checkpoint_skips_replayed_commits)
check("checkpoint: seq continua após o snapshot", checkpoint_seq_continues)
check("checkpoint + commits + truncamento final: estado correto", checkpoint_with_later_crash)

sys.exit(0 if all(RESULTS) else 1)
