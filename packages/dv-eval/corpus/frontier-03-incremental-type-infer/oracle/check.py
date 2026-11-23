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


def main():
    import ast_types as at
    import infer as inf
    from unify import Subst, TypeErr, unify

    def T(expr):
        return inf.infer(expr)

    def err(expr):
        try:
            inf.infer(expr)
        except TypeErr as e:
            return e
        return None

    ID = ("lam", "x", ("var", "x"))
    REC_XY = ("rec", {"x": ("lit", 1), "y": ("bool", True)})

    check("identidade: a -> a", lambda: T(ID) == "a -> a")
    check("literais", lambda: T(("lit", 1)) == "int" and T(("bool", False)) == "bool")
    check("aplicação simples", lambda: T(("app", ID, ("lit", 1))) == "int")
    check("let polimórfico: id usado em bool e int",
          lambda: T(("let", "id", ID, ("if", ("app", ("var", "id"), ("bool", True)),
                                       ("app", ("var", "id"), ("lit", 1)), ("lit", 2)))) == "int")
    check("occurs check em x x", lambda: err(("lam", "x", ("app", ("var", "x"), ("var", "x")))) is not None
          and "ocorrência" in err(("lam", "x", ("app", ("var", "x"), ("var", "x")))).message)
    check("registro literal fechado", lambda: T(REC_XY) == "{x: int, y: bool}")
    check("projeção em linha aberta: {x: a | b} -> a",
          lambda: T(("lam", "r", ("proj", ("var", "r"), "x"))) == "{x: a | b} -> a")
    check("polimorfismo de linha: aplicar a registro com campos extras",
          lambda: T(("app", ("lam", "r", ("proj", ("var", "r"), "x")), REC_XY)) == "int")
    e = err(("proj", ("rec", {"y": ("lit", 1)}), "x"))
    check("campo ausente em registro fechado é TypeErr citando o campo",
          lambda: e is not None and "campo ausente" in e.message and "x" in e.message)
    e = err(("if", ("lit", 1), ("lit", 2), ("lit", 3)))
    check("erro de condição traz origem 'condição de if'",
          lambda: e is not None and any("condição de if" in o for o in e.origin))
    e = err(("if", ("bool", True), ("lit", 1), ("bool", False)))
    check("erro de ramos traz origem 'ramos de if'",
          lambda: e is not None and any("ramos de if" in o for o in e.origin))
    check("let generaliza registro: getx reaplicado a outro registro",
          lambda: T(("let", "getx", ("lam", "r", ("proj", ("var", "r"), "x")),
                     ("app", ("var", "getx"), ("rec", {"x": ("bool", True)})))) == "bool")
    check("parâmetro de lambda é monomórfico: f usado em int e bool é erro",
          lambda: err(("lam", "f", ("if", ("app", ("var", "f"), ("lit", 1)),
                                    ("app", ("var", "f"), ("bool", True)), ("bool", False)))) is not None)
    check("let de lambda: let f = \\x.x in f", lambda: T(("let", "f", ID, ("var", "f"))) == "a -> a")
    check("generalização não captura variável do ambiente: \\y. let z = y in z",
          lambda: T(("lam", "y", ("let", "z", ("var", "y"), ("var", "z")))) == "a -> a")
    check("let com função de dois argumentos: k 1 true",
          lambda: T(("let", "k", ("lam", "x", ("lam", "y", ("var", "x"))),
                     ("app", ("app", ("var", "k"), ("lit", 1)), ("bool", True)))) == "int")
    check("dois parâmetros: \\x.\\y.x", lambda: T(("lam", "x", ("lam", "y", ("var", "x")))) == "a -> b -> a")
    check("sombreamento em let aninhado", lambda: T(("let", "x", ("lit", 1), ("let", "x", ("bool", True),
                                                                             ("var", "x")))) == "bool")
    check("projeção aninhada devolve registro",
          lambda: T(("proj", ("rec", {"a": ("rec", {"b": ("lit", 3)})}), "a")) == "{b: int}")
    e = err(("app", ("lam", "r", ("proj", ("var", "r"), "x")), ("rec", {"y": ("lit", 1)})))
    check("aplicação com registro sem o campo é erro", lambda: e is not None and "campo ausente" in e.message)
    check("id aplicado a registro", lambda: T(("let", "id", ID, ("app", ("var", "id"),
                                                                  ("rec", {"z": ("lit", 0)})))) == "{z: int}")
    check("composição de funções: (\\f.\\x. f x) id 5",
          lambda: T(("app", ("app", ("lam", "f", ("lam", "x", ("app", ("var", "f"), ("var", "x")))), ID),
                     ("lit", 5))) == "int")
    e = err(("app", ("lit", 1), ("lit", 2)))
    check("aplicar inteiro é erro com origem de aplicação",
          lambda: e is not None and "não unifica" in e.message and any("aplicação" in o for o in e.origin))
    check("variável não definida é erro",
          lambda: err(("var", "nope")) is not None and "variável não definida" in err(("var", "nope")).message)
    check("uma função com dois campos de linha compartilhada: \\f.\\r. f r.x r.y",
          lambda: T(("lam", "f", ("lam", "r", ("app", ("app", ("var", "f"), ("proj", ("var", "r"), "x")),
                                              ("proj", ("var", "r"), "y"))))) == "(a -> b -> c) -> {x: a, y: b | d} -> c")
    check("unificação de tipos iguais não-variáveis é idempotente", lambda: (lambda s: (
        unify(s, at.INT, at.INT), unify(s, at.TFun(at.INT, at.BOOL), at.TFun(at.INT, at.BOOL)), True)[-1])(Subst()))
    check("pretty: variáveis nomeadas pela ordem de aparição",
          lambda: at.pretty(at.TFun(at.TVar(), at.TFun(at.TVar(), at.TVar()))) == "a -> b -> c")
    check("pretty: função como argumento é parentetizada",
          lambda: at.pretty(at.TFun(at.TFun(at.INT, at.INT), at.INT)) == "(int -> int) -> int")


try:
    main()
except Exception as exc:
    print(f"FAIL setup: {type(exc).__name__}: {exc}")
    sys.exit(1)

sys.exit(0 if all(RESULTS) else 1)
