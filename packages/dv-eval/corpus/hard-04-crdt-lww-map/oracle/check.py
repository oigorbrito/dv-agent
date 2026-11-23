# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import random
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
    import crdtlib as cr
    from crdtlib.hlc import HLC
    from crdtlib.vv import VersionVector
    from crdtlib.lwwset import LWWSet
    from crdtlib.ormap import ORMap
except Exception as exc:
    print(f"FAIL import crdtlib: {exc}")
    sys.exit(1)


def clone_map(x, name):
    n = ORMap(name)
    n.merge(x)
    return n


def clone_set(x, name):
    n = LWWSet(name)
    n.merge(x)
    return n


# ---------- HLC ----------
def hlc_now_monotonic():
    h = HLC("a")
    s1 = h.now(10)
    s2 = h.now(10)
    s3 = h.now(5)
    return s1 == (10, 0, "a") and s2 == (10, 1, "a") and s3 == (10, 2, "a") and s1 < s2 < s3


def hlc_observe_ahead():
    h = HLC("a")
    h.now(10)
    h.observe((50, 3, "b"), 0)  # pt passa a 50, lc = 3 + 1 = 4; o evento local seguinte soma 1
    return h.now(10) == (50, 5, "a") and (50, 5, "a") > (50, 3, "b")


def hlc_observe_physical():
    h = HLC("c")
    h.observe((5, 9, "z"), 20)
    return h.now(20) == (20, 1, "c")


def hlc_observe_equal_pt():
    h = HLC("d")
    h.now(7)
    h.observe((7, 4, "e"), 0)
    return h.now(0) == (7, 6, "d")


check("HLC: eventos locais monotônicos", hlc_now_monotonic)
check("HLC: observar carimbo à frente avança o lógico", hlc_observe_ahead)
check("HLC: relógio físico local avança com observação", hlc_observe_physical)
check("HLC: empate de tempo físico usa o maior lógico", hlc_observe_equal_pt)


def vv_basics():
    v = VersionVector()
    a1 = v.next("a")
    a2 = v.next("a")
    ok = (a1, a2) == (1, 2) and v.covers(("a", 2)) and not v.covers(("a", 3)) and not v.covers(("b", 1))
    w = VersionVector()
    w.next("b")
    w.next("b")
    w.next("b")
    v.merge(w)
    return ok and v.as_dict() == {"a": 2, "b": 3}


check("VersionVector: next, covers e merge pontual", vv_basics)

# ---------- LWWSet ----------
check("LWWSet: add, remove e re-add", lambda: (
    lambda s: (s.add("x", 1), s.contains("x"), s.remove("x", 2), s.contains("x"), s.add("x", 3), s.contains("x"))[-1]
)(LWWSet("a")))
def lww_concurrent_tie():
    a, b = LWWSet("a"), LWWSet("b")
    a.add("x", 5)
    b.remove("x", 5)  # mesmo tempo físico e lógico: a réplica "b" desempata
    cr.sync(a, b)
    return not a.contains("x") and not b.contains("x") and a.state() == b.state()


def lww_later_add_wins():
    a, b = LWWSet("a"), LWWSet("b")
    a.remove("x", 1)
    b.add("x", 2)
    a.merge(b)
    return a.contains("x")


check("LWWSet: remove concorrente com add de mesmo tempo: replica maior vence", lww_concurrent_tie)
check("LWWSet: add posterior vence remove anterior", lww_later_add_wins)


def lww_compact():
    a = LWWSet("a")
    a.add("y", 1)
    a.remove("y", 2)
    a.remove("w", 9)
    removed = a.compact((2, 0, "a"))
    return removed == 1 and a.tombstones() == 1 and not a.contains("y") and a.elements() == []


check("LWWSet: compactação remove só tombstones até o piso", lww_compact)


def random_lww(seed):
    rng = random.Random(seed)
    reps = {r: LWWSet(r) for r in "abc"}
    for _ in range(120):
        r = rng.choice("abc")
        e = rng.choice(["x", "y", "z", "w"])
        t = rng.randint(1, 50)
        if rng.random() < 0.6:
            reps[r].add(e, t)
        else:
            reps[r].remove(e, t)
        if rng.random() < 0.2:
            x, y = rng.sample("abc", 2)
            reps[x].merge(reps[y])
    return reps


def lww_laws():
    for seed in range(20):
        reps = random_lww(seed)
        states = []
        for perm in ["abc", "bca", "cab", "acb", "bac", "cba"]:
            fold = LWWSet("m")
            for r in perm:
                fold.merge(reps[r])
            states.append(fold.state())
        if any(s != states[0] for s in states):
            return False
        again = clone_set(reps["a"], "m2")
        again.merge(reps["a"])
        if again.state() != reps["a"].state():
            return False
    return True


check("LWWSet: merge comutativo, associativo e idempotente (20 cenários)", lww_laws)

# ---------- ORMap ----------


def map_basic():
    m = ORMap("a")
    m.put(("k",), 1, 10)
    first = m.get(("k",))
    m.put(("k",), 2, 11)
    second = (m.get(("k",)), m.conflicts(("k",)))
    m.remove(("k",))
    return first == 1 and second == (2, 1) and m.get(("k",), "d") == "d" and m.keys() == []


check("ORMap: put, sobrescrita local, remove", map_basic)


def map_concurrent_puts():
    a, b = ORMap("a"), ORMap("b")
    a.put(("k",), "A", 10)
    b.put(("k",), "B", 20)
    a.merge(b)
    b.merge(a)
    return a.conflicts(("k",)) == 2 and b.conflicts(("k",)) == 2 and a.get(("k",)) == "B" and b.get(("k",)) == "B"


check("ORMap: puts concorrentes geram dois dots; maior carimbo vence", map_concurrent_puts)


def map_add_wins():
    a, b = ORMap("a"), ORMap("b")
    a.put(("k",), "v1", 1)
    cr.sync(a, b)
    a.put(("k",), "v2", 2)
    b.remove(("k",))
    a.merge(b)
    b.merge(a)
    return a.get(("k",)) == "v2" and b.get(("k",)) == "v2"


check("ORMap: update concorrente sobrevive ao remove (add-wins)", map_add_wins)


def map_remove_only_observed():
    a, b = ORMap("a"), ORMap("b")
    a.put(("k",), "x", 1)
    b.put(("k",), "y", 2)
    a.remove(("k",))
    a.merge(b)
    return a.get(("k",)) == "y" and a.conflicts(("k",)) == 1


check("ORMap: remove só apaga o que foi observado", map_remove_only_observed)


def map_remove_observed_everywhere():
    a, b = ORMap("a"), ORMap("b")
    a.put(("k",), "x", 1)
    sync_pair = cr.sync
    sync_pair(a, b)
    b.remove(("k",))
    a.merge(b)
    return a.get(("k",), "gone") == "gone" and a.keys() == []


check("ORMap: remove causal apaga o dot já observado", map_remove_observed_everywhere)


def nested_prefix():
    m = ORMap("a")
    m.put(("cfg", "db", "host"), "h", 1)
    m.put(("cfg", "db", "port"), 5, 1)
    m.put(("cfg", "cache"), 1, 1)
    m.remove_prefix(("cfg", "db"))
    return m.keys() == [("cfg", "cache")] and m.subtree(("cfg",)) == {("cache",): 1} and m.to_dict() == {
        ("cfg", "cache"): 1}


check("ORMap: remove_prefix apaga a subárvore e subtree é relativo", nested_prefix)
check("sync: estados observáveis iguais após troca mútua", lambda: (
    lambda a, b: (a.put(("p",), 1, 1), b.put(("q",), 2, 2), cr.sync(a, b), a.items() == b.items())[-1])(
        ORMap("a"), ORMap("b")))


def random_map_ops(seed):
    rng = random.Random(seed)
    reps = {r: ORMap(r) for r in "abc"}
    keys = [("a",), ("b",), ("cfg", "x"), ("cfg", "y")]
    for step in range(150):
        r = rng.choice("abc")
        roll = rng.random()
        if roll < 0.5:
            reps[r].put(rng.choice(keys), rng.randint(0, 9), rng.randint(1, 40))
        elif roll < 0.8:
            reps[r].remove(rng.choice(keys))
        elif roll < 0.85:
            reps[r].remove_prefix(("cfg",))
        if rng.random() < 0.25:
            x, y = rng.sample("abc", 2)
            reps[x].merge(reps[y])
    return reps


def map_laws():
    for seed in range(20):
        reps = random_map_ops(seed)
        a, b, c = reps["a"], reps["b"], reps["c"]
        if clone_map(a, "t").state() != a.state():
            return False
        ab = clone_map(a, "x").merge(b).items()
        ba = clone_map(b, "y").merge(a).items()
        if ab != ba:
            return False
        left = clone_map(a, "p").merge(b).merge(c).items()
        right = clone_map(a, "q").merge(clone_map(b, "r").merge(c)).items()
        if left != right:
            return False
        idem = clone_map(a, "i")
        idem.merge(a)
        if idem.state() != a.state():
            return False
    return True


check("ORMap: merge comutativo, associativo e idempotente (20 cenários)", map_laws)


def map_convergence():
    for seed in range(15):
        reps = random_map_ops(seed + 100)
        results = []
        for perm in ["abc", "cba", "bac"]:
            fold = ORMap("f")
            for r in perm:
                fold.merge(reps[r])
            results.append(fold.items())
        if any(r != results[0] for r in results):
            return False
    return True


check("ORMap: convergência independente da ordem de merge (15 cenários)", map_convergence)

sys.exit(0 if all(RESULTS) else 1)
