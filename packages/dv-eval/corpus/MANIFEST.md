# Manifesto do corpus calibrado (dv-eval)

Cada tarefa é uma pasta com:
- `task.json`: `schema` (`dv-eval-task-v1`), `id` (igual ao nome da pasta), `tier`, `title`, `prompt`,
  `workspace_dir`, e `oracle` (`dir`, `command`, `timeout_ms`). Tarefas `negative` também trazem `expected_outcome`.
- `workspace/`: estado inicial entregue ao agente (SPEC.md, stubs que levantam `NotImplementedError`, e módulos prontos).
- `oracle/check.py`: oráculo externo oculto. Saída `0` = PASS, `1` = FAIL. Stdlib apenas.
- `offline/strong/` e `offline/cheap/` (opcional, só tarefas positivas): fixtures do provedor faux.
  `strong` é uma implementação de referência; `cheap` é a mesma referência com um bug semântico localizado.
  Usados apenas por `--auth-mode faux`. Nunca são copiados para `workspace/`.

## Tiers

| tier | tarefas | conteúdo |
| --- | --- | --- |
| easy | 5 | parsers, codecs e funções puras de um arquivo |
| medium | 5 | estruturas de dados, grafos/dependências e algoritmos stateful |
| hard | 5 | multi-arquivo com invariantes densos (SQL, CRDT, compilador+VM+GC) |
| frontier | 3 | alta densidade algorítmica e acoplamento cruzado (SSA+SCCP, Raft com partições, Hindley-Milner com linhas); pensado para discriminar Haiku vs Sonnet |
| negative | 1 | controle irresolvível (`negative-01-contradictory-spec`) |

### Regra de seleção
- `--tier all` (padrão) e `--tier easy|medium|hard|frontier`: somente tiers positivos.
- `--tier negative`: somente o controle negativo.
- `--task <id>`: qualquer tarefa, inclusive a negativa.

O controle negativo não entra em agregados `all`. Seu resultado esperado é `unsolved`:
os requisitos do oráculo são mutuamente incompatíveis, então nenhuma implementação pode passar.

## Validação
Toda tarefa positiva satisfaz, antes de ser aceita:
1. o workspace inicial falha no oráculo;
2. a referência (`offline/strong`) passa 100%;
3. cada `offline/cheap` falha, pelo bug que a fixture declara.

A negativa satisfaz (1) e continua falhando com a referência (2 inverso).

## Stubs e segredos
Referências ficam em `offline/`, nunca em `workspace/`. Nenhum `__pycache__`, `.pyc` ou arquivo temporário é versionado.
