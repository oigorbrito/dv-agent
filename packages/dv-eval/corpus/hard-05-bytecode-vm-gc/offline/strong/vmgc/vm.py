"""Máquina virtual de pilha. Contrato em SPEC.md."""
from .gc import ArrayObj, Closure, DanglingReference, Heap, Ref


class VMError(Exception):
    def __init__(self, message, trace):
        self.trace = list(trace)
        where = "; ".join(f"{name}:{line}" for name, line in self.trace)
        super().__init__(f"{message} [{where}]")


class _Frame:
    __slots__ = ("fn", "ip", "locals", "captures")

    def __init__(self, fn, locals_, captures):
        self.fn = fn
        self.ip = 0
        self.locals = locals_
        self.captures = captures


def _equal(a, b):
    if isinstance(a, Ref) or isinstance(b, Ref):
        return isinstance(a, Ref) and isinstance(b, Ref) and a.handle == b.handle
    if a is None or b is None:
        return a is b
    return type(a) is type(b) and a == b


class VM:
    def __init__(self, program, threshold=8):
        self.program = program
        self.heap = Heap(threshold)
        self.globals = {}
        self.stack = []
        self.frames = []
        self.output = []

    # ---- raízes, traces e erros ----
    def _roots(self):
        roots = list(self.globals.values()) + list(self.stack)
        for frame in self.frames:
            roots.extend(frame.locals)
            roots.extend(frame.captures)
        return roots

    def _trace(self):
        out = []
        for frame in reversed(self.frames):
            line = frame.fn.lines[frame.ip - 1] if frame.ip > 0 else frame.fn.lines[0]
            out.append((frame.fn.name, line))
        return out

    def _err(self, message):
        return VMError(message, self._trace())

    def _alloc(self, obj):
        return self.heap.alloc(obj, self._roots)

    # ---- execução ----
    def run(self):
        main = self.program.functions[0]
        self.frames.append(_Frame(main, [None] * main.nlocals, []))
        while True:
            frame = self.frames[-1]
            op, arg = frame.fn.code[frame.ip]
            frame.ip += 1
            try:
                done = self._exec(op, arg, frame)
            except DanglingReference:
                raise self._err("referência inválida (coletada pelo GC)") from None
            if done is not None:
                return done[0]

    def _array(self, value):
        if isinstance(value, Ref):
            obj = self.heap.get(value)
            if isinstance(obj, ArrayObj):
                return obj
        raise self._err("valor não é array")

    def _exec(self, op, arg, frame):
        st = self.stack
        if op == "CONST":
            st.append(arg)
        elif op == "LOADL":
            st.append(frame.locals[arg])
        elif op == "LOADC":
            st.append(frame.captures[arg])
        elif op == "LOADG":
            if arg not in self.globals:
                raise self._err(f"global indefinida: {arg}")
            st.append(self.globals[arg])
        elif op == "STOREG":
            self.globals[arg] = st.pop()
        elif op == "STOREL":
            frame.locals[arg] = st.pop()
        elif op in ("ADD", "SUB", "MUL", "LT"):
            b = st.pop()
            a = st.pop()
            if type(a) is not int or type(b) is not int:
                raise self._err("operandos devem ser inteiros")
            if op == "ADD":
                st.append(a + b)
            elif op == "SUB":
                st.append(a - b)
            elif op == "MUL":
                st.append(a * b)
            else:
                st.append(int(a < b))
        elif op == "NEG":
            a = st.pop()
            if type(a) is not int:
                raise self._err("operando deve ser inteiro")
            st.append(-a)
        elif op == "EQ":
            b = st.pop()
            a = st.pop()
            st.append(int(_equal(a, b)))
        elif op == "JMP":
            frame.ip = arg
        elif op == "JF":
            cond = st.pop()
            if cond is None or (type(cond) is int and cond == 0):
                frame.ip = arg
        elif op == "CALL":
            self._call(arg)
        elif op == "RET":
            value = st.pop()
            self.frames.pop()
            if not self.frames:
                return (value,)
            st.append(value)
        elif op == "CLOSURE":
            index, n = arg
            caps = list(st[len(st) - n:]) if n else []
            ref = self._alloc(Closure(index, caps))
            if n:
                del st[len(st) - n:]
            st.append(ref)
        elif op == "ARRAY":
            items = list(st[len(st) - arg:]) if arg else []
            ref = self._alloc(ArrayObj(items))
            if arg:
                del st[len(st) - arg:]
            st.append(ref)
        elif op == "INDEX":
            index = st.pop()
            arr = self._array(st.pop())
            if type(index) is not int or not 0 <= index < len(arr.items):
                raise self._err("índice fora do intervalo")
            st.append(arr.items[index])
        elif op == "BUILTIN":
            self._builtin(*arg)
        else:
            raise self._err(f"instrução desconhecida: {op}")
        return None

    def _call(self, n):
        args = list(self.stack[len(self.stack) - n:]) if n else []
        if n:
            del self.stack[len(self.stack) - n:]
        callee = self.stack.pop()
        if not isinstance(callee, Ref):
            raise self._err("valor não é função")
        obj = self.heap.get(callee)
        if not isinstance(obj, Closure):
            raise self._err("valor não é função")
        fn = self.program.functions[obj.fn_index]
        if fn.nparams != n:
            raise self._err(f"aridade incorreta: esperado {fn.nparams}, recebido {n}")
        self.frames.append(_Frame(fn, args + [None] * (fn.nlocals - n), obj.captures))

    def _builtin(self, name, n):
        args = list(self.stack[len(self.stack) - n:]) if n else []
        if n:
            del self.stack[len(self.stack) - n:]
        if name == "new":
            size = args[0]
            if type(size) is not int or size < 0:
                raise self._err("tamanho inválido")
            self.stack.append(self._alloc(ArrayObj([None] * size)))
        elif name == "len":
            self.stack.append(len(self._array(args[0]).items))
        elif name == "set":
            arr = self._array(args[0])
            index = args[1]
            if type(index) is not int or not 0 <= index < len(arr.items):
                raise self._err("índice fora do intervalo")
            arr.items[index] = args[2]
            self.stack.append(args[2])
        elif name == "print":
            self.output.append(self.to_python(args[0]))
            self.stack.append(args[0])
        else:
            raise self._err(f"builtin desconhecida: {name}")

    def to_python(self, value, _path=None):
        path = set() if _path is None else _path
        if not isinstance(value, Ref):
            return value
        if value.handle in path:
            return "<ciclo>"
        obj = self.heap.get(value)
        if not isinstance(obj, ArrayObj):
            return "<fn>"
        path.add(value.handle)
        try:
            return [self.to_python(item, path) for item in obj.items]
        finally:
            path.discard(value.handle)
