# SPEC kvdb

Banco chave-valor em disco com Write-Ahead Log (WAL) append-only, transações, savepoints, checkpoints e
recuperação após falha. O diretório do banco contém dois arquivos: `wal.log` e `snapshot.json`.

## WAL (kvdb/wal.py)
- Cada registro é uma linha JSON com chaves ordenadas (`sort_keys=True`, separadores `","` e `":"`), terminada em `\n`.
- `WriteAheadLog(path)`: cria o arquivo se faltar.
- `append(record: dict)`: grava a linha, com flush e fsync, antes de retornar.
- `scan() -> tuple[list[dict], int]`: devolve (registros válidos em ordem, número de bytes válidos).
  - Trecho final sem `\n` é um registro truncado (queda durante a escrita): é ignorado.
  - Linha completa (terminada em `\n`) que não é JSON de objeto válido é corrupção: levanta `CorruptLogError`.
- `truncate_torn_tail() -> bool`: trunca o arquivo nos bytes válidos, removendo o trecho truncado do fim.
  Retorna `True` se truncou. Deve ser chamado antes de qualquer `append` após a abertura.
- `CorruptLogError(Exception)`: definida em `kvdb/wal.py`.

## Banco (kvdb/engine.py)
- `Database(directory)`: cria o diretório se faltar, recupera o estado (ver Recuperação) e fica pronto para uso.
- `TransactionError(Exception)`: definida em `kvdb/engine.py`. Uso indevido de transação levanta esta exceção.
- Chaves são `str`; valores são JSON-serializáveis.
- `get(key)`: valor ou `None`. Dentro de transação enxerga as próprias escritas (inclusive deleções).
- `begin()`: inicia transação. Só uma ativa por vez.
- `set(key, value)`, `delete(key)`, `incr(key, by=1)`: exigem transação ativa. `incr` soma `by` a um valor inteiro;
  chave ausente conta como `0`. Valor existente não inteiro, ou `by` não inteiro, levanta `TransactionError`.
- `savepoint(name)`: marca o estado atual da transação. Exige transação ativa.
- `rollback_to(name)`: desfaz as operações feitas após o savepoint mais recente com esse nome. O savepoint continua
  existindo; savepoints criados depois dele são removidos. Nome inexistente levanta `TransactionError`.
- `commit()`: exige transação ativa. Se houver operações, grava UM registro
  `{"op": "commit", "seq": n, "ops": [...]}` no WAL (com fsync) e só então aplica as operações ao estado.
  Transação sem operações não grava nada e não consome `seq`. Ao final, a transação deixa de estar ativa.
- `abort()`: exige transação ativa e a descarta.
- `checkpoint()`: exige que nenhuma transação esteja ativa. Grava `snapshot.json` com
  `{"last_seq": s, "state": {...}}`, onde `s` é o último `seq` consumido, de forma atômica (arquivo temporário,
  fsync e `os.replace`). O WAL NÃO é truncado nem reescrito.
- `committed() -> dict`: cópia do estado comitado.

Operações registradas em `ops` (já sem as operações desfeitas por rollback):
`{"op": "set", "key": k, "value": v}`, `{"op": "del", "key": k}`, `{"op": "incr", "key": k, "by": n}`.

`seq` começa em 1, cresce 1 por commit gravado e nunca é reutilizado, inclusive após checkpoint.

## Recuperação (ao abrir o banco)
1. Se `snapshot.json` existir, carrega `state` e `last_seq`. Caso contrário, estado vazio e `last_seq = 0`.
2. Lê o WAL com `scan()` e chama `truncate_torn_tail()` ANTES de qualquer escrita.
3. Aplica, em ordem, somente os commits com `seq > last_seq`. Commits com `seq <= last_seq` já estão no snapshot
   e NÃO podem ser reaplicados (`incr` não é idempotente).
4. Transações sem commit gravado não existem no WAL e portanto são descartadas.
5. O próximo `seq` é `max(maior seq visto no WAL, last_seq) + 1`.

Não altere este arquivo.
