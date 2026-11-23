# SPEC csvnorm

Três funções em `csvnorm.py`.

## parse_csv(text: str, delimiter: str = ",") -> list[list[str]]
- Registros terminam em `\n`, `\r\n` ou `\r`. Terminador final não cria registro vazio.
- Linha totalmente vazia (sem caracteres) é ignorada.
- Campo que começa com `"` é entre aspas: dentro delas, o delimitador e quebras de linha são literais,
  e `""` representa uma aspa. Aspas só são reconhecidas no início do campo; no meio, são caracteres comuns.
- Aspas não fechadas: `ValueError`.
- Espaços são preservados.

## normalize(header: list[str], rows: list[list[str]], key: str | None = None, types: dict[str, str] | None = None) -> tuple[list[str], list[list]]
- Cabeçalho: `strip()`, minúsculas, sequências de espaços viram `_`. Nomes repetidos após normalização: `ValueError`.
- Cada célula é `strip()`. Tokens `""`, `NULL`, `null`, `N/A` (após strip) viram `None`.
- `types` mapeia coluna normalizada para `"int"`, `"float"` ou `"bool"` (`true`/`yes` -> True, `false`/`no` -> False,
  sem diferenciar maiúsculas). Valor não nulo que não converte: `ValueError`. Sem tipo, o valor fica como `str`.
- Linha com número de células diferente do cabeçalho: `ValueError`. Coluna em `types` ausente do cabeçalho: `ValueError`.
- `key` (coluna normalizada): deduplica por essa coluna. A posição de saída é a da **primeira** ocorrência da chave,
  e os valores são os da **última** ocorrência. Chave nula: `ValueError`. `key` inexistente: `ValueError`.

## dump_csv(header: list[str], rows: list[list], delimiter: str = ",") -> str
- `None` vira campo vazio. `bool` vira `true`/`false`. Demais valores usam `str()`.
- Campo é colocado entre aspas (com `""` para aspas internas) só se contiver o delimitador, aspas, `\r` ou `\n`.
- Linhas terminam em `\n`, inclusive a última.

Não altere este arquivo.
