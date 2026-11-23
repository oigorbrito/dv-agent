# SPEC raft

Simulador determinístico de Raft (sem tempo real: quem dispara eleições e heartbeats é o teste). Três módulos na raiz:
`log.py` (sem dependências), `node.py` (usa `log`) e `cluster.py` (usa `node`).

## log.py — class Log
Índices 1-based. `entries`: lista de tuplas `(term, cmd)`; `entries[i-1]` é o índice `i`.
- `last_index() -> int` (0 se vazio); `last_term() -> int` (0 se vazio).
- `term_at(i) -> int | None`: 0 para `i == 0`; termo do índice `i`; `None` se `i` fora de `[0, last_index]`.
- `append(term, cmd) -> int`: acrescenta e devolve o novo índice.
- `truncate_from(i)`: remove entradas com índice `>= i`.
- `slice_from(i) -> list`: cópia das entradas com índice `>= i`.
- `up_to_date(last_index, last_term) -> bool`: o log do candidato é pelo menos tão atualizado quanto o meu:
  se `last_term != self.last_term()`, vale `last_term > self.last_term()`; senão, vale `last_index >= self.last_index()`.

## node.py — class Node(nid, peers)
`peers`: lista de ids dos demais nós. Atributos públicos: `id`, `peers`, `term` (0), `voted_for` (None),
`state` (`"follower"`, `"candidate"` ou `"leader"`), `leader_id` (None), `log` (Log()), `commit_index` (0),
`votes` (set), `next_index` ({}), `match_index` ({}).

Maioria = `(len(peers) + 1) // 2 + 1`.

Mensagens são dicts com `type`, `term` (termo do remetente), `src`, `dst` e campos próprios:
- `RequestVote`: `last_log_index`, `last_log_term`.
- `VoteResponse`: `granted`.
- `AppendEntries`: `prev_index`, `prev_term`, `entries` (lista de `(term, cmd)`), `leader_commit`.
- `AppendResponse`: `success`, `match_index` (0 quando falha).

Métodos:
- `start_election() -> [msgs]`: `term += 1`, vira candidato, vota em si (`voted_for = id`, `votes = {id}`).
  Devolve `RequestVote` para cada peer, mais o que `_maybe_win` produzir (um cluster de 1 nó vence já).
- `propose(cmd) -> int`: só líder (senão `RuntimeError`). Anexa `(term, cmd)` ao próprio log e devolve o índice. Não envia nada.
- `heartbeat() -> [msgs]`: só líder. Para cada peer, `AppendEntries` com `prev_index = next_index[p] - 1`,
  `prev_term = term_at(prev_index)`, `entries = slice_from(next_index[p])` e `leader_commit = commit_index`.
- `handle(msg) -> [msgs]`:
  - Se `msg.term > term`: vira seguidor nesse termo (`voted_for = None`, `leader_id = None`) antes de tratar a mensagem.
  - `RequestVote`: concede se `msg.term == term`, `voted_for` é `None` ou o candidato, e `log.up_to_date(...)`. Ao conceder, grava `voted_for`. Responde `VoteResponse` com `granted`.
  - `VoteResponse`: se candidato, mesmo termo e `granted`: adiciona aos votos; se atingiu a maioria, `_maybe_win`.
  - `AppendEntries`: se `msg.term < term`, responde falha. Senão vira seguidor (`leader_id = src`) e:
    - falha se `prev_index > last_index` ou `term_at(prev_index) != prev_term`;
    - senão, para cada entrada no índice `i`: se já existe com o mesmo termo, mantém; se existe com termo diferente, trunca de `i` e anexa; se não existe, anexa. `match_index = prev_index + len(entries)`.
    - `commit_index = min(leader_commit, match_index)` se `leader_commit > commit_index`.
  - `AppendResponse` (só líder, mesmo termo): sucesso atualiza `match_index[p]` (máximo) e `next_index[p] = match_index[p] + 1`, depois `_advance_commit`. Falha: `next_index[p] = max(1, next_index[p] - 1)` e devolve um `AppendEntries` imediato para `p`.
- `_maybe_win() -> [msgs]`: se candidato com maioria: vira líder, `next_index[p] = last_index + 1`, `match_index[p] = 0`, e devolve `heartbeat()`.
- `_advance_commit()`: líder. Para o maior `N` em `(commit_index, last_index]` tal que `log.term_at(N) == term`
  **e** `1 + #{p : match_index[p] >= N}` é pelo menos a maioria, faz `commit_index = N`. Entradas de termos anteriores nunca são commitadas por contagem.

## cluster.py — class Cluster(ids)
- `nodes`: `{id: Node(id, peers)}`. `queue`: fila FIFO de mensagens. `cut`: conjunto de links direcionais `(src, dst)` bloqueados.
- `cut_link(a, b)`: bloqueia `a -> b` (só essa direção). `cut_both(a, b)`: bloqueia as duas. `heal()`: remove todos os bloqueios.
- `send(msgs)`: enfileira. `elect(nid)`: `send(nodes[nid].start_election())`. `replicate(nid)`: `send(nodes[nid].heartbeat())`.
- `deliver(limit=100000) -> int`: processa a fila em ordem FIFO. Mensagem cujo link está em `cut` é descartada (`dropped += 1`).
  Senão, `nodes[dst].handle(msg)` e as respostas vão para o fim da fila. Devolve quantas foram processadas. Ultrapassar `limit`: `RuntimeError`.
- `leaders() -> [ids]` ordenados: nós no estado `leader`.

Não altere este arquivo.
