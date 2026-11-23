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
    import limiter as lm
except Exception as exc:
    print(f"FAIL import limiter: {exc}")
    sys.exit(1)


class Clock:
    def __init__(self, t=0):
        self.t = t

    def __call__(self):
        return self.t


def raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


def window_basic():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/api", limit=3, window_ms=1000, sub_windows=4)
    first = [rl.allow("t", "/api")[0] for _ in range(3)]
    denied = rl.allow("t", "/api")
    return first == [True, True, True] and denied == (False, 1000)


check("janela cheia nega com retry exato (1000 ms)", window_basic)


def window_retry_decreases():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/api", limit=3, window_ms=1000, sub_windows=4)
    for _ in range(3):
        rl.allow("t", "/api")
    clk.t = 600
    return rl.allow("t", "/api") == (False, 400)


check("retry diminui com o tempo (400 ms em t=600)", window_retry_decreases)


def window_reopens():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/api", limit=3, window_ms=1000, sub_windows=4)
    for _ in range(3):
        rl.allow("t", "/api")
    clk.t = 1000
    return rl.allow("t", "/api") == (True, 0)


check("janela reabre exatamente em start + window", window_reopens)


def sub_window_granularity():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/api", limit=3, window_ms=1000, sub_windows=4)  # width 250
    rl.allow("t", "/api")
    rl.allow("t", "/api")  # bucket 0 com 2
    clk.t = 300
    ok_third = rl.allow("t", "/api") == (True, 0)  # bucket 250 com 1
    clk.t = 400
    return ok_third and rl.allow("t", "/api") == (False, 600)  # bucket 0 sai em 1000


check("sub-janela: retry aponta para o bucket mais antigo", sub_window_granularity)


def tenants_are_isolated():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/api", limit=1, window_ms=1000, sub_windows=1)
    return rl.allow("a", "/api") == (True, 0) and rl.allow("b", "/api") == (True, 0) and \
        rl.allow("a", "/api")[0] is False


check("tenants independentes", tenants_are_isolated)


def routes_have_own_quota():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/a", limit=1, window_ms=1000, sub_windows=1)
    rl.configure("/b", limit=2, window_ms=1000, sub_windows=1)
    rl.allow("t", "/a")
    return rl.allow("t", "/a")[0] is False and rl.allow("t", "/b") == (True, 0)


check("cotas por rota", routes_have_own_quota)


def burst_bucket():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/b", limit=2, window_ms=1000, sub_windows=1, burst=1)
    first = rl.allow("t", "/b")  # consome o único token
    second = rl.allow("t", "/b")  # sem token: espera 500 ms
    clk.t = 250
    third = rl.allow("t", "/b")  # 0.5 token: espera 250 ms
    clk.t = 500
    fourth = rl.allow("t", "/b")  # token recarregado a 1 e janela só tem 1 evento contado: permite
    return first == (True, 0) and second == (False, 500) and third == (False, 250) and fourth == (True, 0)


check("burst: token bucket nega com retry por recarga", burst_bucket)


def ceil_of_token_wait():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/c", limit=3, window_ms=1000, sub_windows=1, burst=1)
    rl.allow("t", "/c")
    return rl.allow("t", "/c") == (False, 334)  # ceil(1000/3)


check("retry por token é arredondado para cima em ms", ceil_of_token_wait)


def combined_takes_max():
    clk = Clock(0)
    rl = lm.RateLimiter(clk)
    rl.configure("/d", limit=2, window_ms=1000, sub_windows=1, burst=5)
    rl.allow("t", "/d")
    rl.allow("t", "/d")  # janela cheia: retry 1000
    return rl.allow("t", "/d") == (False, 1000)


check("janela e bucket combinados: maior retry", combined_takes_max)


def configure_validation():
    rl = lm.RateLimiter(Clock(0))
    return raises(lambda: rl.configure("/x", 1, 1000, sub_windows=3)) and raises(
        lambda: rl.configure("/x", 0, 1000)) and raises(lambda: rl.allow("t", "/nope"))


check("validação de configuração e rota", configure_validation)

sys.exit(0 if all(RESULTS) else 1)
