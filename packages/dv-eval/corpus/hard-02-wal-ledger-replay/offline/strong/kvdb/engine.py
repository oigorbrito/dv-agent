"""Banco chave-valor com WAL, transações, savepoints e checkpoints. Contrato em SPEC.md."""
import copy
import json
import os

from .wal import WriteAheadLog

_DELETED = object()


class TransactionError(Exception):
    pass


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _apply(state, op):
    kind = op["op"]
    if kind == "set":
        state[op["key"]] = op["value"]
    elif kind == "del":
        state.pop(op["key"], None)
    elif kind == "incr":
        state[op["key"]] = state.get(op["key"], 0) + op["by"]
    else:
        raise ValueError(f"operação desconhecida no WAL: {kind}")


class Database:
    def __init__(self, directory):
        os.makedirs(directory, exist_ok=True)
        self._dir = directory
        self._wal = WriteAheadLog(os.path.join(directory, "wal.log"))
        self._state = {}
        self._snapshot_seq = 0
        self._txn = None
        self._recover()

    def _recover(self):
        snap_path = os.path.join(self._dir, "snapshot.json")
        if os.path.exists(snap_path):
            with open(snap_path, "r", encoding="utf-8") as fh:
                snap = json.load(fh)
            self._state = snap["state"]
            self._snapshot_seq = snap["last_seq"]
        records, _ = self._wal.scan()
        self._wal.truncate_torn_tail()
        last = self._snapshot_seq
        for record in records:
            seq = record.get("seq", 0)
            last = max(last, seq)
            if record.get("op") == "commit" and seq > self._snapshot_seq:
                for op in record["ops"]:
                    _apply(self._state, op)
        self._next_seq = last + 1

    def _require_txn(self):
        if self._txn is None:
            raise TransactionError("nenhuma transação ativa")
        return self._txn

    def get(self, key):
        if self._txn is not None and key in self._txn["overlay"]:
            value = self._txn["overlay"][key]
            return None if value is _DELETED else value
        return self._state.get(key)

    def begin(self):
        if self._txn is not None:
            raise TransactionError("transação já ativa")
        self._txn = {"ops": [], "overlay": {}, "savepoints": []}

    def _record(self, op):
        txn = self._require_txn()
        if op["op"] == "set":
            txn["overlay"][op["key"]] = op["value"]
        elif op["op"] == "del":
            txn["overlay"][op["key"]] = _DELETED
        else:
            current = self.get(op["key"])
            txn["overlay"][op["key"]] = (0 if current is None else current) + op["by"]
        txn["ops"].append(op)

    def set(self, key, value):
        self._record({"op": "set", "key": key, "value": value})

    def delete(self, key):
        self._record({"op": "del", "key": key})

    def incr(self, key, by=1):
        self._require_txn()
        current = self.get(key)
        if current is not None and not _is_int(current):
            raise TransactionError(f"incr em valor não inteiro: {key}")
        if not _is_int(by):
            raise TransactionError("incr exige 'by' inteiro")
        self._record({"op": "incr", "key": key, "by": by})

    def savepoint(self, name):
        txn = self._require_txn()
        txn["savepoints"].append((name, len(txn["ops"]), dict(txn["overlay"])))

    def rollback_to(self, name):
        txn = self._require_txn()
        for index in range(len(txn["savepoints"]) - 1, -1, -1):
            sp_name, ops_len, overlay = txn["savepoints"][index]
            if sp_name == name:
                del txn["ops"][ops_len:]
                txn["overlay"] = dict(overlay)
                del txn["savepoints"][index + 1 :]
                return
        raise TransactionError(f"savepoint inexistente: {name}")

    def commit(self):
        txn = self._require_txn()
        if txn["ops"]:
            seq = self._next_seq
            self._wal.append({"op": "commit", "seq": seq, "ops": txn["ops"]})
            for op in txn["ops"]:
                _apply(self._state, op)
            self._next_seq = seq + 1
        self._txn = None

    def abort(self):
        self._require_txn()
        self._txn = None

    def checkpoint(self):
        if self._txn is not None:
            raise TransactionError("checkpoint com transação ativa")
        last = self._next_seq - 1
        path = os.path.join(self._dir, "snapshot.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"last_seq": last, "state": self._state}, fh, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        self._snapshot_seq = last

    def committed(self):
        return copy.deepcopy(self._state)
