# SPEC planner

Um grafo de alvos é um dict `targets`: nome -> `{"deps": [nomes], "inputs": {caminho: conteúdo_str}}`.
Dependência citada e inexistente em `targets`: `ValueError`.

## find_cycle(targets) -> list[str] | None
- DFS que percorre os nós em ordem lexicográfica e os vizinhos (dependências) em ordem lexicográfica.
- Retorna o caminho do primeiro ciclo encontrado, do nó repetido de volta para ele mesmo.
  Ex.: `a -> b -> c -> a` retorna `["a", "b", "c", "a"]`; auto-dependência `x -> x` retorna `["x", "x"]`.
- Sem ciclo: `None`.

## target_hash(targets, name) -> str
SHA-256 hexadecimal de:
- o nome do alvo;
- cada par `(caminho, conteúdo)` de `inputs`, em ordem de caminho;
- cada par `(dependência, hash da dependência)`, em ordem de nome, **recursivamente** (o hash da dependência
  também inclui as suas dependências).
Assim, mudar um arquivo muda o hash do alvo e de todos os alvos que dependem dele, direta ou transitivamente.
Requer grafo acíclico.

## snapshot(targets) -> dict[str, str]
Mapa nome -> `target_hash` para todos os alvos.

## plan(targets, built) -> list[list[str]]
- `built`: mapa nome -> hash no último build bem-sucedido (ausente = nunca construído).
- Alvo "sujo" é o cujo hash atual difere de `built.get(nome)`.
- Ondas: o nível de um alvo sujo é `0` se nenhuma dependência é suja; senão `1 + max(nível das dependências sujas)`.
  Cada onda é a lista ordenada dos alvos de mesmo nível. Retorna as ondas em ordem crescente de nível.
  Sem alvos sujos: `[]`.
- Ciclo: levanta `CycleError(path)`, com `path` = `find_cycle(targets)`.

## CycleError(Exception)
Atributo `path`: lista do caminho do ciclo. Mensagem: caminho unido por ` -> `.

Módulo: `planner.py` na raiz do workspace. Não altere este arquivo.
