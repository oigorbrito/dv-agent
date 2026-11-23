"""Interpretador e construção de SSA. Contrato em SPEC.md."""
from cfg import dom_tree, dominance_frontier, idoms, predecessors, reachable, rpo


def _get(env, v):
    if v is None:
        raise ValueError("uso de valor indefinido")
    if v not in env:
        raise ValueError(f"variável indefinida: {v}")
    value = env[v]
    if value is None:
        raise ValueError(f"uso de valor indefinido: {v}")
    return value


def _op(op, a, b):
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    return int(a < b)


def interpret(f, args, fuel=10000):
    env = dict(args)
    label = f["entry"]
    prev = None
    steps = 0
    while True:
        steps += 1
        if steps > fuel:
            raise ValueError("fuel esgotado")
        blk = f["blocks"][label]
        phi_values = {}
        for ins in blk["instrs"]:
            if ins[0] == "phi":
                src = ins[2].get(prev)
                phi_values[ins[1]] = env[src] if (src is not None and src in env) else None
        env.update(phi_values)
        for ins in blk["instrs"]:
            kind = ins[0]
            if kind == "phi":
                continue
            if kind == "const":
                env[ins[1]] = ins[2]
            elif kind == "copy":
                env[ins[1]] = _get(env, ins[2])
            elif kind == "bin":
                env[ins[1]] = _op(ins[2], _get(env, ins[3]), _get(env, ins[4]))
            else:
                raise ValueError(f"instrução desconhecida: {kind}")
        term = blk["term"]
        if term[0] == "ret":
            return _get(env, term[1])
        prev = label
        if term[0] == "jmp":
            label = term[1]
        else:
            label = term[2] if _get(env, term[1]) != 0 else term[3]


def to_ssa(f):
    reach = reachable(f)
    order = [label for label in f["blocks"] if label in reach]
    preds = predecessors(f)
    idom = idoms(f)
    df = dominance_frontier(f, idom)
    tree = dom_tree(f, idom)

    defs = {}
    for p in f["params"]:
        defs.setdefault(p, set()).add(f["entry"])
    for label in order:
        for ins in f["blocks"][label]["instrs"]:
            defs.setdefault(ins[1], set()).add(label)

    phi_vars = {label: [] for label in order}
    for var in sorted(defs):
        dblocks = defs[var]
        if len(dblocks) < 2:
            continue
        work = list(dblocks)
        has = set()
        while work:
            b = work.pop()
            for y in df.get(b, ()):
                if y not in has:
                    has.add(y)
                    phi_vars[y].append(var)
                    if y not in dblocks:
                        work.append(y)

    counter = {}
    stacks = {var: [] for var in defs}
    for p in f["params"]:
        stacks[p].append(p)

    def fresh(var):
        counter[var] = counter.get(var, 0) + 1
        return f"{var}.{counter[var]}"

    def top(var):
        stack = stacks.get(var)
        return stack[-1] if stack else None

    phi_dst = {}
    phi_args = {}
    body = {}
    terms = {}

    def rename(label):
        pushed = []
        for var in phi_vars[label]:
            name = fresh(var)
            phi_dst[(label, var)] = name
            stacks[var].append(name)
            pushed.append(var)
        out = []
        for ins in f["blocks"][label]["instrs"]:
            if ins[0] == "const":
                dst = fresh(ins[1])
                stacks[ins[1]].append(dst)
                pushed.append(ins[1])
                out.append(("const", dst, ins[2]))
            elif ins[0] == "copy":
                src = top(ins[2])
                dst = fresh(ins[1])
                stacks[ins[1]].append(dst)
                pushed.append(ins[1])
                out.append(("copy", dst, src))
            else:
                a, b = top(ins[3]), top(ins[4])
                dst = fresh(ins[1])
                stacks[ins[1]].append(dst)
                pushed.append(ins[1])
                out.append(("bin", dst, ins[2], a, b))
        body[label] = out
        term = f["blocks"][label]["term"]
        if term[0] == "jmp":
            terms[label] = ("jmp", term[1])
        elif term[0] == "br":
            terms[label] = ("br", top(term[1]), term[2], term[3])
        else:
            terms[label] = ("ret", top(term[1]))
        for s in dict.fromkeys(successors_of(label)):
            for var in phi_vars.get(s, []):
                phi_args.setdefault((s, var), {})[label] = top(var)
        for child in tree.get(label, []):
            rename(child)
        for var in reversed(pushed):
            stacks[var].pop()

    def successors_of(label):
        term = f["blocks"][label]["term"]
        if term[0] == "jmp":
            return [term[1]]
        if term[0] == "br":
            return [term[2], term[3]]
        return []

    rename(f["entry"])

    blocks = {}
    for label in order:
        instrs = []
        for var in phi_vars[label]:
            args = {p: phi_args.get((label, var), {}).get(p) for p in preds[label] if p in reach}
            instrs.append(("phi", phi_dst[(label, var)], args))
        instrs.extend(body[label])
        blocks[label] = {"instrs": instrs, "term": terms[label]}
    return {"entry": f["entry"], "params": list(f["params"]), "blocks": blocks}
