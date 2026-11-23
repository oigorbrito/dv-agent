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
    import csvnorm as cn
except Exception as exc:
    print(f"FAIL import csvnorm: {exc}")
    sys.exit(1)


def raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


check("registros simples", lambda: cn.parse_csv("a,b\n1,2\n") == [["a", "b"], ["1", "2"]])
check("vírgula dentro de aspas", lambda: cn.parse_csv('x,"y,z"\n') == [["x", "y,z"]])
check("aspas duplicadas são uma aspa", lambda: cn.parse_csv('"say ""hi"""\n') == [['say "hi"']])
check("quebra de linha dentro de aspas", lambda: cn.parse_csv('a,"l1\nl2"\n') == [["a", "l1\nl2"]])
check("CRLF e CR", lambda: cn.parse_csv("a\r\nb\rc\n") == [["a"], ["b"], ["c"]])
check("linhas vazias ignoradas e sem registro final vazio",
      lambda: cn.parse_csv("a\n\n\nb\n") == [["a"], ["b"]])
check("aspas no meio do campo são literais", lambda: cn.parse_csv('a"b,c\n') == [['a"b', "c"]])
check("aspas não fechadas", lambda: raises(lambda: cn.parse_csv('a,"bc\n')))
check("espaços preservados no parse", lambda: cn.parse_csv(" a , b \n") == [[" a ", " b "]])
check("delimitador configurável", lambda: cn.parse_csv("a;b;\"c;d\"\n", delimiter=";") == [["a", "b", "c;d"]])
check("cabeçalho normalizado", lambda: cn.normalize([" First Name ", "AGE"], [["x", "1"]])[0]
      == ["first_name", "age"])
check("nulos e strip", lambda: cn.normalize(["a", "b", "c"], [[" N/A ", "NULL", " x "]])[1] == [[None, None, "x"]])
check("tipos int, float e bool", lambda: cn.normalize(["n", "f", "ok"], [["7", "1.5", "YES"], ["", "2", "no"]],
                                                       types={"n": "int", "f": "float", "ok": "bool"})[1]
      == [[7, 1.5, True], [None, 2.0, False]])
check("tipo inválido levanta ValueError", lambda: raises(lambda: cn.normalize(["n"], [["x"]], types={"n": "int"})))
check("linha com número errado de células", lambda: raises(lambda: cn.normalize(["a", "b"], [["1"]])))
check("cabeçalho duplicado após normalização", lambda: raises(lambda: cn.normalize(["A", "a "], [["1", "2"]])))
check("tipo para coluna inexistente", lambda: raises(lambda: cn.normalize(["a"], [["1"]], types={"zz": "int"})))
check("deduplicação: posição da primeira, valores da última",
      lambda: cn.normalize(["id", "v"], [["1", "a"], ["2", "b"], ["1", "c"]], key="id")[1] == [["1", "c"], ["2", "b"]])
check("chave nula levanta ValueError", lambda: raises(lambda: cn.normalize(["id"], [[""]], key="id")))
check("chave inexistente levanta ValueError", lambda: raises(lambda: cn.normalize(["id"], [["1"]], key="nope")))
check("dump com aspas só quando necessário",
      lambda: cn.dump_csv(["a", "b"], [["x,y", 'q"r'], [None, True]]) == 'a,b\n"x,y","q""r"\n,true\n')
check("ida e volta de parse e dump", lambda: cn.parse_csv(cn.dump_csv(["h"], [['a,"b"\nc']]))
      == [["h"], ['a,"b"\nc']])

sys.exit(0 if all(RESULTS) else 1)
