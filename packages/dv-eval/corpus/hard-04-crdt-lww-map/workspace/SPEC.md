# SPEC crdtlib

Estado replicado sem coordenação. Cada réplica tem um identificador `replica: str`. Pacote `crdtlib`:
- `hlc.py`: `HLC`. Relógio híbrido (físico + lógico).
- `vv.py`: `VersionVector`. Relógio vetorial e contexto causal.
- `lwwset.py`: `LWWSet`. LWW-Element-Set com tombstones.
- `ormap.py`: `ORMap`. OR-Map com chaves em tupla (mapas aninhados por prefixo).
- `__init__.py` (pronto): reexporta tudo e define `sync(a, b)` (merge mútuo). Não altere.

## Carimbos (stamps)
Um carimbo é a tupla `(pt: int, lc: int, replica: str)`, comparada lexicograficamente. Carimbos de réplicas
diferentes nunca são iguais; é assim que empates de tempo físico e lógico se resolvem de forma determinística.

## HLC(replica)
- Estado: `pt = 0`, `lc = 0`. Atributo `replica`.
- `now(physical: int) -> stamp`: evento local. Se `physical > pt`: `pt = physical`, `lc = 0`; senão `lc += 1`.
  Devolve `(pt, lc, replica)`. Cada chamada gera carimbo estritamente maior que o anterior da réplica.
- `observe(remote: stamp, physical: int) -> None`: recebe um carimbo remoto (HLC clássico):
  `new = max(pt, remote.pt, physical)`; se `new == pt == remote.pt`: `lc = max(lc, remote.lc) + 1`;
  se `new == pt`: `lc += 1`; se `new == remote.pt`: `lc = remote.lc + 1`; senão `lc = 0`. Depois `pt = new`.

## VersionVector()
- `next(replica) -> int`: incrementa o contador da réplica e devolve o novo valor (começa em 1).
- `covers(dot) -> bool`: `dot = (replica, seq)`; verdadeiro se o contador conhecido de `replica` é `>= seq`.
- `merge(other) -> None`: máximo ponto a ponto.
- `as_dict() -> dict`: cópia.

## LWWSet(replica)
- `add(elem, physical)` e `remove(elem, physical)`: carimbo `hlc.now(physical)`. Gravam `(stamp, presente)`;
  remoção grava tombstone (`presente = False`). Cada elemento tem uma única entrada: a de maior carimbo.
- `merge(other) -> self`: para cada elemento de `other`, adota a entrada dela se o carimbo for maior (ou se o
  elemento não existe localmente). Ao adotar, `hlc.observe(stamp, 0)`.
- `contains(elem) -> bool`, `elements() -> sorted list`.
- `tombstones() -> int`: número de entradas com `presente = False`.
- `compact(floor: stamp) -> int`: remove tombstones com carimbo `<= floor`; devolve quantos removeu.
  Responsabilidade do chamador garantir que `floor` é estável (nenhuma réplica emitirá carimbos `<= floor`).
- `state() -> dict`: cópia `elem -> (stamp, presente)`. Duas réplicas convergidas têm `state()` igual.

## ORMap(replica)
Chaves: tuplas hashables (caminho). Cada chave guarda um conjunto de **dots** `(replica, seq)` com `(stamp, valor)`.
- `put(key, value, physical)`: `stamp = hlc.now(physical)`; `dot = (replica, vv.next(replica))`. Substitui os dots que
  esta réplica observa para `key` por apenas `{dot: (stamp, value)}`.
- `remove(key)`: descarta os dots observados para `key` nesta réplica.
- `remove_prefix(prefix)`: `remove` para toda chave cujo início é `prefix` (remoção de subárvore).
- `get(key, default=None)`: valor do dot de maior carimbo; `default` se não há dots.
- `conflicts(key) -> int`: número de dots (valores concorrentes) para `key`.
- `keys() -> sorted list`, `items() -> sorted list of (key, valor)`, `to_dict() -> dict`.
- `subtree(prefix) -> dict`: `{chave[len(prefix):]: valor}` para chaves com início `prefix`.
- `merge(other) -> self` (semântica OR-Set com contexto causal): para cada chave, um dot `d` é mantido se
  (a) está nas duas réplicas, ou (b) está só em uma e a outra **não** o conhece (`not other_vv.covers(d)`).
  Dots que a outra réplica conhece e não possui foram removidos concorrente/anteriormente, e são descartados.
  Depois, `vv` recebe o máximo ponto a ponto, e `hlc.observe(stamp, 0)` é chamado para cada carimbo de `other`.
- `state() -> list`: forma canônica (chaves ordenadas, dots ordenados) para comparar convergência.

## Garantias exigidas
- `merge` é comutativo, associativo e idempotente (em termos de `items()`/`state()`).
- Um `put` concorrente com um `remove` sobrevive ao remove (add-wins); dois `put`s concorrentes geram dois dots e
  `get` escolhe deterministicamente o de maior carimbo.

Não altere este arquivo.
