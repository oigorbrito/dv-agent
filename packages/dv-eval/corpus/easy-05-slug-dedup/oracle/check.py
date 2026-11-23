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
    import slugs as sg
except Exception as exc:
    print(f"FAIL import slugs: {exc}")
    sys.exit(1)


def raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


check("acentos e combinantes", lambda: sg.make_slug("Crème Brûlée") == "creme-brulee")
check("exceções de transliteração", lambda: sg.make_slug("Straße Æther Øl Łódź") == "strasse-aether-ol-lodz")
check("pontuação colapsada e bordas aparadas", lambda: sg.make_slug("  --Hello__World!!--  ") == "hello-world")
check("maiúsculas e dígitos", lambda: sg.make_slug("Python 3.12 RC1") == "python-3-12-rc1")
check("cabe no limite: fica igual", lambda: sg.make_slug("alpha beta", 10) == "alpha-beta")
check("limite não corta palavra ao meio", lambda: sg.make_slug("alpha beta gamma delta", 12) == "alpha-beta")
check("limite exato em fronteira de palavra", lambda: sg.make_slug("alpha beta gamma", 10) == "alpha-beta")
check("palavra única maior que o limite é cortada", lambda: sg.make_slug("abcdefghijklmnop", 5) == "abcde")
check("slug vazio vira item", lambda: sg.make_slug("!!!") == "item" and sg.make_slug("") == "item")
check("max_len inválido", lambda: raises(lambda: sg.make_slug("x", 0)))
check("padrão de 40 caracteres", lambda: len(sg.make_slug("a" * 50)) == 40)
def collisions():
    s = sg.Slugger()
    return [s.assign(t) for t in ["Hello", "Hello!", "hello"]] == ["hello", "hello-2", "hello-3"]


check("colisão gera -2, -3", collisions)
check("reservados contam como usados", lambda: sg.Slugger(reserved=["hello"]).assign("Hello") == "hello-2")
def suffix_fits():
    s = sg.Slugger(max_len=8)
    return [s.assign("alpha beta"), s.assign("alpha beta")] == ["alpha", "alpha-2"]


check("sufixo respeita o limite com corte de palavra", suffix_fits)
def determinism():
    s = sg.Slugger()
    return [s.assign(t) for t in ["a b", "a-b", "A B"]] == ["a-b", "a-b-2", "a-b-3"]


check("determinismo da sequência", determinism)

sys.exit(0 if all(RESULTS) else 1)
