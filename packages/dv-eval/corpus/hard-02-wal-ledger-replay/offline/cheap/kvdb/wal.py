"""Write-Ahead Log append-only. Contrato em SPEC.md."""
import json
import os


class CorruptLogError(Exception):
    pass


def _encode(record):
    return json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"


class WriteAheadLog:
    def __init__(self, path):
        self.path = path
        open(path, "ab").close()

    def append(self, record):
        data = _encode(record).encode("utf-8")
        with open(self.path, "ab") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())

    def scan(self):
        with open(self.path, "rb") as fh:
            raw = fh.read()
        records = []
        start = 0
        valid_end = 0
        while start < len(raw):
            newline = raw.find(b"\n", start)
            if newline == -1:
                break  # trecho final sem \n: registro truncado
            try:
                record = json.loads(raw[start:newline].decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise CorruptLogError(f"registro inválido no byte {start}") from exc
            if not isinstance(record, dict):
                raise CorruptLogError(f"registro não é objeto no byte {start}")
            records.append(record)
            start = newline + 1
            valid_end = start
        return records, valid_end

    def truncate_torn_tail(self):
        _, valid_end = self.scan()
        if valid_end < os.path.getsize(self.path):
            with open(self.path, "r+b") as fh:
                fh.truncate(valid_end)
                fh.flush()
                os.fsync(fh.fileno())
            return True
        return False
