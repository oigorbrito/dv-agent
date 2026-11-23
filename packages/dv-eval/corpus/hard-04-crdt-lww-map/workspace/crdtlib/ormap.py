"""OR-Map com chaves em tupla. Contrato em SPEC.md."""


class ORMap:
    def __init__(self, replica):
        raise NotImplementedError

    def put(self, key, value, physical):
        raise NotImplementedError

    def remove(self, key):
        raise NotImplementedError

    def remove_prefix(self, prefix):
        raise NotImplementedError

    def get(self, key, default=None):
        raise NotImplementedError

    def conflicts(self, key):
        raise NotImplementedError

    def keys(self):
        raise NotImplementedError

    def items(self):
        raise NotImplementedError

    def to_dict(self):
        raise NotImplementedError

    def subtree(self, prefix):
        raise NotImplementedError

    def merge(self, other):
        raise NotImplementedError

    def state(self):
        raise NotImplementedError
