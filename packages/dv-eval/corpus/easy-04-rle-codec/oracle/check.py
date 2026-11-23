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
    import rle
except Exception as exc:
    print(f"FAIL import rle: {exc}")
    sys.exit(1)


def raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


check("exemplo básico", lambda: rle.encode("aaabccdddd") == "3ab2c4d")
check("contagem com dois dígitos", lambda: rle.encode("x" * 12) == "12x")
check("texto vazio", lambda: rle.encode("") == "" and rle.decode("") == "")
check("dígito isolado é escapado", lambda: rle.encode("1") == "\\1")
check("corrida de dígitos", lambda: rle.encode("3333") == "4\\3")
check("barra invertida escapada", lambda: rle.encode("\\") == "\\\\")
check("decode dos exemplos", lambda: rle.decode("3ab2c4d") == "aaabccdddd" and rle.decode("12x") == "x" * 12)
check("decode de dígito escapado", lambda: rle.decode("\\1") == "1" and rle.decode("4\\3") == "3333")
check("ida e volta com dígitos, barras e unicode", lambda: all(
    rle.decode(rle.encode(s)) == s
    for s in ["", "a", "11223", "\\\\\\", "9999999999", "éééé", "a1\\1\\\\2", "0000000000001"]))
check("ida e volta aleatória determinística", lambda: all(
    rle.decode(rle.encode(s)) == s
    for s in ["".join(chr(48 + (i * 7 + j) % 12) for j in range(i % 9 + 1)) * (i % 4 + 1) for i in range(300)]))
check("contagem sem caractere é corrupção", lambda: raises(lambda: rle.decode("3")))
check("barra no fim é corrupção", lambda: raises(lambda: rle.decode("a\\")))
check("contagem zero é corrupção", lambda: raises(lambda: rle.decode("0a")))
check("contagem 1 é corrupção", lambda: raises(lambda: rle.decode("1a")))
check("zero à esquerda é corrupção", lambda: raises(lambda: rle.decode("02a")))
check("contagem acima do limite é corrupção", lambda: raises(lambda: rle.decode("1000001a")))
check("razão de compressão", lambda: rle.compression_ratio("aaaa") == 0.5 and rle.compression_ratio("") == 1.0
      and rle.compression_ratio("abcd") == 1.0)

sys.exit(0 if all(RESULTS) else 1)
