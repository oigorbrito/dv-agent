"""Relógio vetorial. Contrato em SPEC.md."""


class VersionVector:
    def next(self, replica):
        raise NotImplementedError

    def covers(self, dot):
        raise NotImplementedError

    def merge(self, other):
        raise NotImplementedError

    def as_dict(self):
        raise NotImplementedError
