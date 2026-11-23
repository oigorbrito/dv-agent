"""Write-Ahead Log append-only. Contrato em SPEC.md."""


class CorruptLogError(Exception):
    pass


class WriteAheadLog:
    def __init__(self, path):
        raise NotImplementedError

    def append(self, record):
        raise NotImplementedError

    def scan(self):
        raise NotImplementedError

    def truncate_torn_tail(self):
        raise NotImplementedError
