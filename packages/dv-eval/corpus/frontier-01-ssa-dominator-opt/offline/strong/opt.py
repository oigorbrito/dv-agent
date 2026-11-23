"""SCCP e otimização em SSA. Contrato em SPEC.md."""
from cfg import predecessors, rpo, successors  # noqa: F401

BOTTOM = "bottom"
TOP = "top"


def _meet(a, b):
    if a == TOP:
        return b
    if b == TOP:
        return a
    if a == BOTTOM or b == BOTTOM:
        return BOTTOM
    return a if a == b else BOTTOM


def _analyze(f):
    order = rpo(f)
    lat = {}
    exec_blocks = {f["entry"]}
    exec_edges = set()
    for p in f["params"]:
        lat[p] = BOTTOM

    def get(v):
        if v is None:
            return BOTTOM
        return lat.get(v, TOP)

    changed = True
    while changed:
        changed = False

        def setv(d, new):
            nonlocal changed
            old = lat.get(d, TOP)
            merged = _meet(old, new)
            if merged != old:
                lat[d] = merged
                changed = True

        def edge(p, s):
            nonlocal changed
            if (p, s) not in exec_edges:
                exec_edges.add((p, s))
                exec_blocks.add(s)
                changed = True

        for label in order:
            if label not in exec_blocks:
                continue
            blk = f["blocks"][label]
            for ins in blk["instrs"]:
                kind = ins[0]
                if kind == "phi":
                    acc = TOP
                    for p, var in ins[2].items():
                        if (p, label) in exec_edges:
                            acc = _meet(acc, get(var))
                    if acc != TOP:
                        setv(ins[1], acc)
                elif kind == "const":
                    setv(ins[1], ins[2])
                elif kind == "copy":
                    v = get(ins[2])
                    if v != TOP:
                        setv(ins[1], v)
                else:
                    a, b = get(ins[3]), get(ins[4])
                    if a == TOP or b == TOP:
                        continue
                    if a == BOTTOM or b == BOTTOM:
                        setv(ins[1], BOTTOM)
                    else:
                        op = ins[2]
                        val = {"+": a + b, "-": a - b, "*": a * b}.get(op, int(a < b))
                        setv(ins[1], val)
            term = blk["term"]
            if term[0] == "jmp":
                edge(label, term[1])
            elif term[0] == "br":
                c = get(term[1])
                if c == BOTTOM:
                    edge(label, term[2])
                    edge(label, term[3])
                elif c != TOP:
                    edge(label, term[2] if c != 0 else term[3])
    return lat, exec_blocks, exec_edges


def sccp(f):
    lat, _, _ = _analyze(f)
    return {v: x for v, x in lat.items() if x != TOP}


def optimize(f):
    lat, exec_blocks, exec_edges = _analyze(f)
    consts = {v: x for v, x in lat.items() if x != TOP and x != BOTTOM}
    blocks = {}
    for label, blk in f["blocks"].items():
        if label not in exec_blocks:
            continue
        instrs = []
        for ins in blk["instrs"]:
            if ins[0] == "phi":
                srcs = {p: v for p, v in ins[2].items() if (p, label) in exec_edges}
                if ins[1] in consts:
                    instrs.append(("const", ins[1], consts[ins[1]]))
                else:
                    instrs.append(("phi", ins[1], srcs))
            elif ins[1] in consts:
                instrs.append(("const", ins[1], consts[ins[1]]))
            else:
                instrs.append(ins)
        term = blk["term"]
        if term[0] == "br":
            c = lat.get(term[1], BOTTOM)
            if c != BOTTOM and c != TOP:
                term = ("jmp", term[2] if c != 0 else term[3])
        blocks[label] = {"instrs": instrs, "term": term}

    changed = True
    while changed:
        used = set()
        for blk in blocks.values():
            for ins in blk["instrs"]:
                if ins[0] == "copy":
                    used.add(ins[2])
                elif ins[0] == "bin":
                    used.update([ins[3], ins[4]])
                elif ins[0] == "phi":
                    used.update(v for v in ins[2].values() if v is not None)
            term = blk["term"]
            if term[0] == "br":
                used.add(term[1])
            elif term[0] == "ret":
                used.add(term[1])
        changed = False
        for blk in blocks.values():
            kept = [ins for ins in blk["instrs"] if ins[1] in used]
            if len(kept) != len(blk["instrs"]):
                changed = True
                blk["instrs"] = kept
    return {"entry": f["entry"], "params": list(f["params"]), "blocks": blocks}
