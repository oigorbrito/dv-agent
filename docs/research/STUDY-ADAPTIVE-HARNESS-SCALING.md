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
