# SPEC ttlcache

`TTLCache(capacity: int, default_ttl: float | None = None, clock: Callable[[], float] | None = None)`

- `capacity` inteiro >= 1 (bool não conta). Senão `ValueError`.
- `default_ttl` > 0 ou `None` (nunca expira). Senão `ValueError`.
- `clock`: função sem argumentos que devolve o tempo atual em segundos (float). Sem `clock`, usar `time.monotonic`.
  O cache nunca dorme nem consulta outro relógio.

## Entradas e expiração
- `put(key, value, ttl=None)`: `ttl` None usa `default_ttl`. `ttl` <= 0: `ValueError`.
  Expira quando `now >= put_time + ttl`. Sem TTL: nunca expira.
  Atualizar uma chave existente substitui valor e TTL, marca a entrada como mais recente e **não** evicta nada.
- `get(key, default=None, refresh=True)`: se a entrada existe e não expirou, conta `hits`, devolve o valor e, se
  `refresh`, marca como mais recente. Se não existe, conta `misses`. Se expirou, remove a entrada, conta `expired`
  e também `misses`, e devolve `default`.
- `peek(key, default=None)`: devolve o valor se vivo, sem estatística, sem recência e sem remover nada.
- `key in cache`: como `peek`, sem estatística.
- `len(cache)`: antes de contar, remove as expiradas (cada uma conta `expired`).

## Capacidade
- Inserir chave nova com o cache cheio: primeiro remove todas as expiradas (cada uma conta `expired`).
  Se ainda estiver cheio, evicta a menos recentemente usada (conta `evictions`).

## stats() -> dict
Cópia de `{"hits", "misses", "expired", "evictions"}`, inteiros.

Módulo: `ttlcache.py` na raiz do workspace. Não altere este arquivo.
