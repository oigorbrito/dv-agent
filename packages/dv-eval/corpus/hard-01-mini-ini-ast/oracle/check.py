# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import sys

RESULTS = []


def check(name, fn):
    try:
        ok = bool(fn())
    except Exception as exc:
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        RESULTS.append(False)
        return
    print(("OK   " if ok else "FAIL ") + name)
    RESULTS.append(ok)


try:
    import minicfg as mc
except Exception as exc:
    print(f"FAIL import minicfg: {exc}")
    sys.exit(1)


def raises(exc_type, fn):
    try:
        fn()
    except exc_type as exc:
        return exc
    return None


BASE = """
# comentário ignorado
[server]
host = "localhost"
port = 8080
ratio = 0.5
debug = true
name = "8080"

[client]
retries = -2
url = "http://${server.host}:${server.port}"
"""

def base_doc():
    doc = mc.parse(BASE)
    return doc, {e.key: e.value for e in doc.sections[0].entries}


def typed_values():
    doc, vals = base_doc()
    return (
        vals["host"] == "localhost"
        and type(vals["port"]) is int and vals["port"] == 8080
        and type(vals["ratio"]) is float
        and vals["debug"] is True
        and type(vals["name"]) is str and vals["name"] == "8080"
        and doc.sections[1].entries[0].value == -2
    )


check("parse: tipos bool, int, float e str preservados", typed_values)
check("parse: comentários e linhas em branco ignorados", lambda: [s.name for s in base_doc()[0].sections] == ["server", "client"])
check("parse: interpolação vira Interp com Ref", lambda: isinstance(base_doc()[0].sections[1].entries[1].value, mc.Interp))

RESOLVE_TEXT = """
[server]
host = "localhost"
port = 8080
debug = false
[app]
url = "http://${server.host}:${server.port}"
port = ${server.port}
flag = "debug=${server.debug}"
alias = "${server.host}"
ratio = 2.0
text = "r=${app.ratio}"
"""


def resolved_ok():
    out = mc.resolve(mc.parse(RESOLVE_TEXT))
    return (
        out["app"]["url"] == "http://localhost:8080"
        and out["app"]["port"] == 8080 and type(out["app"]["port"]) is int
        and out["app"]["flag"] == "debug=false"
        and out["app"]["alias"] == "localhost"
        and out["app"]["text"] == "r=2.0"
    )


def chain_ok():
    text = '[a]\nx = ${b.y}\n[b]\ny = "v${c.z}"\n[c]\nz = 2.5\n'
    out = mc.resolve(mc.parse(text))
    return out["a"]["x"] == "v2.5"


def bare_ref_keeps_type():
    text = "[a]\nn = 7\n[b]\nm = ${a.n}\n"
    out = mc.resolve(mc.parse(text))
    return out["b"]["m"] == 7 and type(out["b"]["m"]) is int


check("resolve: Ref sem aspas mantém tipo, Interp vira texto", resolved_ok)
check("resolve: cadeia de referências com Interp intermediário", chain_ok)
check("resolve: Ref sem aspas para int preserva int", bare_ref_keeps_type)


def cycle_direct():
    exc = raises(mc.CycleError, lambda: mc.resolve(mc.parse("[a]\nx = ${a.x}\n")))
    return exc is not None and exc.path[0] == ("a", "x") and exc.path[-1] == ("a", "x")


def cycle_indirect():
    text = '[a]\nx = "${b.y}"\n[b]\ny = ${a.x}\n'
    exc = raises(mc.CycleError, lambda: mc.resolve(mc.parse(text)))
    return exc is not None and exc.path == [("a", "x"), ("b", "y"), ("a", "x")]


def cycle_three():
    text = "[a]\nx = ${b.y}\n[b]\ny = ${c.z}\n[c]\nz = ${a.x}\n"
    exc = raises(mc.CycleError, lambda: mc.resolve(mc.parse(text)))
    return exc is not None and exc.path[0] == exc.path[-1] and len(exc.path) == 4


check("ciclo: auto-referência é CycleError", cycle_direct)
check("ciclo: indireto a->b->a é CycleError com path exato", cycle_indirect)
check("ciclo: de três nós é CycleError", cycle_three)
check("referência inexistente é UnknownReferenceError", lambda: raises(
    mc.UnknownReferenceError, lambda: mc.resolve(mc.parse("[a]\nx = ${zz.y}\n"))) is not None)


def parse_error_line(text):
    exc = raises(mc.ParseError, lambda: mc.parse(text))
    return exc.line if exc is not None else None


check("erro: entrada antes de seção (linha 1)", lambda: parse_error_line("k = 1\n[a]\n") == 1)
check("erro: chave repetida na seção (linha 4)", lambda: parse_error_line("[a]\nk = 1\n\nk = 2\n") == 4)
check("erro: seção repetida", lambda: parse_error_line("[a]\nk = 1\n[a]\n") == 3)
check("erro: valor inválido 80a", lambda: parse_error_line("[a]\nk = 80a\n") == 2)
check("erro: aspas não fechadas", lambda: parse_error_line('[a]\nk = "abc\n') == 2)
check("erro: texto após aspas", lambda: parse_error_line('[a]\nk = "abc" x\n') == 2)
check("erro: escape inválido \\q", lambda: parse_error_line('[a]\nk = "a\\qb"\n') == 2)
check("erro: zero à esquerda não é inteiro", lambda: parse_error_line("[a]\nk = 007\n") == 2)


def round_trip():
    text = (
        "[s]\nlit = \"custo \\$5 e \\\"aspas\\\" \\\\ barra\"\nfake = \"\\${x.y}\"\n"
        "f = 2.0\nb = false\nn = -10\nref = ${t.v}\nmix = \"a${t.v}b\"\n"
        "[t]\nv = 1.5\n"
    )
    first = mc.parse(text)
    rendered = mc.dumps(first)
    second = mc.parse(rendered)
    return second == first and mc.dumps(second) == rendered


def escapes_preserved():
    doc = mc.parse('[s]\nk = "a \\$b \\"c\\" \\\\ d"\n')
    value = doc.sections[0].entries[0].value
    return value == 'a $b "c" \\ d' and isinstance(value, str)


def dumps_canonical():
    text = "# x\n[a]\nk = 1\nf = 2.0\nb = true\n\n[b]\ns = \"v\"\n"
    return mc.dumps(mc.parse(text)) == '[a]\nk = 1\nf = 2.0\nb = true\n\n[b]\ns = "v"\n'


def dumps_quotes_literal_ref():
    doc = mc.parse('[s]\nk = "\\${x.y}"\n')
    rendered = mc.dumps(doc)
    return mc.parse(rendered) == doc and mc.parse(rendered).sections[0].entries[0].value == "${x.y}"


check("round-trip: parse(dumps(d)) == d e dumps idempotente", round_trip)
check("escapes \\$ \\\" \\\\ preservados como str", escapes_preserved)
check("dumps canônico: comentários fora, bool e float corretos", dumps_canonical)
check("str com ${...} literal não vira referência no round-trip", dumps_quotes_literal_ref)

sys.exit(0 if all(RESULTS) else 1)
