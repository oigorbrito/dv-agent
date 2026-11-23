"""kvdb: banco chave-valor com WAL. Contrato em SPEC.md."""
from .engine import Database, TransactionError
from .wal import CorruptLogError, WriteAheadLog

__all__ = ["CorruptLogError", "Database", "TransactionError", "WriteAheadLog"]
