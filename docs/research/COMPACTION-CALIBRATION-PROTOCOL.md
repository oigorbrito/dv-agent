# Protocolo de calibração da compactação intra-degrau (pré-registrado)

Status: **pré-registrado, não executado**. Qualquer rodada live depende de autorização explícita do operador e de janela de cota.
Mudanças nas regras ou nos critérios de decisão, feitas depois de ver resultados, invalidam este protocolo. Mudança exige nova versão do documento.

## 1. Pergunta

Uma compactação das saídas antigas de ferramenta, calibrada por porte de modelo, reduz tokens por tarefa sem reduzir a taxa de resolução?

## 2. Partição

- **Calibração (esta rodada):** 9 tarefas de índice par na ordem alfabética do corpus. Só elas entram na decisão.
  `easy-01-calc, easy-03-csv-normalizer, easy-05-slug-dedup, frontier-02-raft-consensus-sim, hard-01-mini-ini-ast, hard-03-mini-sql-engine, hard-05-bytecode-vm-gc, medium-02-interval-scheduler, medium-04-lru-ttl-cache`
- **Holdout:** 9 tarefas de índice ímpar. **Não são lidas nesta calibração.** Elas servem para a avaliação final (Marco 2, N=3), que usa o protocolo do `STUDY-ADAPTIVE-HARNESS-SCALING.md`.

## 3. Braços

Um braço por modelo e por regra. Dentro de um modelo, os braços diferem só em `--compaction`.

| Braço | Modelo (porte) | `--compaction` | Regra aplicada |
| :--- | :--- | :--- | :--- |
| C0 | haiku-5-5 (economy) | `off` | nenhuma |
| C1 | haiku-5-5 (economy) | `by_model` | `economy`: 8 saídas intactas, limite 8000 caracteres |
| C0' | sonnet-4-6 (standard) | `off` | nenhuma |
| C1' | sonnet-4-6 (standard) | `by_model` | `standard`: 5 saídas intactas, limite 3000 caracteres |

Fora do escopo desta rodada: `frontier`. Não há braço frontier na calibração, então a regra `frontier` continua **sem validação**. Ela não deve ser apresentada como calibrada.

Parâmetros fixos para todos os braços: `--repeats 3`, `--policies single`, `--auth-mode subscription`, `--max-tokens` explícito (2.500.000 para haiku, 4.000.000 para sonnet), um braço por vez, `--outdir` novo.

## 4. Métricas e análise

- `solve_rate` por braço (9 tarefas × 3 réplicas = 27 runs).
- Tokens por tarefa, pareados por tarefa.
- Para cada modelo, comparação C1 − C0 (e C1' − C0') com `dv-bench-metrics.ts --baseline single --treatment <rótulo>`, seed `20261124`, 10.000 reamostragens.

## 5. Critério de decisão (fixado agora)

Uma regra é **adotada** para um porte se, e somente se, as duas condições valem:

1. IC 95% do Δ de tokens por tarefa **inteiro abaixo de zero** (limite superior < 0).
2. Δ pontual de `solve_rate` **não negativo** (≥ 0).

Caso contrário, a regra não é adotada e o porte fica com `off`. Não há regra de adoção por "parece ter funcionado". Com 9 tarefas, a incerteza é grande, e o resultado deve ser lido como sugestivo.

## 6. Limites declarados antes da coleta

- 9 tarefas e 3 réplicas: o IC é largo, e um resultado positivo pode não se repetir.
- O faux não mede qualidade. O efeito só pode ser medido em rodadas live.
- O custo de tokens conta `total_tokens`, que inclui leitura e escrita de cache. Compactação reduz o contexto enviado, mas o efeito no cache pode ser diferente do efeito no contexto. Esse detalhe deve ser reportado junto com o número.
- Fronteira não é calibrada (seção 3).

## 7. Comandos (somente após autorização)

Exemplo para o braço C1 (economy). Os outros braços trocam apenas o modelo, o `--compaction` e o `--outdir`:

```
node scripts/dv-bench.ts --auth-mode subscription --max-tokens 2500000 --repeats 3 \
  --policies single --model anthropic/claude-haiku-5-5 --compaction by_model \
  --tasks easy-01-calc,easy-03-csv-normalizer,easy-05-slug-dedup,frontier-02-raft-consensus-sim,hard-01-mini-ini-ast,hard-03-mini-sql-engine,hard-05-bytecode-vm-gc,medium-02-interval-scheduler,medium-04-lru-ttl-cache \
  --outdir runs/cal-compaction-C1-haiku-<timestamp>
```

Cada resumo grava `harness_variant` com `+compaction:<porte>` nos ledgers, e a impressão digital do scaffold. Assim a comparação só vale se o único fator variável for o `--compaction`.
