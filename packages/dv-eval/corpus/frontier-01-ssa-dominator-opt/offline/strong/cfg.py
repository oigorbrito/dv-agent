"""Grafo de fluxo de controle. Contrato em SPEC.md."""


def successors(f):
    out = {}
    for label, blk in f["blocks"].items():
        term = blk["term"]
        if term[0] == "jmp":
            out[label] = [term[1]]
        elif term[0] == "br":
            out[label] = [term[2], term[3]]
        else:
            out[label] = []
    return out


def predecessors(f):
    succ = successors(f)
    preds = {label: [] for label in f["blocks"]}
    for label in f["blocks"]:
        for s in succ[label]:
            if label not in preds[s]:
                preds[s].append(label)
    return preds


def reachable(f):
    succ = successors(f)
    seen = set()
    stack = [f["entry"]]
    while stack:
        label = stack.pop()
        if label in seen:
            continue
        seen.add(label)
        stack.extend(succ[label])
    return seen


def rpo(f):
    succ = successors(f)
    seen = set()
    post = []

    def dfs(label):
        seen.add(label)
        for s in succ[label]:
            if s not in seen:
                dfs(s)
        post.append(label)

    dfs(f["entry"])
    return list(reversed(post))


def idoms(f):
    order = rpo(f)
    index = {label: i for i, label in enumerate(order)}
    preds = predecessors(f)
    idom = {f["entry"]: f["entry"]}

    def intersect(a, b):
        while a != b:
            while index[a] > index[b]:
                a = idom[a]
            while index[b] > index[a]:
                b = idom[b]
        return a

    changed = True
    while changed:
        changed = False
        for label in order[1:]:
            done = [p for p in preds[label] if p in idom]
            if not done:
                continue
            new = done[0]
            for p in done[1:]:
                new = intersect(p, new)
            if idom.get(label) != new:
                idom[label] = new
                changed = True
    return idom


def dom_tree(f, idom):
    order = rpo(f)
    children = {label: [] for label in idom}
    for label in order:
        if label != f["entry"]:
            children[idom[label]].append(label)
    return children


def dominates(idom, a, b):
    node = b
    while True:
        if node == a:
            return True
        parent = idom[node]
        if parent == node:
            return False
        node = parent


def dominance_frontier(f, idom):
    preds = predecessors(f)
    reach = reachable(f)
    df = {label: set() for label in reach}
    for b in reach:
        ps = [p for p in preds[b] if p in reach]
        if len(ps) >= 2:
            for p in ps:
                runner = p
                while runner != idom[b]:
                    df[runner].add(b)
                    runner = idom[runner]
    return df
