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
    import planner as pl
except Exception as exc:
    print(f"FAIL import planner: {exc}")
    sys.exit(1)


def t(deps=(), inputs=None):
    return {"deps": list(deps), "inputs": dict(inputs or {})}


def diamond(core="v1", lib1="v1", lib2="v1", app="v1"):
    return {
        "core": t(inputs={"core.c": core}),
        "lib1": t(["core"], inputs={"l1.c": lib1}),
        "lib2": t(["core"], inputs={"l2.c": lib2}),
        "app": t(["lib1", "lib2"], inputs={"main.c": app}),
    }


def raises(exc_type, fn):
    try:
        fn()
    except exc_type as exc:
        return exc
    return None


check("sem ciclo retorna None", lambda: pl.find_cycle(diamond()) is None)
check("ciclo de três nós: caminho exato", lambda: pl.find_cycle(
    {"a": t(["b"]), "b": t(["c"]), "c": t(["a"])}) == ["a", "b", "c", "a"])
check("auto-dependência", lambda: pl.find_cycle({"x": t(["x"])}) == ["x", "x"])
check("ciclo escolhido em ordem lexicográfica", lambda: pl.find_cycle(
    {"z": t(["m"]), "m": t(["k"]), "k": t(["m"])}) == ["k", "m", "k"])
check("dependência desconhecida é ValueError", lambda: raises(ValueError, lambda: pl.find_cycle(
    {"a": t(["ghost"])})) is not None)
check("hash muda com conteúdo do próprio alvo", lambda: pl.target_hash(diamond(), "core")
      != pl.target_hash(diamond(core="v2"), "core"))
check("hash propaga para dependentes (transitivo)", lambda: pl.target_hash(diamond(), "app")
      != pl.target_hash(diamond(core="v2"), "app"))
check("hash não muda com alvo não relacionado",
      lambda: pl.target_hash(diamond(), "lib1") == pl.target_hash(diamond(lib2="zz"), "lib1"))
check("hash é determinístico e tem 64 hex", lambda: pl.target_hash(diamond(), "app")
      == pl.target_hash(diamond(), "app") and len(pl.target_hash(diamond(), "app")) == 64)
check("snapshot cobre todos os alvos", lambda: set(pl.snapshot(diamond())) == {"core", "lib1", "lib2", "app"})
check("primeiro build: ondas por nível",
      lambda: pl.plan(diamond(), {}) == [["core"], ["lib1", "lib2"], ["app"]])
check("tudo construído: plano vazio", lambda: pl.plan(diamond(), pl.snapshot(diamond())) == [])
check("mudança em folha invalida só o caminho até a raiz",
      lambda: pl.plan(diamond(lib1="v2"), pl.snapshot(diamond())) == [["lib1"], ["app"]])
check("mudança na base invalida todos os dependentes",
      lambda: pl.plan(diamond(core="v2"), pl.snapshot(diamond())) == [["core"], ["lib1", "lib2"], ["app"]])


def cyclic_plan():
    exc = raises(pl.CycleError, lambda: pl.plan({"a": t(["b"]), "b": t(["a"])}, {}))
    return exc is not None and exc.path == ["a", "b", "a"]


check("plan com ciclo levanta CycleError com caminho", cyclic_plan)
check("plan respeita built parcial", lambda: pl.plan(diamond(), {"core": pl.snapshot(diamond())["core"]})
      == [["lib1", "lib2"], ["app"]])

sys.exit(0 if all(RESULTS) else 1)
