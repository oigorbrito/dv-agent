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
    import ttlcache as tc
except Exception as exc:
    print(f"FAIL import ttlcache: {exc}")
    sys.exit(1)


class Clock:
    def __init__(self, t=0.0):
        self.t = float(t)

    def __call__(self):
        return self.t


def raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


def basic():
    c = tc.TTLCache(2, clock=Clock())
    c.put("a", 1)
    return c.get("a") == 1 and c.get("zz", "d") == "d" and c.stats() == {
        "hits": 1, "misses": 1, "expired": 0, "evictions": 0}


check("get e stats básicos", basic)
check("validação de capacidade e TTL",
      lambda: raises(lambda: tc.TTLCache(0)) and raises(lambda: tc.TTLCache(True))
      and raises(lambda: tc.TTLCache(1, default_ttl=0)) and raises(lambda: tc.TTLCache(1).put("k", 1, ttl=-1)))


def expiry_is_inclusive():
    clk = Clock(0)
    c = tc.TTLCache(5, clock=clk)
    c.put("a", 1, ttl=10)
    clk.t = 9.99
    alive = c.get("a") == 1
    clk.t = 10.0
    return alive and c.get("a", "gone") == "gone"


check("expiração ocorre em now >= put + ttl", expiry_is_inclusive)


def expired_get_counts():
    clk = Clock(0)
    c = tc.TTLCache(5, clock=clk)
    c.put("a", 1, ttl=1)
    clk.t = 2
    c.get("a")
    return c.stats() == {"hits": 0, "misses": 1, "expired": 1, "evictions": 0} and "a" not in c


check("get de expirada: remove, conta expired e miss", expired_get_counts)


def default_and_override_ttl():
    clk = Clock(0)
    c = tc.TTLCache(5, default_ttl=5, clock=clk)
    c.put("short", 1, ttl=1)
    c.put("default", 2)
    c.put("inherits", 3, ttl=None)  # ttl None usa default_ttl (5 s)
    clk.t = 3
    return c.get("short") is None and c.get("default") == 2 and c.peek("inherits") == 3


check("TTL padrão e por entrada", default_and_override_ttl)


def never_expires():
    clk = Clock(0)
    c = tc.TTLCache(2, clock=clk)
    c.put("a", 1)
    clk.t = 1e9
    return c.get("a") == 1


check("sem TTL nunca expira", never_expires)


def expired_before_lru():
    clk = Clock(0)
    c = tc.TTLCache(2, clock=clk)
    c.put("a", 1, ttl=1)
    c.put("b", 2)
    clk.t = 5
    c.put("c", 3)
    return ("b" in c) and ("c" in c) and "a" not in c and c.stats()["evictions"] == 0 and c.stats()["expired"] == 1


check("cheio: expiradas saem antes de evictar viva", expired_before_lru)


def lru_eviction():
    clk = Clock(0)
    c = tc.TTLCache(2, clock=clk)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")  # a fica mais recente
    c.put("c", 3)  # evicta b
    return "a" in c and "c" in c and "b" not in c and c.stats()["evictions"] == 1


check("cheio: evicta a menos recentemente usada", lru_eviction)


def selective_refresh():
    c = tc.TTLCache(2, clock=Clock())
    c.put("a", 1)
    c.put("b", 2)
    c.get("a", refresh=False)  # não refresca: a continua LRU
    c.put("c", 3)
    return "a" not in c and "b" in c


check("get com refresh=False não altera recência", selective_refresh)


def peek_is_silent():
    c = tc.TTLCache(2, clock=Clock())
    c.put("a", 1)
    c.put("b", 2)
    c.peek("a")
    c.put("c", 3)  # a ainda é LRU: deve sair
    return c.stats()["hits"] == 0 and c.stats()["misses"] == 0 and "a" not in c


check("peek e 'in' não mudam recência nem estatísticas", peek_is_silent)


def update_does_not_evict():
    c = tc.TTLCache(2, clock=Clock())
    c.put("a", 1)
    c.put("b", 2)
    c.put("a", 10)
    return c.stats()["evictions"] == 0 and c.peek("a") == 10 and c.peek("b") == 2


check("atualizar chave existente não evicta", update_does_not_evict)


def len_purges():
    clk = Clock(0)
    c = tc.TTLCache(5, clock=clk)
    c.put("a", 1, ttl=1)
    c.put("b", 2)
    clk.t = 2
    return len(c) == 1 and c.stats()["expired"] == 1


check("len remove expiradas e conta", len_purges)


def stats_is_copy():
    c = tc.TTLCache(1, clock=Clock())
    s = c.stats()
    s["hits"] = 99
    return c.stats()["hits"] == 0


check("stats devolve cópia", stats_is_copy)

sys.exit(0 if all(RESULTS) else 1)
