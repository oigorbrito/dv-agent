# SPEC semver_resolver

## Versões
`MAJOR.MINOR.PATCH` com pré-release opcional `-ident(.ident)*` (identificadores alfanuméricos ou numéricos).
Versão inválida levanta `InvalidVersion`.

Precedência: `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.10 < 1.0.0-beta < 1.0.0`.
Identificadores numéricos comparam como inteiros e são menores que alfanuméricos; prefixo menor é menor.

## Restrições
- Conjunto de comparadores: termos separados por espaço, todos verdadeiros (AND).
- `A || B`: união de conjuntos (OR).
- Comparadores: `=` (ou sem operador), `>`, `>=`, `<`, `<=`, `^`, `~`.
- `^X.Y.Z`: `>=X.Y.Z <(X+1).0.0` se X > 0; senão `>=0.Y.Z <0.(Y+1).0` se Y > 0; senão `>=0.0.Z <0.0.(Z+1)`.
- `~X.Y.Z`: `>=X.Y.Z <X.(Y+1).0`.
- Pré-release: uma versão com pré-release só satisfaz um conjunto se algum comparador do MESMO conjunto tiver pré-release com a mesma tupla `MAJOR.MINOR.PATCH`.

## Funções
- `satisfies(version: str, constraint: str) -> bool`
- `max_satisfying(versions: Iterable[str], constraint: str) -> str | None`: maior versão que satisfaz, ou `None`.
- `resolve(root: dict[str, str], registry: dict[str, dict[str, dict[str, str]]]) -> dict[str, str]`

`registry[pacote][versão]` é o mapa `{dependência: restrição}` daquela versão.

Algoritmo de `resolve` (determinístico, sem backtracking):
1. Fila FIFO iniciada com as entradas de `root`, na ordem do dict, com solicitante `"<root>"`.
2. Para cada `(pacote, restrição, solicitante)` retirado da fila:
   - Se o pacote já foi escolhido: se a versão escolhida não satisfaz a restrição, levante `ResolutionConflict`.
   - Senão: escolha `max_satisfying(versões do pacote, restrição)`. Se não houver, levante `ResolutionConflict`. Empilhe as dependências da versão escolhida na fila, com solicitante `"pacote@versão"`.
3. Retorna `{pacote: versão}` escolhido.

`ResolutionConflict(Exception)` tem o atributo `package` (nome do pacote em conflito).
Pacote ausente do registro também levanta `ResolutionConflict`.

Não altere este arquivo.
