# SPEC minisql

Motor SQL em memória (subconjunto). Pacote `minisql` com quatro módulos a implementar e um pronto:
- `tokenizer.py`: `SQLError` e `tokenize(sql)`.
- `parser.py`: `parse(sql) -> dict` (AST).
- `storage.py`: classe `Table` com linhas e índices hash.
- `planner.py`: `execute(db, sql) -> (colunas, linhas)` e `explain(db, sql) -> list[str]`.
- `__init__.py` (pronto): `Database`, `Result`, reexporta `SQLError`. Não altere.

## Léxico
- Palavras-chave, sem diferenciar maiúsculas: `SELECT FROM WHERE INNER LEFT JOIN ON AND OR GROUP BY HAVING ORDER ASC DESC NULLS LAST AS NULL`.
- Identificadores: `[A-Za-z_][A-Za-z0-9_]*` que não sejam palavra-chave (mantêm o caso).
- Inteiros (sem sinal; o sinal é tratado pelo parser). Strings `'...'`, com `''` representando `'`.
- Símbolos: `( ) , * . = < <= > >= != -`. `<>` é o mesmo que `!=`.
- Qualquer outro caractere, ou string não fechada: `SQLError`.

## Gramática
```
SELECT item [, item]* FROM tab [alias]
  [ [INNER|LEFT] JOIN tab [alias] ON expr ]
  [WHERE expr] [GROUP BY ref [, ref]*] [HAVING expr]
  [ORDER BY operando [ASC|DESC] [NULLS LAST] [, ...]*]
item      := *  |  operando [AS nome]
operando  := ref | FUNC(ref) | COUNT(*) | literal
ref       := coluna | tab.coluna        (tab = alias da fonte, ou o nome da tabela se não houver alias)
FUNC      := COUNT | SUM | AVG | MIN | MAX      (* só em COUNT)
literal   := [-]inteiro | 'texto' | NULL
expr      := conj (OR conj)*
conj      := pred (AND pred)*             (AND tem precedência sobre OR)
pred      := ( expr ) | operando op operando
op        := = | != | < | <= | > | >=
```
`parse` levanta `SQLError` para qualquer violação da gramática. A AST é livre (é detalhe interno).

## Semântica
- **Fontes**: sem JOIN, a tabela. Com JOIN, linhas em produto por par `(esquerda, direita)`.
  INNER: pares em que `ON` é verdadeiro. LEFT: além disso, cada linha da esquerda sem par gera uma linha com NULLs
  nas colunas da direita. A ordem é a da esquerda, e para cada uma, a da direita (ordem de inserção).
- **Resolução de coluna**: `tab.coluna` exige alias/nome existente. Sem qualificador, o nome deve existir em exatamente
  uma fonte: nenhuma -> `SQLError`; duas -> `SQLError` (ambígua).
- **NULL**: qualquer comparação com NULL é falsa (inclusive `!=` e `= NULL`). `WHERE` e `HAVING` mantêm só linhas
  cuja expressão é verdadeira.
- **Comparação**: entre valores de tipos diferentes (int e str): `SQLError`.
- **SELECT sem agregação**: projeção por linha. `*` sem JOIN produz as colunas da tabela (nome simples).
  `*` com JOIN produz `alias.coluna` para todas as colunas das duas fontes, nessa ordem.
- **Nome de saída**: `AS nome` tem precedência; senão, a coluna é o texto da referência como escrita (`u.name` ou `name`);
  para agregação, `FUNC(arg)` com o argumento como escrito (`COUNT(*)`, `SUM(o.amount)`); literal: `str(valor)` ou `NULL`.
- **Agregação**: existe se há GROUP BY ou alguma função de agregação em itens ou HAVING.
  - Linhas são agrupadas pelos valores das colunas do GROUP BY (NULL forma um grupo próprio). Grupos saem na ordem da primeira aparição.
  - Sem GROUP BY, há um único grupo com todas as linhas, mesmo que vazio (produz exatamente uma linha).
  - Item não agregado precisa ser coluna do GROUP BY: senão `SQLError`. `*` em agregação: `SQLError`.
  - `COUNT(*)` conta linhas. `COUNT(ref)` conta valores não nulos. `SUM`/`AVG` exigem inteiros (senão `SQLError`) e ignoram NULL;
    sem valores não nulos, `SUM`, `AVG`, `MIN` e `MAX` valem NULL. `AVG` é float. `MIN`/`MAX` aceitam inteiros ou strings.
  - `HAVING` é avaliado por grupo; pode usar agregações (recalculadas no grupo) e colunas do GROUP BY.
- **ORDER BY**: cada operando deve casar com um item da lista de seleção (mesma expressão escrita igual, ou, para
  `ref` sem qualificador, o nome de saída) senão `SQLError`. Ordenação estável. **NULLs ficam sempre por último**,
  em ASC e em DESC. Vários operandos: prioridade da esquerda para a direita.
- **explain(db, sql)**: lista de passos. Primeiro passo: `INDEX_LOOKUP tabela.coluna` se a consulta não tem JOIN,
  tem um predicado de nível superior `coluna = literal` (não NULL) sobre coluna indexada, e todos os valores não nulos
  dessa coluna têm o mesmo tipo do literal; senão `SEQ_SCAN tabela`. Depois: `NESTED_LOOP_<INNER|LEFT>_JOIN tabela`
  se há JOIN, `FILTER` se há WHERE, `GROUP_AGGREGATE` se há agregação, `SORT` se há ORDER BY.
- **Índice**: `Table.create_index(coluna)` indexa valores não nulos. Consultas devem retornar o mesmo resultado com ou sem índice.

## storage.py
- `Table(name, columns)`: colunas nomes distintos (senão `SQLError`). `rows`: lista de tuplas, em ordem de inserção.
- `insert(row)`: tamanho diferente de `columns`: `SQLError`.
- `create_index(column)`, `has_index(column)`, `lookup(column, value)`: posições (ordem crescente) das linhas com
  aquele valor. `lookup(c, None)` devolve `[]`.

Não altere este arquivo.
