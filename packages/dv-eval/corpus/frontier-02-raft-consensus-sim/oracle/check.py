# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import random
import sys
from collections import Counter

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
    from cluster import Cluster
    from log import Log
    from node import Node
except Exception as exc:
    print(f"FAIL import: {exc}")
    sys.exit(1)

def main():
    IDS5 = ["n1", "n2", "n3", "n4", "n5"]


    def isolate(c, nid):
        for other in c.nodes:
            if other != nid:
                c.cut_both(nid, other)


    def raises(exc_type, fn):
        try:
            fn()
        except exc_type:
            return True
        return False


    # ---------- log ----------
    def log_ops():
        lg = Log()
        lg.append(1, "a")
        lg.append(2, "b")
        lg.append(2, "c")
        return (lg.last_index() == 3 and lg.last_term() == 2 and lg.term_at(0) == 0 and lg.term_at(1) == 1
                and lg.term_at(4) is None and lg.slice_from(2) == [(2, "b"), (2, "c")])


    def log_up_to_date():
        lg = Log()
        lg.append(1, "a")
        lg.append(1, "b")
        return (lg.up_to_date(2, 1) and lg.up_to_date(3, 1) and not lg.up_to_date(1, 1) and lg.up_to_date(1, 2)
                is True)


    def log_truncate():
        lg = Log()
        for t in (1, 1, 2):
            lg.append(t, "x")
        lg.truncate_from(2)
        return lg.entries == [(1, "x")]


    check("Log: índices 1-based, term_at e slice_from", log_ops)
    check("Log: up_to_date compara termo e depois índice", log_up_to_date)
    check("Log: truncate_from remove a partir do índice", log_truncate)

    # ---------- eleição básica ----------
    c = Cluster(["n1", "n2", "n3"])
    c.elect("n1")
    c.deliver()
    check("eleição em 3 nós: n1 líder no termo 1", lambda: c.leaders() == ["n1"] and c.nodes["n1"].term == 1)
    check("seguidores reconhecem o líder via AppendEntries", lambda: c.nodes["n2"].leader_id == "n1"
          and c.nodes["n3"].leader_id == "n1" and c.nodes["n2"].term == 1)

    # ---------- replicação e commit ----------
    c.nodes["n1"].propose("a")
    c.replicate("n1")
    c.deliver()
    check("replicação: entrada chega aos seguidores", lambda: c.nodes["n2"].log.entries == [(1, "a")]
          and c.nodes["n3"].log.entries == [(1, "a")])
    check("commit no líder após maioria de acks", lambda: c.nodes["n1"].commit_index == 1)
    check("seguidor só commita no próximo heartbeat", lambda: c.nodes["n2"].commit_index == 0)
    c.replicate("n1")
    c.deliver()
    check("heartbeat seguinte propaga commit_index", lambda: c.nodes["n2"].commit_index == 1
          and c.nodes["n3"].commit_index == 1)

    # ---------- restrição de voto: log desatualizado não vence ----------
    c = Cluster(["n1", "n2", "n3"])
    c.elect("n1")
    c.deliver()
    isolate(c, "n3")
    c.nodes["n1"].propose("a")
    c.replicate("n1")
    c.deliver()
    c.heal()
    c.elect("n3")
    c.deliver()
    check("candidato com log desatualizado não vence (n1 e n2 recusam)",
          lambda: c.nodes["n3"].state == "candidate" and c.leaders() == [])
    check("líder antigo vê termo maior e vira seguidor", lambda: c.nodes["n1"].state == "follower"
          and c.nodes["n1"].term == 2)
    c.elect("n2")
    c.deliver()
    check("candidato com log atualizado vence no termo seguinte", lambda: c.leaders() == ["n2"]
          and c.nodes["n2"].term == 3)
    check("recuo do nextIndex até replicar a entrada faltante", lambda: c.nodes["n3"].log.entries == [(1, "a")])

    # ---------- Figura 8: commit só do termo corrente ----------
    c = Cluster(IDS5)
    c.elect("n1")
    c.deliver()
    c.nodes["n1"].propose("a")
    c.replicate("n1")
    c.deliver()
    c.elect("n1")  # termo 2, reeleição de n1
    c.deliver()
    check("Figura 8: n1 reeleito no termo 2", lambda: c.leaders() == ["n1"] and c.nodes["n1"].term == 2)
    for other in ["n3", "n4", "n5"]:
        c.cut_link("n1", other)
    c.nodes["n1"].propose("b")  # índice 2, termo 2: só n2 recebe
    c.replicate("n1")
    c.deliver()
    check("Figura 8: entrada do termo 2 chega só a n2", lambda: c.nodes["n2"].log.entries == [(1, "a"), (2, "b")]
          and c.nodes["n3"].log.entries == [(1, "a")])
    isolate(c, "n1")
    c.cut_both("n5", "n1")
    c.cut_both("n5", "n2")
    c.elect("n5")  # termo 3, votos de n3 e n4
    c.deliver()
    # n1 segue líder no termo 2 (não sabe da nova eleição): o teste olha n5 diretamente.
    check("Figura 8: n5 eleito no termo 3 com maioria sem n1/n2",
          lambda: c.nodes["n5"].state == "leader" and c.nodes["n5"].term == 3)
    c.nodes["n5"].propose("c")  # índice 2, termo 3, não replicado
    isolate(c, "n5")
    c.heal()
    for x in ["n4", "n5"]:
        c.cut_both("n1", x)
    for x in ["n2", "n3", "n4"]:
        c.cut_both("n5", x)
    c.elect("n1")  # termo 3: n3 já votou em n5, falha
    c.deliver()
    # n5 segue no estado leader (isolado, sem saber que perdeu o cargo): o teste olha o candidato n1.
    check("Figura 8: eleição de n1 no termo 3 falha (n3 votou em n5)", lambda: c.nodes["n1"].state == "candidate")
    c.elect("n1")  # termo 4
    c.deliver()
    check("Figura 8: n1 eleito no termo 4 com n2 e n3", lambda: c.nodes["n1"].state == "leader" and c.nodes["n1"].term == 4)
    check("Figura 8: entrada do termo 2 replicada a n3 (maioria física)",
          lambda: c.nodes["n3"].log.entries == [(1, "a"), (2, "b")])
    check("Figura 8: NÃO commita índice 2 do termo 2 por contagem", lambda: c.nodes["n1"].commit_index == 1)
    c.heal()
    c.nodes["n1"].propose("d")  # índice 3, termo 4
    c.replicate("n1")
    c.deliver()
    c.replicate("n1")
    c.deliver()
    check("Figura 8: entrada do termo 4 commita índices 2 e 3",
          lambda: c.nodes["n1"].commit_index == 3 and all(nd.commit_index == 3 for nd in c.nodes.values()))
    check("Figura 8: n5 descarta entrada conflitante do termo 3",
          lambda: c.nodes["n5"].log.entries == [(1, "a"), (2, "b"), (4, "d")])

    # ---------- partição assimétrica ----------
    c = Cluster(["n1", "n2", "n3"])
    c.elect("n1")
    c.deliver()
    c.cut_link("n2", "n1")
    c.cut_link("n3", "n1")
    c.nodes["n1"].propose("x")
    c.replicate("n1")
    c.deliver()
    check("partição assimétrica: seguidores recebem a entrada", lambda: c.nodes["n2"].log.last_index() == 1
          and c.nodes["n3"].log.last_index() == 1)
    check("partição assimétrica: sem acks o líder não commita", lambda: c.nodes["n1"].commit_index == 0)
    check("partição assimétrica: líder continua líder", lambda: c.nodes["n1"].state == "leader")
    c.heal()
    c.replicate("n1")
    c.deliver()
    check("após curar a partição, commit avança", lambda: c.nodes["n1"].commit_index == 1)

    # ---------- propriedades sob cenários aleatórios ----------


    def random_run(seed, steps=300):
        rng = random.Random(seed)
        c = Cluster(IDS5)
        last_term = {i: 0 for i in IDS5}
        for step in range(steps):
            act = rng.random()
            leaders = c.leaders()
            if act < 0.15:
                c.elect(rng.choice(IDS5))
            elif act < 0.35 and leaders:
                c.nodes[rng.choice(leaders)].propose(f"cmd{step}")
            elif act < 0.55 and leaders:
                c.replicate(rng.choice(leaders))
            elif act < 0.70:
                a, b = rng.sample(IDS5, 2)
                c.cut_link(a, b)
            elif act < 0.80:
                c.heal()
            c.deliver()
            nodes = c.nodes.values()
            leader_terms = Counter(nd.term for nd in nodes if nd.state == "leader")
            if any(v > 1 for v in leader_terms.values()):
                return "dois líderes no mesmo termo"
            for nd in nodes:
                if nd.term < last_term[nd.id]:
                    return "termo regrediu"
                last_term[nd.id] = nd.term
                if nd.commit_index > nd.log.last_index():
                    return "commit além do log"
            for a in nodes:
                for b in nodes:
                    m = min(a.commit_index, b.commit_index)
                    if a.log.entries[:m] != b.log.entries[:m]:
                        return "divergência em entrada commitada"
        return None


    for seed in (1, 2, 3):
        check(f"segurança sob cenário aleatório (seed {seed}): um líder por termo, sem divergência commitada",
              lambda seed=seed: random_run(seed) is None)

    return all(RESULTS)


try:
    ok = main()
except Exception as exc:
    print(f"FAIL setup: {type(exc).__name__}: {exc}")
    sys.exit(1)
sys.exit(0 if ok else 1)
