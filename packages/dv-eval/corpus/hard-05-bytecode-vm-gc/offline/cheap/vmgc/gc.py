"""Heap com coleta mark-and-sweep. Contrato em SPEC.md."""


class DanglingReference(Exception):
    pass


class Ref:
    __slots__ = ("handle",)

    def __init__(self, handle):
        self.handle = handle

    def __repr__(self):
        return f"Ref({self.handle})"


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
        if threshold < 1:
            raise ValueError("threshold deve ser >= 1")
        self.threshold = threshold
        self.objects = {}
        self._next = 1
        self._since = 0
        self.collections = 0
        self.allocations = 0

    def alloc(self, obj, roots):
        if self._since >= self.threshold:
            self.collect(roots())
        handle = self._next
        self._next += 1
        self.objects[handle] = obj
        self._since += 1
        self.allocations += 1
        return Ref(handle)

    def get(self, ref):
        try:
            return self.objects[ref.handle]
        except KeyError:
            raise DanglingReference(ref.handle) from None

    def collect(self, roots):
        marked = set()
        todo = [v.handle for v in roots if isinstance(v, Ref)]
        while todo:
            handle = todo.pop()
            if handle in marked:
                continue
            obj = self.objects.get(handle)
            if obj is None:
                continue
            marked.add(handle)
            for child in (obj.children() if isinstance(obj, ArrayObj) else []):
                if isinstance(child, Ref):
                    todo.append(child.handle)
        for handle in [h for h in self.objects if h not in marked]:
            del self.objects[handle]
        self.collections += 1
        self._since = 0
