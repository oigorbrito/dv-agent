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
    import cfg
    import opt
    import ssa
except Exception as exc:
    print(f"FAIL import: {exc}")
    sys.exit(1)


def fn(entry, params, blocks):
    return {"entry": entry, "params": params, "blocks": blocks}


def blk(instrs, term):
    return {"instrs": instrs, "term": term}


STRAIGHT = fn("B0", [], {"B0": blk([("const", "x", 2), ("const", "y", 3), ("bin", "z", "*", "x", "y")],
                                   ("ret", "z"))})
DIAMOND = fn("B0", ["p"], {
    "B0": blk([], ("br", "p", "T", "F")),
    "T": blk([("const", "x", 1)], ("jmp", "J")),
    "F": blk([("const", "x", 2)], ("jmp", "J")),
    "J": blk([], ("ret", "x")),
})
CONST_DIAMOND = fn("B0", ["p"], {
    "B0": blk([], ("br", "p", "T", "F")),
    "T": blk([("const", "x", 7)], ("jmp", "J")),
    "F": blk([("const", "x", 7)], ("jmp", "J")),
    "J": blk([], ("ret", "x")),
})
LOOP = fn("E0", ["n"], {
    "E0": blk([("const", "i", 0), ("const", "s", 0)], ("jmp", "H")),
    "H": blk([("bin", "c", "<", "i", "n")], ("br", "c", "B", "X")),
    "B": blk([("bin", "s", "+", "s", "i"), ("const", "one", 1), ("bin", "i", "+", "i", "one")], ("jmp", "H")),
    "X": blk([], ("ret", "s")),
})
BRCONST = fn("B0", [], {
    "B0": blk([("const", "c", 1)], ("br", "c", "T", "F")),
    "T": blk([("const", "x", 5)], ("jmp", "J")),
    "F": blk([("const", "x", 9)], ("jmp", "J")),
    "J": blk([], ("ret", "x")),
})
DEAD = fn("B0", [], {"B0": blk([("const", "a", 1), ("bin", "b", "+", "a", "a")], ("ret", "a"))})
INF = fn("L", [], {"L": blk([], ("jmp", "L"))})
UNDEF = fn("B0", [], {"B0": blk([("copy", "a", "zz")], ("ret", "a"))})
LESS = fn("B0", [], {"B0": blk([("const", "a", 3), ("const", "b", 5), ("bin", "c", "<", "a", "b")], ("ret", "c"))})


def raises(fn_):
    try:
        fn_()
    except ValueError:
        return True
    return False


def phis(f, label):
    return [i for i in f["blocks"][label]["instrs"] if i[0] == "phi"]


def last_dst(f, label):
    return f["blocks"][label]["instrs"][-1][1]


def all_instrs(f):
    return [i for b in f["blocks"].values() for i in b["instrs"]]


check("interpretação de código reto", lambda: ssa.interpret(STRAIGHT, {}) == 6)
check("RPO começa em entry e termina na junção", lambda: cfg.rpo(DIAMOND)[0] == "B0" and cfg.rpo(DIAMOND)[-1] == "J")
check("dominadores imediatos do diamante", lambda: cfg.idoms(DIAMOND) == {"B0": "B0", "T": "B0", "F": "B0", "J": "B0"})
check("fronteira de dominância do diamante",
      lambda: cfg.dominance_frontier(DIAMOND, cfg.idoms(DIAMOND)) == {"B0": set(), "T": {"J"}, "F": {"J"}, "J": set()})
check("dominadores imediatos do laço", lambda: cfg.idoms(LOOP) == {"E0": "E0", "H": "E0", "B": "H", "X": "H"})
check("fronteira de dominância do laço",
      lambda: cfg.dominance_frontier(LOOP, cfg.idoms(LOOP))["B"] == {"H"}
      and cfg.dominance_frontier(LOOP, cfg.idoms(LOOP))["H"] == {"H"})
check("árvore de dominância: filhos na ordem de RPO",
      lambda: cfg.dom_tree(LOOP, cfg.idoms(LOOP))["H"] == ["X", "B"]
      and cfg.dom_tree(LOOP, cfg.idoms(LOOP))["E0"] == ["H"])
check("interpretação do laço", lambda: ssa.interpret(LOOP, {"n": 5}) == 10 and ssa.interpret(LOOP, {"n": 0}) == 0)
check("interpretação do diamante", lambda: ssa.interpret(DIAMOND, {"p": 0}) == 2
      and ssa.interpret(DIAMOND, {"p": 1}) == 1)

UNREACH = fn("B0", ["p"], {
    "B0": blk([], ("br", "p", "T", "F")),
    "T": blk([("const", "x", 1)], ("jmp", "J")),
    "F": blk([("const", "x", 2)], ("jmp", "J")),
    "J": blk([], ("ret", "x")),
    "Z": blk([], ("jmp", "J")),
})
check("blocos inalcançáveis ficam fora de reachable, RPO e dominadores",
      lambda: "Z" not in cfg.reachable(UNREACH) and "Z" not in cfg.rpo(UNREACH)
      and "Z" not in cfg.idoms(UNREACH) and cfg.idoms(UNREACH)["J"] == "B0")
check("predecessores incluem todas as arestas do bloco (ordem de aparição)",
      lambda: cfg.predecessors(UNREACH)["J"] == ["T", "F", "Z"])
check("dominates é reflexiva e respeita a árvore",
      lambda: cfg.dominates(cfg.idoms(DIAMOND), "B0", "J") and not cfg.dominates(cfg.idoms(DIAMOND), "T", "J")
      and cfg.dominates(cfg.idoms(DIAMOND), "J", "J"))

diamond_ssa = ssa.to_ssa(DIAMOND)
loop_ssa = ssa.to_ssa(LOOP)
check("SSA do diamante: uma phi só na junção", lambda: len(phis(diamond_ssa, "J")) == 1
      and not phis(diamond_ssa, "T") and not phis(diamond_ssa, "B0"))
check("SSA do laço: exatamente duas phis, no cabeçalho (i e s)",
      lambda: len(phis(loop_ssa, "H")) == 2 and not phis(loop_ssa, "E0") and not phis(loop_ssa, "B")
      and not phis(loop_ssa, "X"))
check("SSA do diamante preserva a semântica",
      lambda: all(ssa.interpret(diamond_ssa, {"p": p}) == ssa.interpret(DIAMOND, {"p": p}) for p in (0, 1)))
check("SSA do laço preserva a semântica",
      lambda: all(ssa.interpret(loop_ssa, {"n": n}) == ssa.interpret(LOOP, {"n": n}) for n in range(7)))
defs = [i[1] for i in all_instrs(loop_ssa)]
check("SSA: cada variável é definida exatamente uma vez", lambda: len(defs) == len(set(defs)))
check("fuel esgotado é ValueError", lambda: raises(lambda: ssa.interpret(INF, {}, fuel=100)))
check("leitura de variável indefinida é ValueError", lambda: raises(lambda: ssa.interpret(UNDEF, {})))
check("< produz 1 ou 0", lambda: ssa.interpret(LESS, {}) == 1)

check("SCCP propaga constantes por bin", lambda: opt.sccp(ssa.to_ssa(STRAIGHT))[last_dst(ssa.to_ssa(STRAIGHT), "B0")]
      == 6)
const_ssa = ssa.to_ssa(CONST_DIAMOND)
check("SCCP: phi com mesma constante em todas as entradas vira constante",
      lambda: opt.sccp(const_ssa)[phis(const_ssa, "J")[0][1]] == 7)
check("SCCP: phi com constantes diferentes vira bottom",
      lambda: opt.sccp(diamond_ssa)[phis(diamond_ssa, "J")[0][1]] == "bottom")
check("SCCP: parâmetros são bottom", lambda: opt.sccp(diamond_ssa)["p"] == "bottom")
brc_ssa = ssa.to_ssa(BRCONST)
check("SCCP: br constante executa só um ramo (phi vira 5)",
      lambda: opt.sccp(brc_ssa)[phis(brc_ssa, "J")[0][1]] == 5)
check("SCCP: definições de ramo não executável ficam fora",
      lambda: brc_ssa["blocks"]["F"]["instrs"][0][1] not in opt.sccp(brc_ssa))

opt_brc = opt.optimize(brc_ssa)
check("optimize remove o ramo morto e o bloco F", lambda: "F" not in opt_brc["blocks"]
      and ssa.interpret(opt_brc, {}) == 5)
check("optimize troca br constante por jmp", lambda: all(b["term"][0] != "br" for b in opt_brc["blocks"].values()))
opt_dead = opt.optimize(ssa.to_ssa(DEAD))
check("optimize elimina instrução morta sem alterar o resultado",
      lambda: all(i[0] != "bin" for i in all_instrs(opt_dead)) and ssa.interpret(opt_dead, {}) == 1)
opt_loop = opt.optimize(loop_ssa)
check("optimize preserva o laço (condição não constante)",
      lambda: opt_loop["blocks"]["H"]["term"][0] == "br"
      and all(ssa.interpret(opt_loop, {"n": n}) == ssa.interpret(LOOP, {"n": n}) for n in range(7)))
opt_dia = opt.optimize(diamond_ssa)
check("optimize preserva o diamante", lambda: all(
    ssa.interpret(opt_dia, {"p": p}) == ssa.interpret(DIAMOND, {"p": p}) for p in (0, 1)))
check("optimize do diamante com constantes iguais vira constante na junção",
      lambda: ssa.interpret(opt.optimize(const_ssa), {"p": 0}) == 7
      and ssa.interpret(opt.optimize(const_ssa), {"p": 1}) == 7)

sys.exit(0 if all(RESULTS) else 1)
