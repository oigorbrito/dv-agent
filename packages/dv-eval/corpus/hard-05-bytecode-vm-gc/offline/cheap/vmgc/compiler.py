"""Compilador do vmgc. Contrato em SPEC.md."""
import re

KEYWORDS = {"let", "in", "if", "then", "else", "fn", "nil"}
BUILTINS = {"new": 1, "len": 1, "set": 3, "print": 1}
_TOKEN = re.compile(
    r"""
    (?P<ws>[ \t\r]+)
  | (?P<nl>\n)
  | (?P<comment>\#[^\n]*)
  | (?P<int>[0-9]+)
  | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<sym>=>|==|[()\[\],;=+\-*<])
    """,
    re.VERBOSE,
)


class CompileError(Exception):
    def __init__(self, message, line):
        self.line = line
        super().__init__(f"linha {line}: {message}")


class Function:
    def __init__(self, name, code, lines, nparams, nlocals):
        self.name = name
        self.code = code
        self.lines = lines
        self.nparams = nparams
        self.nlocals = nlocals


class Program:
    def __init__(self, functions):
        self.functions = functions


def _tokens(src):
    out = []
    pos = 0
    line = 1
    while pos < len(src):
        m = _TOKEN.match(src, pos)
        if m is None:
            raise CompileError(f"caractere inesperado {src[pos]!r}", line)
        kind = m.lastgroup
        text = m.group()
        pos = m.end()
        if kind == "nl":
            line += 1
        elif kind in ("ws", "comment"):
            continue
        elif kind == "int":
            out.append(("INT", int(text), line))
        elif kind == "name":
            out.append(("KW" if text in KEYWORDS else "NAME", text, line))
        else:
            out.append(("SYM", text, line))
    out.append(("EOF", None, line))
    return out


class _Parser:
    def __init__(self, tokens):
        self.toks = tokens
        self.pos = 0

    def tok(self):
        return self.toks[self.pos]

    def at(self, kind, value=None):
        t = self.toks[self.pos]
        return t[0] == kind and (value is None or t[1] == value)

    def advance(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def expect(self, kind, value=None):
        if not self.at(kind, value):
            t = self.tok()
            raise CompileError(f"esperado {value or kind}, encontrado {t[1] or t[0]}", t[2])
        return self.advance()

    def name(self):
        return self.expect("NAME")[1]

    def program(self):
        lets = []
        while self.at("KW", "let"):
            line = self.advance()[2]
            name = self.name()
            self.expect("SYM", "=")
            value = self.expr()
            if self.at("KW", "in"):
                self.advance()
                body = self.expr()
                self.expect("EOF")
                return lets, ("let", name, value, body, line)
            self.expect("SYM", ";")
            lets.append((name, value, line))
        result = self.expr()
        self.expect("EOF")
        return lets, result

    def expr(self):
        t = self.tok()
        if self.at("KW", "let"):
            self.advance()
            name = self.name()
            self.expect("SYM", "=")
            value = self.expr()
            self.expect("KW", "in")
            return ("let", name, value, self.expr(), t[2])
        if self.at("KW", "if"):
            self.advance()
            cond = self.expr()
            self.expect("KW", "then")
            then = self.expr()
            self.expect("KW", "else")
            return ("if", cond, then, self.expr(), t[2])
        if self.at("KW", "fn"):
            self.advance()
            self.expect("SYM", "(")
            params = []
            if not self.at("SYM", ")"):
                params.append(self.name())
                while self.at("SYM", ","):
                    self.advance()
                    params.append(self.name())
            self.expect("SYM", ")")
            self.expect("SYM", "=>")
            return ("fn", params, self.expr(), t[2])
        return self.cmp()

    def cmp(self):
        left = self.sum()
        if self.at("SYM", "<") or self.at("SYM", "=="):
            op_tok = self.advance()
            return ("bin", op_tok[1], left, self.sum(), op_tok[2])
        return left

    def sum(self):
        left = self.prod()
        while self.at("SYM", "+") or self.at("SYM", "-"):
            op_tok = self.advance()
            left = ("bin", op_tok[1], left, self.prod(), op_tok[2])
        return left

    def prod(self):
        left = self.unary()
        while self.at("SYM", "*"):
            op_tok = self.advance()
            left = ("bin", "*", left, self.unary(), op_tok[2])
        return left

    def unary(self):
        if self.at("SYM", "-"):
            t = self.advance()
            return ("neg", self.unary(), t[2])
        return self.post()

    def post(self):
        e = self.prim()
        while True:
            if self.at("SYM", "("):
                t = self.advance()
                args = []
                if not self.at("SYM", ")"):
                    args.append(self.expr())
                    while self.at("SYM", ","):
                        self.advance()
                        args.append(self.expr())
                self.expect("SYM", ")")
                e = ("call", e, args, t[2])
            elif self.at("SYM", "["):
                t = self.advance()
                idx = self.expr()
                self.expect("SYM", "]")
                e = ("index", e, idx, t[2])
            else:
                return e

    def prim(self):
        t = self.tok()
        if t[0] == "INT":
            self.advance()
            return ("int", t[1], t[2])
        if t[0] == "NAME":
            self.advance()
            return ("name", t[1], t[2])
        if self.at("KW", "nil"):
            self.advance()
            return ("nil", t[2])
        if self.at("SYM", "("):
            self.advance()
            e = self.expr()
            self.expect("SYM", ")")
            return e
        if self.at("SYM", "["):
            self.advance()
            items = []
            if not self.at("SYM", "]"):
                items.append(self.expr())
                while self.at("SYM", ","):
                    self.advance()
                    items.append(self.expr())
            self.expect("SYM", "]")
            return ("array", items, t[2])
        raise CompileError(f"expressão esperada, encontrado {t[1] or t[0]}", t[2])


class _Scope:
    """Função em compilação: slots de locais, capturas (com origem no pai) e código."""

    def __init__(self, name, parent, params):
        self.name = name
        self.parent = parent
        self.nparams = len(params)
        self.slots = list(params)
        self.env = [(p, i) for i, p in enumerate(params)]
        self.captures = []
        self.capture_src = []
        self.code = []
        self.lines = []

    def emit(self, op, arg, line):
        self.code.append((op, arg))
        self.lines.append(line)
        return len(self.code) - 1


def _lookup(scope, name):
    for n, slot in reversed(scope.env):
        if n == name:
            return ("local", slot)
    for idx, cname in enumerate(scope.captures):
        if cname == name:
            return ("cap", idx)
    if scope.parent is None:
        return ("global", None)
    src = _lookup(scope.parent, name)
    if src[0] == "global":
        return src
    scope.captures.append(name)
    scope.capture_src.append(src)
    return ("cap", len(scope.captures) - 1)


_BINOPS = {"+": "ADD", "-": "SUB", "*": "MUL", "<": "LT", "==": "EQ"}


class _Compiler:
    def __init__(self, global_names):
        self.globals = set(global_names)
        self.scopes = []

    def new_scope(self, name, parent, params):
        scope = _Scope(name, parent, params)
        self.scopes.append(scope)
        return scope

    def expr(self, node, sc):
        kind = node[0]
        line = node[-1]
        if kind == "int":
            sc.emit("CONST", node[1], line)
        elif kind == "nil":
            sc.emit("CONST", None, line)
        elif kind == "name":
            where = _lookup(sc, node[1])
            if where[0] == "local":
                sc.emit("LOADL", where[1], line)
            elif where[0] == "cap":
                sc.emit("LOADC", where[1], line)
            elif node[1] in self.globals:
                sc.emit("LOADG", node[1], line)
            elif node[1] in BUILTINS:
                raise CompileError(f"builtin {node[1]} só pode ser chamada", line)
            else:
                raise CompileError(f"nome indefinido: {node[1]}", line)
        elif kind == "bin":
            self.expr(node[2], sc)
            self.expr(node[3], sc)
            sc.emit(_BINOPS[node[1]], None, line)
        elif kind == "neg":
            self.expr(node[1], sc)
            sc.emit("NEG", None, line)
        elif kind == "call":
            callee, args = node[1], node[2]
            if (callee[0] == "name" and callee[1] in BUILTINS and callee[1] not in self.globals
                    and _lookup(sc, callee[1])[0] == "global"):
                if len(args) != BUILTINS[callee[1]]:
                    raise CompileError(f"aridade de {callee[1]} deve ser {BUILTINS[callee[1]]}", line)
                for a in args:
                    self.expr(a, sc)
                sc.emit("BUILTIN", (callee[1], len(args)), line)
            else:
                self.expr(callee, sc)
                for a in args:
                    self.expr(a, sc)
                sc.emit("CALL", len(args), line)
        elif kind == "index":
            self.expr(node[1], sc)
            self.expr(node[2], sc)
            sc.emit("INDEX", None, line)
        elif kind == "array":
            for item in node[1]:
                self.expr(item, sc)
            sc.emit("ARRAY", len(node[1]), line)
        elif kind == "if":
            self.expr(node[1], sc)
            jf = sc.emit("JF", None, line)
            self.expr(node[2], sc)
            jmp = sc.emit("JMP", None, line)
            sc.code[jf] = ("JF", len(sc.code))
            self.expr(node[3], sc)
            sc.code[jmp] = ("JMP", len(sc.code))
        elif kind == "let":
            self.expr(node[2], sc)
            slot = len(sc.slots)
            sc.slots.append(node[1])
            sc.emit("STOREL", slot, line)
            sc.env.append((node[1], slot))
            self.expr(node[3], sc)
            sc.env.pop()
        elif kind == "fn":
            params, body = node[1], node[2]
            child = self.new_scope(f"fn@{line}", sc, params)
            self.expr(body, child)
            child.emit("RET", None, line)
            index = self.scopes.index(child)
            for kind_src, idx in child.capture_src:
                if kind_src == "local":
                    sc.emit("LOADL", idx, line)
                else:
                    sc.emit("LOADC", idx, line)
            sc.emit("CLOSURE", (index, len(child.captures)), line)
        else:
            raise CompileError(f"nó desconhecido: {kind}", line)


def compile_source(src):
    lets, result = _Parser(_tokens(src)).program()
    names = [n for n, _, _ in lets]
    for name in names:
        if names.count(name) > 1:
            raise CompileError(f"declaração global repetida: {name}", 0)
    compiler = _Compiler(names)
    main = compiler.new_scope("main", None, [])
    for name, value, line in lets:
        compiler.expr(value, main)
        main.emit("STOREG", name, line)
    compiler.expr(result, main)
    main.emit("RET", None, result[-1])
    functions = [Function(s.name, s.code, s.lines, s.nparams, len(s.slots)) for s in compiler.scopes]
    return Program(functions)
