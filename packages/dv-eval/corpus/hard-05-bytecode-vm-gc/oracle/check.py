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
    import vmgc as vg
except Exception as exc:
    print(f"FAIL import vmgc: {exc}")
    sys.exit(1)


def value(src, threshold=8):
    return vg.run_source(src, threshold=threshold)["value"]


def raises(exc_type, fn):
    try:
        fn()
    except exc_type as exc:
        return exc
    return None


check("precedência e unário", lambda: value("let a = 2 + 3 * 4; if a < 20 then a - 1 else 0") == 13)
check("unário em expressão composta", lambda: value("(-(2 + 3)) * 2 - -1") == -9)
check("let local com sombreamento", lambda: value("let x = 1 in (let x = 2 in x) + x") == 3)
check("comentários e quebras de linha",
      lambda: value("# c1\nlet a = 5; # c2\na * 2") == 10)
check("closure captura valor do escopo externo",
      lambda: value("let make = fn(n) => fn(x) => x + n; let add5 = make(5); add5(10)") == 15)
check("recursão por global", lambda: value(
    "let fib = fn(n) => if n < 2 then n else fib(n - 1) + fib(n - 2); fib(10)") == 55)
check("arrays: literal, set e índice", lambda: value(
    "let a = [1, 2, 3]; let s = set(a, 1, 20); a[0] + a[1] + a[2]") == 24)
check("len e new", lambda: value("let a = new(4); len(a)") == 4)
check("igualdade de referências por identidade", lambda: value(
    "let a = new(0); let b = a; let c = new(0); (a == b) * 10 + (a == c)") == 10)
check("nil == nil e tipos diferentes são falsos", lambda: value("(nil == nil) * 10 + (1 == nil)") == 10)
def print_records_output():
    r = vg.run_source("let p = print(7); let q = print(new(0)); p + 1")
    return r["value"] == 8 and r["output"] == [7, []]


check("print registra saída e devolve o valor", print_records_output)
check("to_python de array aninhado", lambda: value(
    "let a = new(2); let b = new(1); let s = set(a, 0, b); a") == [[None], None])

# Lixo só é coletável depois que o frame termina: cada chamada global aloca e descarta um array.
GC_SRC = ("let churn = fn() => (let tmp = new(4) in 0); "
          + "".join(f"let c{i} = churn(); " for i in range(60)) + "c0")


def gc_collects_garbage():
    r = vg.run_source(GC_SRC, threshold=8)
    return r["value"] == 0 and r["collections"] > 0 and r["live"] <= 16


check("GC: lixo é coletado e a heap fica limitada", gc_collects_garbage)

CLOSURE_SRC = (
    "let mk = fn(n) => (let arr = new(2) in fn() => arr); "
    "let g = mk(1); "
    "let churn = fn(n) => if n < 1 then 0 else (let tmp = new(4) in churn(n - 1)); "
    "let z = churn(200); "
    "let w = set(g(), 0, 42); "
    "g()[0]"
)
check("GC: array alcançável só por capturas de closure sobrevive", lambda: value(CLOSURE_SRC) == 42)

# Ciclos a-b-a criados em cada chamada global e inalcançáveis depois do retorno.
CYCLE_SRC = (
    "let cyc = fn() => (let a = new(1) in (let b = new(1) in "
    "(let s = set(a, 0, b) in (let t = set(b, 0, a) in 0)))); "
    + "".join(f"let k{i} = cyc(); " for i in range(60)) + "k0"
)


def gc_collects_cycles():
    r = vg.run_source(CYCLE_SRC, threshold=8)
    return r["value"] == 0 and r["collections"] > 0 and r["live"] <= 16


check("GC: ciclos inalcançáveis são coletados", gc_collects_cycles)


def gc_transparent():
    programs = [GC_SRC, CLOSURE_SRC, CYCLE_SRC, "let a = [1, [2, 3], nil]; a[1][0] + len(a[1])",
                "let f = fn(x) => (let t = new(3) in x + 1); f(f(f(1)))"]
    for src in programs:
        results = [vg.run_source(src, threshold=t)["value"] for t in (1, 2, 8, 1000)]
        if any(r != results[0] for r in results):
            return False
    return True


check("GC é transparente: resultado independe do threshold", gc_transparent)


def stack_trace_is_precise():
    src = "let bad = fn(x) => x + 1;\nlet g = fn(y) => bad(y);\ng(nil)"
    exc = raises(vg.VMError, lambda: vg.run_source(src))
    return exc is not None and exc.trace == [("fn@1", 1), ("fn@2", 2), ("main", 3)]


check("trace de erro: funções e linhas exatas", stack_trace_is_precise)
check("erro de nome indefinido em tempo de compilação", lambda: (
    lambda e: e is not None and e.line == 2)(raises(vg.CompileError, lambda: vg.run_source(
        "let a = 1;\nb + 1"))))
check("erro de sintaxe é CompileError", lambda: raises(vg.CompileError, lambda: vg.run_source("let = 3; 4"))
      is not None)
check("builtin usada como valor é CompileError", lambda: raises(
    vg.CompileError, lambda: vg.run_source("let f = len; 1")) is not None)
check("chamar não-função é VMError", lambda: raises(vg.VMError, lambda: vg.run_source(
    "let a = 3; a(1)")) is not None)
check("aridade errada é VMError", lambda: raises(vg.VMError, lambda: vg.run_source(
    "let f = fn(x) => x; f(1, 2)")) is not None)
check("índice fora do intervalo é VMError", lambda: raises(vg.VMError, lambda: vg.run_source(
    "let a = new(2); a[5]")) is not None)
check("indexar não-array é VMError", lambda: raises(vg.VMError, lambda: vg.run_source("let a = 1; a[0]"))
      is not None)
check("global usada antes de definida é VMError", lambda: raises(vg.VMError, lambda: vg.run_source(
    "let a = b + 1; let b = 2; a")) is not None)
check("new com tamanho negativo é VMError", lambda: raises(vg.VMError, lambda: vg.run_source("new(0 - 1)"))
      is not None)

sys.exit(0 if all(RESULTS) else 1)
