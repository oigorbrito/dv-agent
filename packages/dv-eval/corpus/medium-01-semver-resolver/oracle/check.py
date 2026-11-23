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
    import semver_resolver as sr
except Exception as exc:
    print(f"FAIL import semver_resolver: {exc}")
    sys.exit(1)


def raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return True
    return False


def S(version, constraint):
    return sr.satisfies(version, constraint)


check("caret: 1.2.3 satisfaz ^1.2.3", lambda: S("1.2.3", "^1.2.3"))
check("caret: 2.0.0 não satisfaz ^1.2.3", lambda: not S("2.0.0", "^1.2.3"))
check("caret: 1.2.2 não satisfaz ^1.2.3", lambda: not S("1.2.2", "^1.2.3"))
check("caret 0.x: 0.2.9 satisfaz ^0.2.3", lambda: S("0.2.9", "^0.2.3"))
check("caret 0.x: 0.3.0 não satisfaz ^0.2.3", lambda: not S("0.3.0", "^0.2.3"))
check("caret 0.0.x: 0.0.3 satisfaz e 0.0.4 não satisfaz ^0.0.3", lambda: S("0.0.3", "^0.0.3") and not S("0.0.4", "^0.0.3"))
check("tilde: 1.2.9 satisfaz ~1.2.3", lambda: S("1.2.9", "~1.2.3"))
check("tilde: 1.3.0 e 1.2.2 não satisfazem ~1.2.3", lambda: not S("1.3.0", "~1.2.3") and not S("1.2.2", "~1.2.3"))
check(
    "AND: >=1.0.0 <2.0.0",
    lambda: S("1.5.0", ">=1.0.0 <2.0.0") and not S("2.0.0", ">=1.0.0 <2.0.0") and not S("0.9.0", ">=1.0.0 <2.0.0"),
)
check(
    "OR: <1.0.0 || >=2.0.0",
    lambda: S("0.5.0", "<1.0.0 || >=2.0.0") and not S("1.5.0", "<1.0.0 || >=2.0.0") and S("2.1.0", "<1.0.0 || >=2.0.0"),
)
check("igualdade explícita e implícita", lambda: S("1.2.3", "=1.2.3") and S("1.2.3", "1.2.3") and not S("1.2.4", "1.2.3"))
check("pré-release excluída sem comparador da mesma tupla", lambda: not S("1.3.0-beta.1", "^1.2.0"))
check("pré-release aceita com comparador da mesma tupla", lambda: S("1.3.0-beta.1", ">=1.3.0-alpha.1 <1.3.0"))
check("pré-release de outra tupla não entra", lambda: not S("1.2.4-beta", "^1.2.3"))
check(
    "pré-release rc.1 < rc.2 com comparador da mesma tupla, e excluída por <1.0.0",
    lambda: S("1.0.0-rc.1", "<1.0.0-rc.2") and not S("1.0.0-rc.1", "<1.0.0"),
)


def precedence():
    order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.10", "1.0.0-alpha.2", "1.0.0-beta", "1.0.0", "1.0.1"]
    picks = [sr.max_satisfying(order, f"<={v}") for v in order]
    return picks == order and sr.max_satisfying(order, ">=9.0.0") is None


check("precedência SemVer (numérico, prefixo, release)", precedence)
check(
    "max_satisfying escolhe a maior compatível",
    lambda: sr.max_satisfying(["1.0.0", "1.4.2", "1.9.9", "2.0.0"], "^1.2.0") == "1.9.9",
)
check("versão inválida levanta InvalidVersion", lambda: raises(sr.InvalidVersion, lambda: S("1.2", "^1.0.0")))

REG = {
    "app": {"1.0.0": {"lib-a": "^1.0.0", "lib-b": "^1.0.0"}},
    "lib-a": {"1.0.0": {"core": "^1.0.0"}, "1.5.0": {"core": "^2.0.0"}},
    "lib-b": {"1.0.0": {"core": "^1.0.0"}},
    "core": {"1.0.0": {}, "1.4.0": {}, "2.0.0": {}},
}


def resolve_ok():
    return sr.resolve({"lib-a": "^1.0.0"}, REG) == {"lib-a": "1.5.0", "core": "2.0.0"}


def resolve_lib_b():
    return sr.resolve({"lib-b": "^1.0.0"}, REG) == {"lib-b": "1.0.0", "core": "1.4.0"}


def resolve_conflict():
    try:
        sr.resolve({"app": "^1.0.0"}, REG)
    except sr.ResolutionConflict as exc:
        return exc.package == "core"
    return False


def resolve_missing():
    try:
        sr.resolve({"ghost": "^1.0.0"}, REG)
    except sr.ResolutionConflict as exc:
        return exc.package == "ghost"
    return False


def resolve_no_backtrack():
    # Sem backtracking: lib-a 1.5.0 (maior) puxa core ^2 e lib-b exige core ^1; deve conflitar, não reescolher.
    try:
        sr.resolve({"lib-a": "^1.0.0", "lib-b": "^1.0.0"}, REG)
    except sr.ResolutionConflict as exc:
        return exc.package == "core"
    return False


check("resolve: grafo com escolha máxima e dependência transitiva", resolve_ok)
check("resolve: lib-b puxa core 1.4.0 (maior ^1)", resolve_lib_b)
check("resolve: app em conflito de core levanta ResolutionConflict(package='core')", resolve_conflict)
check("resolve: pacote ausente levanta ResolutionConflict(package='ghost')", resolve_missing)
check("resolve: sem backtracking, conflito detectado", resolve_no_backtrack)
check("resolve: raiz vazia retorna dict vazio", lambda: sr.resolve({}, REG) == {})

sys.exit(0 if all(RESULTS) else 1)
