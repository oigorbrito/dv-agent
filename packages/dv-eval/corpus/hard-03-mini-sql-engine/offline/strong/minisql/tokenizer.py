"""Tokenizer do minisql. Contrato em SPEC.md."""
from collections import namedtuple

KEYWORDS = {
    "SELECT", "FROM", "WHERE", "INNER", "LEFT", "JOIN", "ON", "AND", "OR", "GROUP", "BY",
    "HAVING", "ORDER", "ASC", "DESC", "NULLS", "LAST", "AS", "NULL",
}
DIGITS = "0123456789"
Token = namedtuple("Token", "kind value pos")


class SQLError(Exception):
    pass


def tokenize(sql):
    tokens = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]
        if ch.isspace():
            i += 1
            continue
        if ch in DIGITS:
            j = i
            while j < n and sql[j] in DIGITS:
                j += 1
            tokens.append(Token("INT", int(sql[i:j]), i))
            i = j
            continue
        if ch.isalpha() or ch == "_":
            j = i
            while j < n and (sql[j].isalnum() or sql[j] == "_"):
                j += 1
            word = sql[i:j]
            if word.upper() in KEYWORDS:
                tokens.append(Token("KW", word.upper(), i))
            else:
                tokens.append(Token("ID", word, i))
            i = j
            continue
        if ch == "'":
            j = i + 1
            buf = []
            while True:
                if j >= n:
                    raise SQLError(f"string não fechada na posição {i}")
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        buf.append("'")
                        j += 2
                        continue
                    break
                buf.append(sql[j])
                j += 1
            tokens.append(Token("STR", "".join(buf), i))
            i = j + 1
            continue
        two = sql[i:i + 2]
        if two in ("!=", "<=", ">="):
            tokens.append(Token("SYM", two, i))
            i += 2
            continue
        if two == "<>":
            tokens.append(Token("SYM", "!=", i))
            i += 2
            continue
        if ch in "(),*.=<>-":
            tokens.append(Token("SYM", ch, i))
            i += 1
            continue
        raise SQLError(f"caractere inesperado {ch!r} na posição {i}")
    tokens.append(Token("EOF", None, n))
    return tokens
