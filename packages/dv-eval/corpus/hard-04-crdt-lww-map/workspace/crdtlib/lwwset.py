"""LWW-Element-Set. Contrato em SPEC.md."""


class LWWSet:
    def __init__(self, replica):
        raise NotImplementedError

    def add(self, elem, physical):
        raise NotImplementedError

    def remove(self, elem, physical):
        raise NotImplementedError

    def merge(self, other):
        raise NotImplementedError

    def contains(self, elem):
        raise NotImplementedError

    def elements(self):
        raise NotImplementedError

    def tombstones(self):
        raise NotImplementedError

    def compact(self, floor):
        raise NotImplementedError

    def state(self):
        raise NotImplementedError
