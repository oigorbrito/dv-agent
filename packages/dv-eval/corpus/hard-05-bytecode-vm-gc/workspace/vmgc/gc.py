"""Heap com coleta mark-and-sweep. Contrato em SPEC.md."""


class DanglingReference(Exception):
    pass


class Ref:
    __slots__ = ("handle",)

    def __init__(self, handle):
        self.handle = handle


class ArrayObj:
    __slots__ = ("items",)

    def __init__(self, items):
        self.items = items

    def children(self):
        return self.items


class Closure:
    __slots__ = ("fn_index", "captures")

    def __init__(self, fn_index, captures):
        self.fn_index = fn_index
        self.captures = captures

    def children(self):
        return self.captures


class Heap:
    def __init__(self, threshold):
        raise NotImplementedError

    def alloc(self, obj, roots):
        raise NotImplementedError

    def get(self, ref):
        raise NotImplementedError

    def collect(self, roots):
        raise NotImplementedError
