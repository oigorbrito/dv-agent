# SPEC ssaopt

Três módulos na raiz do workspace: `cfg.py`, `ssa.py` e `opt.py`. `ssa` importa `cfg`; `opt` importa `ssa`.

## IR
Função: dict `{"entry": L, "params": [var, ...], "blocks": {L: {"instrs": [...], "term": T}}}`.
Blocos são identificados por rótulos (str). `blocks` pode ter blocos inalcançáveis.

Instruções:
- `("const", d, n)`: `d = n` (inteiro).
- `("copy", d, s)`: `d = s`.
- `("bin", d, op, a, b)`: `d = a op b`, com `op` em `+ - * <`. `<` produz `1` ou `0`.
- `("phi", d, {pred: var})`: só existe em SSA. Entradas indexadas pelo bloco predecessor. Uma entrada `None` é valor indefinido.

Terminadores:
- `("jmp", L)`; `("br", v, Lt, Lf)` (vai para `Lt` se `v != 0`, senão `Lf`); `("ret", v)`.

## cfg.py
- `successors(f) -> {L: [sucessores]}`. Para `br`: `[Lt, Lf]`. Para `ret`: `[]`.
- `predecessors(f) -> {L: [predecessores]}`, na ordem de aparição dos blocos em `f["blocks"]`, sem repetição.
- `reachable(f) -> set`: blocos alcançáveis a partir de `entry`.
- `rpo(f) -> [L]`: reverse postorder de um DFS a partir de `entry` que visita sucessores na ordem listada. Só alcançáveis.
- `idoms(f) -> {L: idom}`: dominadores imediatos pelo algoritmo de Cooper–Harvey–Kennedy (iteração até ponto fixo sobre `rpo`). `idom[entry] = entry`. Só alcançáveis.
- `dom_tree(f, idom) -> {L: [filhos]}`: filhos na ordem de `rpo`.
- `dominates(idom, a, b) -> bool`: `a` domina `b` (reflexivo).
- `dominance_frontier(f, idom) -> {L: set}`: para alcançáveis, pelo algoritmo clássico (para cada `B` com ≥2 predecessores alcançáveis, subir de cada predecessor até `idom[B]`).

## ssa.py
- `interpret(f, args: dict, fuel: int = 10000) -> int`: executa a função com os parâmetros em `args`. Phi escolhe a entrada da predecessora por onde o controle chegou; todas as phis de um bloco são avaliadas simultaneamente. Lançar `ValueError` para: variável não definida lida, valor `None` usado, `fuel` esgotado.
- `to_ssa(f) -> f'`: SSA com phis **mínimas**: uma phi só é inserida para uma variável com definições em pelo menos dois blocos (parâmetros contam como definidos no `entry`), nas fronteiras de dominância iteradas dessas definições. Cada variável é definida exatamente uma vez no resultado. Parâmetros mantêm o nome. Demais definições recebem `x.1`, `x.2`, ... por variável, na ordem em que são renomeadas (renomeação pela árvore de dominância). Só blocos alcançáveis, na mesma ordem relativa de `f["blocks"]`. Phi: entradas em ordem de predecessor; entrada sem definição no caminho é `None`.

## opt.py
- `sccp(f) -> {var: int | "bottom"}` (f em SSA): propagação esparsa condicional de constantes. Retorna só variáveis definidas em blocos executáveis. Parâmetros são `"bottom"`. Phi: meet das entradas de arestas executáveis. `br` com condição constante executa um único ramo; com `"bottom"`, ambos; com valor indefinido, nenhum. Constantes se propagam por `bin`/`copy`.
- `optimize(f) -> f'` (f em SSA): usando `sccp`, (1) substitui definições constantes por `("const", d, n)`; (2) troca `br` com condição constante por `jmp`; (3) remove blocos não executáveis e entradas de phi vindas deles; (4) elimina instruções puras (`const`, `copy`, `bin`, `phi`) cujo destino nunca é usado, até ponto fixo. Não altera a semântica.

Não altere este arquivo.
