"""Relógio vetorial. Contrato em SPEC.md."""


class VersionVector:
    def __init__(self):
        self._v = {}

    def next(self, replica):
        self._v[replica] = self._v.get(replica, 0) + 1
        return self._v[replica]

    def covers(self, dot):
        replica, seq = dot
        return self._v.get(replica, 0) >= seq

    def merge(self, other):
        for replica, seq in other._v.items():
            if seq > self._v.get(replica, 0):
                self._v[replica] = seq

    def as_dict(self):
        return dict(self._v)
