"""LWW-Element-Set. Contrato em SPEC.md."""
from .hlc import HLC


class LWWSet:
    def __init__(self, replica):
        self.replica = replica
        self._hlc = HLC(replica)
        self._entries = {}

    def add(self, elem, physical):
        self._entries[elem] = (self._hlc.now(physical), True)

    def remove(self, elem, physical):
        self._entries[elem] = (self._hlc.now(physical), False)

    def merge(self, other):
        for elem, (stamp, present) in other._entries.items():
            mine = self._entries.get(elem)
            if mine is None or stamp > mine[0]:
                self._entries[elem] = (stamp, present)
                self._hlc.observe(stamp, 0)
        return self

    def contains(self, elem):
        entry = self._entries.get(elem)
        return entry is not None and entry[1]

    def elements(self):
        return sorted(e for e, (_, present) in self._entries.items() if present)

    def tombstones(self):
        return sum(1 for _, present in self._entries.values() if not present)

    def compact(self, floor):
        dead = [e for e, (stamp, present) in self._entries.items() if not present and stamp <= floor]
        for e in dead:
            del self._entries[e]
        return len(dead)

    def state(self):
        return dict(self._entries)
