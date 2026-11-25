# Estudo de Escalonamento Adaptativo de Harness (Adaptive Harness Scaling)

**Status:** protocolo registrado (estudo offline / GAP-8).  
**Data:** 2026-11-24  
**Branch:** `study/adaptive-harness-scaling`  
**Linha de base:** `feat/harness-router` (`ef1b305`)  
**Contratos:** `contracts/run-accounting-contract-v4.json` (`11b4d545…baef486`) e `contracts/run-accounting-contract-v5.json` (`5029e770…`) 100% preservados e intocados.

---

## 1. Contexto e Motivação

Trabalhos recentes sobre harnesses para agentes de código (Fan et al., 2026, *An Empirical Study of Harness Design for Coding Agents*, arXiv:2609.20804; e síntese em `docs/research/EXTERNAL-FINDINGS-2026.md`) evidenciam duas assimetrias cruciais na interação entre modelos e scaffolds:

1. **Assimetria de Ferramental:** Modelos leves (`haiku`, `flash`, `mini`, `luna`) dependem de kits estruturados com validação tipada e sofrem quando forçados a interfaces genéricas de terminal. Já modelos de fronteira (`sonnet`, `opus`, `terra`, `astra`) dominam `bash` nativamente; ferramentas tipadas extras geram overhead cumulativo de schema, poluição de contexto e turnos intermediários redundantes.
2. **Assimetria de Raciocínio (Effort Scaling):** A alocação estática de esforço de raciocínio (*reasoning effort*) nos degraus de uma escada é subótima. Aplicar raciocínio máximo no primeiro degrau encarece resoluções simples, enquanto omitir raciocínio em degraus leves pode provocar escalonamento desnecessário para modelos de fronteira caros.

Este estudo formaliza a investigação das hipóteses H1 e H2 no framework `dv-agent`, garantindo conformidade rigorosa com a governança contábil v4/v5.

---

## 2. Hipóteses

### Hipótese H1 — Effort Laddering (`provider/model:effort`)
> *A parametrização explícita de reasoning effort por degrau (`:low`, `:medium`, `:high`, `:xhigh`) em políticas de escada permite resolver problemas de complexidade moderada nos degraus iniciais com custo substancialmente inferior ao de modelos de fronteira, sem degradar a taxa de resolução global.*

- **Métrica Primária:** $\Delta \text{total\_tokens}$ e $\Delta \text{cost\_usd}$ pareados por tarefa em relação à escada padrão sem modulação de esforço.
- **Predição:** Degraus leves com `:low`/`:medium` seguidos de `:high` retêm capacidade de resolução com menor consumo de tokens acumulados.

### Hipótese H2 — Perfil de Scaffold Adaptativo por Porte (`--scaffold-mode adaptive`)
> *Ajustar a superfície de ferramentas e a diretriz de sistema conforme a classe do modelo (ferramentas tipadas + diretriz curta de planejamento para modelos leves; modo enxuto `bash`-only para modelos de fronteira) reduz overhead de tokens de sistema e turnos redundantes sem perda de acurácia.*

- **Métrica Primária:** Redução no número total de turnos e tokens em execuções que atingem degraus de fronteira, com taxa de sucesso verificada mantida ou ampliada.
- **Predição:** Modelos de fronteira operando em `bash`-only evitam turnos de leitura/escrita tipada fragmentados; modelos leves com diretriz de planejamento evitam edições precipitadas que disparam falhas precoces.

---

## 3. Células de Comparação

O protocolo define três braços de teste pareados sobre o mesmo conjunto de tarefas e réplicas:

| Braço | Política | Scaffold Mode | Effort Laddering | Descrição |
|---|---|---|---|---|
| **Célula A (`baseline-ladder`)** | `ladder` | `uniform` | Padrão (sem `:effort`) | 4 ferramentas tipadas em todos os degraus; esforço não modulado. |
| **Célula B (`effort-ladder`)** | `ladder` | `uniform` | Explícito (`:low`, `:high`) | 4 ferramentas tipadas em todos os degraus; esforço ajustado por degrau. |
| **Célula C (`adaptive-scaffold-ladder`)** | `ladder` | `adaptive` | Explícito (`:low`, `:high`) | Ferramental e prompt adaptados ao porte (`light` vs. `frontier`) + esforço modulado. |

---

## 4. Partição Fixa de Validação (`holdout` — 9 Tarefas)

A partição de validação foi congelada de forma determinística utilizando a ordenação alfabética dos IDs do corpus e seleção dos índices ímpares (`partitionTaskIds` em `packages/dv-eval/src/bench/routing_calibration.ts`):

1. `easy-02-log-parser` (easy)
2. `easy-04-rle-codec` (easy)
3. `frontier-01-ssa-dominator-opt` (frontier)
4. `frontier-03-incremental-type-infer` (frontier)
5. `hard-02-wal-ledger-replay` (hard)
6. `hard-04-crdt-lww-map` (hard)
7. `medium-01-semver-resolver` (medium)
8. `medium-03-topo-build-planner` (medium)
9. `medium-05-rate-limiter-sliding` (medium)

**Regra Anti-Leakage:** As 9 tarefas do `holdout` são rigorosamente reservadas para avaliação *out-of-sample*. Nenhum resumo ou observação dessas tarefas é admitido em calibração empírica de limiares ou índices históricos de roteamento (`loadRoutingHistory` bloqueia o holdout).

---

## 5. Critérios de Aceitação Pareados (`GAP-8` Bootstrap)

A avaliação estatística entre braços é realizada pelo procedimento de bootstrap pareado por tarefa (`packages/dv-eval/src/bench/paired_bootstrap.ts`):

- **Seed:** `20261124`
- **Reamostragens:** `10.000` réplicas por sorteio bootstrap.
- **Unidade amostral:** Tarefa (réplicas da mesma tarefa permanecem agrupadas).
- **Critérios formais de aceitação:**
  1. **Taxa de Resolução:** $\Delta \text{solve\_rate} = \text{Tratamento} - \text{Baseline}$. O limite inferior do IC 95% não pode ser inferior a $-0{,}05$ (não inferioridade clínica/estatística).
  2. **Consumo de Tokens:** $\Delta \text{total\_tokens} < 0$, com o limite superior do IC 95% comprovando redução estatisticamente significante de tokens.
  3. **Custo USD / Spent Lower Bound:** $\Delta \text{spent\_lower\_bound\_usd} \le 0$ no estimador pontual.
  4. **Conformidade de Contrato:** $100\%$ das execuções em status `PASS` sob o contrato de auditoria (`v4` padrão, `v5` para agy).

---

## 6. Governança e Regras de Execução

1. **Execução 100% Offline:** Todas as validações no pipeline automatizado utilizam `--auth-mode faux`. Nenhuma chamada externa de rede ou consumo de credencial é disparado.
2. **Imutabilidade Contábil:**
   - `contracts/run-accounting-contract-v4.json`: `11b4d5453e0964a7eb88decb5cbf7d1c5f5eebf4fbbdd458fb4e38686baef486`
   - `contracts/run-accounting-contract-v5.json`: `5029e770865a8fdf6c70f1dad9283ff06d8bb6012018d613eb77a2363c3820ad`
3. **Auditoria de Metadados:** O campo `reasoning_effort` e o modo `scaffold_mode` são obrigatoriamente persistidos nos artefatos `summary.json` para rastreabilidade de conformidade.

---

## 7. Validação Offline da Matriz de 4 Braços (2026-11-24)

**Escopo:** `--auth-mode faux` (roteiros determinísticos), zero chamadas a provedores, subconjunto `holdout` (9 tarefas, 1 réplica).
**Aviso:** os desfechos abaixo são **roteiros scriptados**. Medem o encanamento do harness (roteamento, scaffold, contabilidade, métricas), **não** a capacidade dos modelos. Nenhuma hipótese H1/H2 foi testada por este resultado.

| Braço | Configuração (`dv-bench`) | Resolvidas | Tokens |
|---|---|---:|---:|
| A — harness econômico | `single` · `anthropic/claude-haiku-5-5` · `uniform` | 0/9 | 28.600 |
| B — fronteira enxuta | `single` · `anthropic/claude-sonnet-4-6` · `adaptive` | 9/9 | 42.900 |
| C — escada base | `predictive-harness-router` · haiku → sonnet · `uniform` | 9/9 | 57.200 |
| D — adaptativo | `ladder` · `haiku:low, haiku:high, sonnet:medium` · `adaptive` | 9/9 | 100.100 |
| Controle | `single` · sonnet · `uniform` | 9/9 | 42.900 |

**Métricas (`dv-bench-metrics`):** PGR do roteador = 1,000; APGR = 0,500; AIQ do conjunto = 0,643; Pareto = {A, B}.
**Bootstrap pareado** (seed `20261124`, 10.000 reamostragens; um único `single` por comparação, pois o pareamento usa o nome da política):

| Par | Δ solve_rate | Δ tokens (IC 95%) |
|---|---:|---|
| A → D | +1,000 | +7.944 [5.744; 10.389] |
| C → D | 0,000 | +4.767 [3.300; 6.478] |
| B → C | 0,000 | +1.589 [733; 2.567] |
| B → D | 0,000 | +6.356 [4.889; 8.067] |

Com 1 réplica por tarefa, os IC de solve_rate são degenerados (todos os pares são 0 ou ±1 por tarefa) e não permitem inferência.

### Defeitos encontrados e corrigidos durante a validação

1. **`single` offline ignorava `--model`** (sempre `faux-cheap`). Agora o roteiro segue o porte do modelo pedido.
2. **Escada offline escondia o porte real** (`faux-cheap`/`faux-strong` por posição), então o scaffold adaptativo nunca ativava o modo bash-only offline. `ModelRef.tierModelId` preserva o modelo real para classificação; o roteiro faux continua por posição (contrato dos testes existentes).
3. **Fixture bash-only estourava a linha de comando do Windows** (`cmd.exe`, ~8191 caracteres) em arquivos > ~4 KB, o que causava falsas falhas (`hard-02`, `frontier-01`). Os arquivos agora são gravados em blocos de 2 KB; teste executa os comandos e compara os bytes.
4. **Fração forte do roteador era sempre 0 offline**, pois comparava o roteiro faux (`anthropic/faux-strong`) com o modelo real. Cada passo agora grava `requested_model`, usado nas métricas.

### Pendências

- **Seed padrão divergente:** `DEFAULT_PAIRED_BOOTSTRAP_SEED` vale `20261120`, enquanto este protocolo fixa `20261124`. A validação passou `--seed 20261124` explicitamente; o padrão do código não foi alterado.
- **Ruído na fonte do arXiv:** a consulta por palavra-chave (`harness`) traz artigos fora de escopo (robótica). A triagem é manual.
- **Execução live:** depende de autorização explícita e de orçamento de tokens definido pelo operador.

---

## 8. Resultados Live do `holdout` — Matriz de 4 Braços ($N=1$, assinatura)

**Execução:** `runs/holdout-n1-adaptive-20261125T021456Z/` · `--auth-mode subscription` · `--max-tokens 1000000` · 9 tarefas do `holdout` · 1 réplica.
**Bootstrap:** `node scripts/dv-bench-metrics.ts --baseline single --treatment ladder --seed 20261124 <baseline>/summary.json <tratamento>/summary.json` (10.000 reamostragens, unidade = tarefa).
**Degraus de escalonamento:** lidos das linhas por tarefa de cada `summary.md`.

> **Aviso de interpretação.** Com $N=1$, todos os quatro braços resolveram 9/9. A comparação portanto é de **custo em tokens**, não de qualidade. Os IC de `solve_rate` são degenerados (`[0; 0]`) e não permitem inferência sobre acurácia. A execução também não mede custo em USD (`cost_usd: n/a`, autenticação por assinatura), e a conformidade v4 ficou `INCONCLUSIVE` em todas as execuções.

### 8.1 Matriz dos 4 braços

| Braço | Configuração (`dv-bench`) | Resolvidas | Tokens total | easy | medium | hard | frontier | Escalonamentos |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **A** — harness econômico | `single` · haiku-5-5 · `uniform` | 9/9 | 701.300 | 19.651 | 102.702 | 80.769 | 498.178 | — |
| **B** — fronteira enxuta | `single` · sonnet-4-6 · `adaptive` | 9/9 | 2.461.332 † | 59.010 | 400.607 | 426.436 | 1.575.279 † | — |
| **C** — escada base | `ladder` · haiku → sonnet · `uniform` | 9/9 | 828.258 | 28.712 | 88.688 | 113.543 | 597.315 | 0/9 (0%) |
| **D** — escada adaptativa | `ladder` · haiku → sonnet · `adaptive` | 9/9 | 1.409.734 † | 28.397 | 59.176 | 158.096 | 1.164.065 † | 1/9 (11%) |

† `tokens_total` inclui a chamada que cruzou o teto de 1M no grupo (`budget_exceeded`); nenhuma chamada posterior foi enviada.

**Braço D é uma especificação inferida.** O prompt original de execução foi truncado antes da definição do braço D. Usei `ladder` com `--scaffold-mode adaptive` e os mesmos modelos de C.

### 8.2 Detalhamento por tarefa (tokens e degraus acionados)

| Tarefa | Tier | A (single haiku) | B (single sonnet adaptive) | C (ladder uniform) | D (ladder adaptive) |
|---|---|---:|---:|---:|---:|
| easy-02-log-parser | easy | 11.595 | 29.687 | 11.618 | 13.915 |
| easy-04-rle-codec | easy | 8.056 | 29.323 | 17.094 | 14.482 |
| medium-01-semver-resolver | medium | 73.326 | 273.961 | 60.633 | 37.037 |
| medium-03-topo-build-planner | medium | 15.269 | 50.655 | 14.504 | 11.030 |
| medium-05-rate-limiter-sliding | medium | 14.107 | 75.991 | 13.551 | 11.109 |
| hard-02-wal-ledger-replay | hard | 53.371 | 164.647 | 80.624 | 50.896 |
| hard-04-crdt-lww-map | hard | 27.398 | 261.789 | 32.919 | 107.200 |
| frontier-01-ssa-dominator-opt | frontier | 386.728 | 1.008.773 ‡ | 406.414 | 159.407 FAIL → 866.683 PASS |
| frontier-03-incremental-type-infer | frontier | 111.450 | 566.506 | 190.901 | 137.975 |

‡ Chamada que cruzou o teto de 1M (`budget_exceeded`); a tarefa foi resolvida.

**Degraus acionados:**
- **C:** nenhum escalonamento. Todas as 9 tarefas resolveram no degrau 0 (haiku).
- **D:** um escalonamento, em `frontier-01-ssa-dominator-opt`: haiku falhou no oráculo (159.407 tokens) e sonnet passou (866.683 tokens). Total da tarefa: 1.026.090, acima do teto de 1M (`budget_exceeded`).
- **A e B:** sem escalonamento por construção (política `single`).

### 8.3 Bootstrap pareado (seed `20261124`, 10.000 reamostragens)

Diferença = tratamento − baseline. Valores negativos indicam redução.

| Par (baseline → tratamento) | Δ solve_rate (IC 95%) | Δ tokens total (IC 95%) | IC de tokens exclui zero |
|---|---|---|---|
| **B → C** (sonnet adaptive → escada uniform) | 0,000 [0; 0] | **−181.453 [−318.888; −71.508]** | sim (redução) |
| B → D (sonnet adaptive → escada adaptativa) | 0,000 [0; 0] | −116.844 [−212.826; −40.021] | sim (redução) |
| A → D (haiku uniform → escada adaptativa) | 0,000 [0; 0] | +78.715 [−5.976; +225.549] | não (cruza zero) |

Δ `custo USD`: não mensurável (`n/a`, sem valores pareáveis). Δ `spent_lower_bound_usd`: 0 com IC `[0; 0]`.

Para os pares com `single` de um lado, o script usa o resumo `single` como baseline. Os pares A→D e B→D são comparáveis porque cada um tem um único `single`.

### 8.4 Avaliação dos critérios pré-registrados (§5), par B → C

| Critério | Resultado | Status |
|---|---|---|
| 1. IC inferior de Δ solve_rate ≥ −0,05 | 0,000 | atendido |
| 2. Δ tokens < 0 com IC superior < 0 | −181.453; superior −71.508 | atendido |
| 3. Δ spent_lower_bound_usd ≤ 0 | 0 (estimador) | nominalmente atendido; USD não mensurado |
| 4. 100% das execuções PASS sob o contrato | `INCONCLUSIVE` em todas | **não atendido** |

**Conclusão formal:** o protocolo **não aceita** a superioridade de C sobre B. Tokens reduziram, mas a conformidade não foi verificada e o custo em USD não foi medido.

### 8.5 Roteamento (`dv-bench-metrics --weak haiku --strong sonnet`)

| Ponto | Tokens | solve_rate | Fração forte |
|---|---:|---:|---:|
| single haiku (A) | 701.300 | 1,000 | 0,000 |
| single sonnet (B) | 2.461.332 | 1,000 | 1,000 |
| ladder (C) | 828.258 | 1,000 | n/a |

- Fronteira de Pareto (tokens, solve_rate): **single haiku** (domina os demais).
- AIQ do conjunto (x_max = 2.461.332): 0,715.
- PGR e APGR não se aplicam: a escada não é um roteador preditivo, e não há resultado de roteador nesta execução.

### 8.6 Variabilidade entre execuções idênticas (limite de $N=1$)

Duas execuções da mesma matriz (`20261125T015903Z` e `20261125T021456Z`) mostraram padrões diferentes:

| Braço | Execução 1 (015903Z) | Execução 2 (021456Z) |
|---|---|---|
| A tokens | 656.718 | 701.300 |
| B tokens | 2.939.434 | 2.461.332 |
| C tokens | 2.364.277 | 828.258 |
| C escalonamentos | 2/9 (22%) | 0/9 (0%) |
| D escalonamentos | 1/9 (11%) | 1/9 (11%) |

O braço C varia quase 3× em tokens entre execuções, e a taxa de escalonamento muda de 22% para 0%. Esses números não permitem conclusões robustas sobre a escada uniform. Qualquer afirmação sobre custo precisa de mais réplicas.

### 8.7 Recomendação: roteamento híbrido por dificuldade (provisória)

Os dados desta execução sugerem:

1. **Haiku é o ponto de partida para todos os tiers.** Nesta amostra, haiku single (A) resolveu 9/9 e foi o mais barato em `easy`, `hard` e `frontier`. Em `medium`, a escada adaptativa (D, 59.176) foi menor que A (102.702). Sonnet single (B) custou ~3,5× mais que A sem ganho de resolução observável.
2. **Escalonamento para sonnet só após falha no oráculo.** No único caso de falha (frontier-01 em D), o escalonamento custou ~5,4× o degrau haiku. Vale a regra de escalar por falha, mas com um teto de tokens no degrau haiku antes do escalonamento, para não pagar duas vezes uma tarefa difícil.
3. **Tiers `easy`/`medium`:** haiku-only. Em `medium`, o scaffold `adaptive` (perfil leve: kit completo + diretriz de planejamento, braço D) foi o mais barato (59.176 vs 102.702 em A). Em `easy`, A foi o mais barato (19.651 vs 28.397 em D), com diferença pequena em apenas 2 tarefas.
4. **Tiers `hard`/`frontier`:** haiku-first com escalonamento condicional a falha do oráculo, sem sonnet-first. Esta amostra não tem evidência de que sonnet seja necessário nesses tiers.

**Limites desta recomendação:**
- Com $N=1$ e 9/9 em todos os braços, a recomendação mede custo condicionado a sucesso igual, não qualidade relativa de haiku e sonnet.
- Apenas 1 escalonamento ocorreu no holdout, insuficiente para estimar a taxa de falha do haiku por tier.
- O braço C mostrou variância alta entre execuções (§8.6). A recomendação precisa de N≥3 réplicas antes de virar regra.
- Custo em USD e conformidade v4 não foram medidos. A recomendação não atende o critério 4 de §5.

**Próximo passo sugerido:** repetir A, C e D com N=3 no `holdout` e incluir tarefas `frontier` adicionais, com teto de tokens por degrau, antes de definir o limiar de escalonamento.

### 8.8 Consolidação final offline (Marco 1 e Marco 2, N=3)

- **Marco 1:** `tb-jsonl-top-aggregates` falhou por formato de saída: Haiku e Sonnet produziram listas, enquanto o oráculo exige dicionário indexado por usuário. Não foi falha de cálculo; o Sonnet registrou 4 chamadas concluídas com telemetria MEASURED.
- **Fatia v2:** `experiments/p1/external-terminal-bench-slice-v2.json`, validada offline pelo `intake_gate` faux; dataset SHA-256 `86d1d082fa2ebbf010440bed9a0f4aa7d786884e2d094a8a395ad8ce5dc0df5a`. O enunciado passou a exigir `{ \"<user>\": { ... } }`; a v1 permanece preservada.
- **Marco 2 — Sonnet controle:** 27/27 resolvidas; 7.282.572 tokens; telemetria MEASURED.
- **Escada:** 26/27 resolvidas; Δ = −151.293 tokens/tarefa, IC 95% [−263.982; −62.760], seed 20261124 e 10.000 reamostragens. Solve rate −0,037, IC 95% [−0,111; 0].
- **Haiku single e Preditivo live:** 0/27 e INCONCLUSIVE em ambos; ledger aponta HTTP 429 `rate_limit_error` da assinatura OAuth, sem tokens consumidos. APGR, AIQ e fronteira de Pareto ficam pendentes de nova janela de cota.
- O roteador offline faux com histórico de calibração passou 1/1, MEASURED e v4 PASS, registrando `route_decided` com a partição calibration.
