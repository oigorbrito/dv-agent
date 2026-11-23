"""Banco chave-valor com WAL, transações, savepoints e checkpoints. Contrato em SPEC.md."""


class TransactionError(Exception):
    pass


class Database:
    def __init__(self, directory):
        raise NotImplementedError

    def get(self, key):
        raise NotImplementedError

    def begin(self):
        raise NotImplementedError

    def set(self, key, value):
        raise NotImplementedError

    def delete(self, key):
        raise NotImplementedError

    def incr(self, key, by=1):
        raise NotImplementedError

    def savepoint(self, name):
        raise NotImplementedError

    def rollback_to(self, name):
        raise NotImplementedError

    def commit(self):
        raise NotImplementedError

    def abort(self):
        raise NotImplementedError

    def checkpoint(self):
        raise NotImplementedError

    def committed(self):
        raise NotImplementedError
