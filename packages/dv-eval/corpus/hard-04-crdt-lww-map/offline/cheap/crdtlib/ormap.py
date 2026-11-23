"""OR-Map com chaves em tupla. Contrato em SPEC.md."""
from .hlc import HLC
from .vv import VersionVector


class ORMap:
    def __init__(self, replica):
        self.replica = replica
        self._hlc = HLC(replica)
        self._vv = VersionVector()
        self._dots = {}

    def put(self, key, value, physical):
        stamp = self._hlc.now(physical)
        dot = (self.replica, self._vv.next(self.replica))
        self._dots[key] = {dot: (stamp, value)}

    def remove(self, key):
        self._dots.pop(key, None)

    def remove_prefix(self, prefix):
        n = len(prefix)
        head = tuple(prefix)
        for key in [k for k in self._dots if isinstance(k, tuple) and k[:n] == head]:
            del self._dots[key]

    def get(self, key, default=None):
        dots = self._dots.get(key)
        if not dots:
            return default
        return max(dots.values(), key=lambda entry: entry[0])[1]

    def conflicts(self, key):
        return len(self._dots.get(key, {}))

    def keys(self):
        return sorted(k for k, dots in self._dots.items() if dots)

    def items(self):
        return [(k, self.get(k)) for k in self.keys()]

    def to_dict(self):
        return dict(self.items())

    def subtree(self, prefix):
        n = len(prefix)
        head = tuple(prefix)
        return {k[n:]: v for k, v in self.items() if isinstance(k, tuple) and k[:n] == head}

    def merge(self, other):
        new = {}
        for key in set(self._dots) | set(other._dots):
            mine = self._dots.get(key, {})
            theirs = other._dots.get(key, {})
            kept = {}
            for dot, entry in mine.items():
                if True:
                    kept[dot] = entry
            for dot, entry in theirs.items():
                if dot not in mine and not self._vv.covers(dot):
                    kept[dot] = entry
            if kept:
                new[key] = kept
        for dots in other._dots.values():
            for stamp, _ in dots.values():
                self._hlc.observe(stamp, 0)
        self._vv.merge(other._vv)
        self._dots = new
        return self

    def state(self):
        out = []
        for key in sorted(k for k, dots in self._dots.items() if dots):
            entries = sorted(((dot, stamp, value) for dot, (stamp, value) in self._dots[key].items()),
                             key=lambda t: t[0])
            out.append((key, entries))
        return out
