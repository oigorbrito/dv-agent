"""Parser do minisql. Contrato em SPEC.md."""
from .tokenizer import SQLError, tokenize

AGG_FUNCS = ("COUNT", "SUM", "AVG", "MIN", "MAX")
CMP_OPS = ("=", "!=", "<", "<=", ">", ">=")


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self, offset=0):
        return self.tokens[self.pos + offset]

    def advance(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def at_kw(self, word):
        tok = self.peek()
        return tok.kind == "KW" and tok.value == word

    def at_sym(self, sym, offset=0):
        tok = self.peek(offset)
        return tok.kind == "SYM" and tok.value == sym

    def expect_kw(self, word):
        if not self.at_kw(word):
            raise SQLError(f"esperado {word} na posição {self.peek().pos}")
        self.advance()

    def expect_sym(self, sym):
        if not self.at_sym(sym):
            raise SQLError(f"esperado '{sym}' na posição {self.peek().pos}")
        self.advance()

    def ident(self):
        tok = self.peek()
        if tok.kind != "ID":
            raise SQLError(f"identificador esperado na posição {tok.pos}")
        self.advance()
        return tok.value

    def colref(self):
        first = self.ident()
        if self.at_sym("."):
            self.advance()
            return ("col", first, self.ident())
        return ("col", None, first)

    def number(self):
        negative = False
        if self.at_sym("-"):
            self.advance()
            negative = True
        tok = self.peek()
        if tok.kind != "INT":
            raise SQLError(f"número esperado na posição {tok.pos}")
        self.advance()
        return -tok.value if negative else tok.value

    def operand(self):
        tok = self.peek()
        if tok.kind == "STR":
            self.advance()
            return ("lit", tok.value)
        if tok.kind == "KW" and tok.value == "NULL":
            self.advance()
            return ("lit", None)
        if tok.kind == "INT" or self.at_sym("-"):
            return ("lit", self.number())
        if tok.kind == "ID" and self.at_sym("(", 1):
            func = tok.value.upper()
            if func not in AGG_FUNCS:
                raise SQLError(f"função desconhecida: {tok.value}")
            self.advance()
            self.advance()
            if self.at_sym("*"):
                self.advance()
                if func != "COUNT":
                    raise SQLError("só COUNT aceita *")
                arg = None
            else:
                arg = self.colref()
            self.expect_sym(")")
            return ("agg", func, arg)
        return self.colref()

    def predicate(self):
        if self.at_sym("("):
            self.advance()
            inner = self.expr()
            self.expect_sym(")")
            return inner
        left = self.operand()
        tok = self.peek()
        if tok.kind != "SYM" or tok.value not in CMP_OPS:
            raise SQLError(f"operador de comparação esperado na posição {tok.pos}")
        self.advance()
        return ("cmp", tok.value, left, self.operand())

    def conjunction(self):
        left = self.predicate()
        while self.at_kw("AND"):
            self.advance()
            left = ("and", left, self.predicate())
        return left

    def expr(self):
        left = self.conjunction()
        while self.at_kw("OR"):
            self.advance()
            left = ("or", left, self.conjunction())
        return left

    def select_item(self):
        if self.at_sym("*"):
            self.advance()
            expr = ("star",)
        else:
            expr = self.operand()
        alias = None
        if self.at_kw("AS"):
            self.advance()
            alias = self.ident()
        return expr, alias

    def table_ref(self):
        name = self.ident()
        alias = None
        if self.peek().kind == "ID":
            alias = self.ident()
        return name, alias

    def order_item(self):
        expr = self.operand()
        desc = False
        if self.at_kw("ASC"):
            self.advance()
        elif self.at_kw("DESC"):
            self.advance()
            desc = True
        if self.at_kw("NULLS"):
            self.advance()
            self.expect_kw("LAST")
        return expr, desc


def parse(sql):
    p = _Parser(tokenize(sql))
    p.expect_kw("SELECT")
    items = [p.select_item()]
    while p.at_sym(","):
        p.advance()
        items.append(p.select_item())
    p.expect_kw("FROM")
    table, alias = p.table_ref()
    join = None
    if p.at_kw("INNER") or p.at_kw("LEFT") or p.at_kw("JOIN"):
        kind = "LEFT" if p.at_kw("LEFT") else "INNER"
        if p.at_kw("LEFT") or p.at_kw("INNER"):
            p.advance()
        p.expect_kw("JOIN")
        jtable, jalias = p.table_ref()
        p.expect_kw("ON")
        join = {"kind": kind, "table": jtable, "alias": jalias, "on": p.expr()}
    where = None
    if p.at_kw("WHERE"):
        p.advance()
        where = p.expr()
    group = []
    if p.at_kw("GROUP"):
        p.advance()
        p.expect_kw("BY")
        group.append(p.colref())
        while p.at_sym(","):
            p.advance()
            group.append(p.colref())
    having = None
    if p.at_kw("HAVING"):
        p.advance()
        having = p.expr()
    order = []
    if p.at_kw("ORDER"):
        p.advance()
        p.expect_kw("BY")
        order.append(p.order_item())
        while p.at_sym(","):
            p.advance()
            order.append(p.order_item())
    if p.peek().kind != "EOF":
        raise SQLError(f"sobra texto na posição {p.peek().pos}")
    return {
        "items": items,
        "table": table,
        "alias": alias,
        "join": join,
        "where": where,
        "group": group,
        "having": having,
        "order": order,
    }
