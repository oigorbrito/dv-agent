# Relatório de benchmark — dv-agent

Consolidação da trajetória empírica do projeto. Todos os números de desempenho vêm dos `summary.json` em `runs/`,
lidos por um script que reaproveita a função `wilsonInterval` do próprio bench. Os tokens de entrada do primeiro
turno vêm dos ledgers. Onde um número citado no pedido não pôde ser verificado no repositório, isso está dito
explicitamente na seção 6.

## 1. Resumo

- **Rodada holdout N=3 (seção 9, auditada):** o roteador resolveu 27/27 com 5,0 M tokens; o Sonnet, 26/27 com 9,3 M. A economia de tokens frente ao Sonnet é sustentada pelo bootstrap; a vantagem de resolução, não.
- **Governança do contrato v4 funciona de ponta a ponta.** Nenhuma violação estrutural nos ledgers de todas as
  rodadas. Em subscription a conformidade é `INCONCLUSIVE` por regra (c), porque o teto de custo em USD não é
  verificável.
- **Escalonamento real observado, uma vez.** Em `frontier-03-incremental-type-infer`, o degrau 0 (Haiku 5.5)
  reprovou 3/3 e o degrau 1 (Sonnet 4.6) resolveu 3/3 no mesmo experimento.
- **Medição mais limpa após os guards.** Depois da parada estrita (`2a8caef`), não há mais chamadas fantasmas:
  `calls_started == calls_finished` nos runs posteriores. A telemetria ficou `MEASURED` em todas as políticas da
  rodada frontier.
- **Custo de tokens é alto e o intervalo de confiança é largo.** Com n=9 por célula, o intervalo de Wilson 95%
  de `single` (66,7%, [35,4%; 87,9%]) se sobrepõe ao de `ladder` e `architect-editor` (100%, [70,1%; 100%]). A
  diferença entre eles **não é estatisticamente sustentada**.
- **Limites de variância.** A temperatura **não é aplicada ao Haiku 5.5** (`compat.supportsTemperature=false`).
  Parte da variância entre réplicas do Haiku não é controlável pelo harness.
- **O modelo `gpt-6.1-luna` está registrado no catálogo local, mas não é aceito por esta conta ChatGPT** (probe
  live, seção 5).

## 2. Arquitetura e proveniência

| Componente | Origem (verificada) | Evidência |
| --- | --- | --- |
| `packages/dv-core` (ledger v2, guards, políticas, `executeRung`) | Autoral neste repositório | Histórico git desde `dd6d72e` |
| `packages/dv-eval` (oráculo, probe, smoke, bench, corpus) | Autoral neste repositório | Histórico git |
| Contrato `p1-run-accounting-v4` | Copiado byte a byte do `dv-baseline` (oigorbrito/dv), SHA-256 `11b4d545…` | `contracts/PROVENANCE.json` |
| `packages/runtime-pi/` (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-schema`, `pi-telemetry`) | Fonte vendorizada de `badlogic/pi-mono` (MIT), commit fixado | `UPSTREAM_PIN.json` e `README.md` |
| Inspiração em Aider e OpenCode | **Não documentada no repositório.** O único vínculo encontrado é o provedor `opencode` do `pi-ai`, que é outro componente. Não afirmo essa proveniência. | busca em `README.md`, `AGENTS.md`, `docs/` |

**Overhead de transporte.** O pedido citava "~48k–99k tokens no `dv-baseline` → ~6,8k no `dv-agent`". Esses valores
**não aparecem** no repositório nem no `dv-baseline`. O único dado documentado no baseline é "cada turno do CLI
consumiu de ~10 mil a ~89 mil tokens" (`dv-baseline/README.md`), que não é a mesma métrica. O que medi no
`dv-agent` foram os tokens de entrada do **primeiro turno** (`prompt_tokens`, dos ledgers de runs reais):

| Papel do passo | Modelo | Mediana | n | Faixa |
| --- | --- | --- | --- | --- |
| executor / degrau 0 | claude-haiku-5-5 | 1.192 | 24 | 1.135–1.243 |
| editor | claude-sonnet-4-6 | 1.289 | 33 | 1.207–1.396 |
| architect (sem ferramentas) | claude-haiku-5-5 | 92 | 24 | 92 |

Sem uma medição equivalente do baseline no mesmo protocolo, **não há fator de redução verificável**.

## 3. Metodologia

- **Medição:** tokens e custo vêm dos eventos `call_finished` de cada ledger. A conformidade vem do verificador
  v4 (`checkLedgerConformance`).
- **Intervalo de confiança:** Wilson 95% (z = 1,96) sobre `solved/runs`. Foi escolhido em vez de Wald porque Wald
  é degenerado em 0/n e n/n.
- **pass^k:** tarefas resolvidas em todas as réplicas, `tarefas_todas/tarefas`.
- **Temperatura:** pedida como `0` no experimento frontier. O bench declara por modelo se ela foi aplicada, pela
  regra do adaptador (`compat.supportsTemperature ?? true`).
- **Limites do editor:** `maxTurns` e `maxOutputTokens` configuráveis. Nas rodadas abaixo, o teto foi 16 turnos
  (`hard-ae-fixed`) e 32 turnos (frontier), com 32000 tokens de saída.

## 4. Ablações reais

Solve rate com intervalo de Wilson 95%. Tokens são o `tokens_total` (prompt + completion, incluindo cache).

### 4.1 Medium (`runs/bench-2026-11-23T11-55-54-579Z`, summary v1, subscription)

| política | tier | resolvidas | solve_rate | ci_95 | tokens | telemetria | conformidade |
| --- | --- | --- | --- | --- | --- | --- | --- |
| single | medium | 1/2 | 50,0% | [9,4%; 90,5%] | 59.975 | MEASURED | PASS |
| ladder | medium | 1/2 | 50,0% | [9,4%; 90,5%] | 86.069 | MEASURED | PASS |

O ladder escalou em 1 de 2 runs (`escalation_rate` 0,5). Este resumo é do formato v1, sem o campo de IC: o IC foi
calculado pela mesma função sobre `solved/runs`.

### 4.2 Hard, n = 5 (`runs/bench-hard-n5-20261123T125602Z`)

| política | resolvidas | solve_rate | ci_95 | tokens | telemetria | conformidade |
| --- | --- | --- | --- | --- | --- | --- |
| single | 5/5 | 100,0% | [56,5%; 100,0%] | 1.239.270 | INCONCLUSIVE | INCONCLUSIVE |
| ladder | 5/5 | 100,0% | [56,5%; 100,0%] | 804.338 | MEASURED | INCONCLUSIVE |
| architect-editor | 3/5 | 60,0% | [23,1%; 88,2%] | 322.539 | INCONCLUSIVE | INCONCLUSIVE |

**Atenção:** esta rodada é **anterior** à parada estrita (`2a8caef`). O `INCONCLUSIVE` do `single` vem dos registros
fantasmas que essa correção eliminou. O `architect-editor` aqui usou o teto de 8 turnos e 8000 tokens de saída
(`EDITOR_LIMITS` antigo), o que cortou o editor.

### 4.3 Hard, architect-editor com tetos revisados (`runs/bench-hard-ae-fixed-20261123T164953Z`)

| política | resolvidas | solve_rate | ci_95 | tokens | telemetria | conformidade |
| --- | --- | --- | --- | --- | --- | --- |
| architect-editor (16 turnos, 32000 de saída) | 3/5 | 60,0% | [23,1%; 88,2%] | 1.283.882 | INCONCLUSIVE | INCONCLUSIVE |

Em 6 de 8 steps do editor o limite de 16 turnos disparou (incluindo ambos os steps de `hard-03` e `hard-05`). A telemetria ficou `INCONCLUSIVE` por **um único erro
real do provedor** (`provider_error` em `hard-04`, sem `usage`), registrado corretamente como `usage_not_reported`.
Não é o guard.

### 4.4 Negativo (`runs/bench-negative-20261123T164953Z`, teto de tokens 120.000)

| política | resolvidas | solve_rate | ci_95 | tokens | telemetria | conformidade |
| --- | --- | --- | --- | --- | --- | --- |
| single | 0/1 | 0,0% | [0,0%; 79,3%] | 14.852 | MEASURED | INCONCLUSIVE |
| ladder | 0/1 | 0,0% | [0,0%; 79,3%] | 50.191 | MEASURED | INCONCLUSIVE |

A tarefa irresolvível foi reprovada pelo oráculo, sem falso positivo. O ladder escalou para o Sonnet, que também
reprovou. **Nenhum run foi cortado por guard**: o modelo parou sozinho, em `completed`. O controle negativo não
exercitou `doom_loop` nem `budget_exceeded`.

### 4.5 Frontier, 3 tarefas × 3 réplicas (`runs/bench-frontier-rep3-20261123T180816Z`, temperatura 0, teto de tokens 1,5 M)

| política | resolvidas | solve_rate | ci_95 | tokens | escalation | pass^k | telemetria | conformidade |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single | 6/9 | 66,7% | [35,4%; 87,9%] | 1.437.337 | - | 1/3 | MEASURED | INCONCLUSIVE |
| ladder | 9/9 | 100,0% | [70,1%; 100,0%] | 3.785.632 | 0,33 (3/9) | 3/3 | MEASURED | INCONCLUSIVE |
| architect-editor | 9/9 | 100,0% | [70,1%; 100,0%] | 4.973.528 | - | 3/3 | MEASURED | INCONCLUSIVE |

Por tarefa (resolvidas de 3): `single` = 2 / 3 / 1; `ladder` = 3 / 3 / 3; `architect-editor` = 3 / 3 / 3, na ordem
`frontier-01`, `frontier-02`, `frontier-03`.

## 5. Achados

**5.1 Escalonamento real.** Em `frontier-03`, o Haiku reprovou nas três réplicas do degrau 0 do ladder, e o Sonnet
resolveu as três no degrau 1. É o único caso de escalonamento observado com sucesso nas rodadas reais.

**5.2 Mas o mesmo modelo varia de forma incompatível.** Em `frontier-03`, o Haiku resolveu 1/3 no `single` e 0/3 no
degrau 0 do ladder. Com n=3, isso é compatível com ruído. Em `frontier-01` ocorre o inverso: 2/3 no `single` e 3/3 no
degrau 0.

**5.3 Trade-off de tokens.** Ladder e architect-editor resolveram 9/9, com 3,79 M e 4,97 M de tokens. O editor
gasta cerca de 31% a mais e cerca de 3,5× o `single`, que resolveu 6/9. O custo do architect-editor vem sobretudo
do editor, que reenvia o contexto em cada turno.

**5.4 Os tetos do editor cortam a verificação final.** Em `frontier` (32 turnos e 32000 de saída), 5 de 12 steps do
editor foram cortados: 2 por `max_output_tokens` e 3 por `max_turns`. Em `hard-ae-fixed` (16 turnos), 6 de 8 steps
foram cortados. Vários cortes ocorreram depois de a solução já passar no oráculo. O teto está interrompendo a
verificação e não a implementação. Não há controle sem teto, então a causalidade não está isolada.

**5.5 Variância residual do Haiku.** `claude-haiku-5-5` tem `compat.supportsTemperature = false` no catálogo. Por isso
`--temperature 0` é descartado para ele, e as células com Haiku (`single`, degrau 0 do ladder e architect) não tiveram
controle de amostragem. Só o Sonnet recebeu temperatura 0.

**5.6 Telemetria.** Antes de `2a8caef`, a telemetria apresentava `INCONCLUSIVE` por chamadas `aborted` com `usage = 0`
enviadas depois do corte. Essas chamadas não são mais enviadas: nos runs posteriores,
`calls_started == calls_finished`. Em subscription a conformidade continua `INCONCLUSIVE` por regra (c).

## 6. Limitações e afirmações não verificadas

- **n pequeno.** Com 9 execuções por célula, os intervalos de Wilson se sobrepõem entre políticas. Nenhuma diferença
  entre `single`, `ladder` e `architect-editor` é estatisticamente sustentada nas rodadas frontier.
- **Pré-correções.** `medium` é formato v1, e `hard-n5` e `hard-ae-fixed` são anteriores à parada estrita. Os números
  deles são reportados, mas não são comparáveis diretamente às rodadas posteriores.
- **Custo não verificável.** Em subscription `cost_usd` é `n/a` e o teto de custo é `unverifiable`. Só o teto de
  tokens limita o uso.
- **Negativo não exercitou os guards.** Não há evidência de `doom_loop` ou `budget_exceeded` atuando em tarefa
  irresolvível.
- **Números do pedido não verificados:** "~48k–99k → ~6,8k" de overhead de transporte (seção 2).
- **`HarnessRouter` (HR) não existe no repositório.** Hoje a escolha de política é feita pelo `RouterPolicy` em
  `packages/dv-core/src/router/policy.ts`, com três implementações (`SingleModelPolicy`,
  `ExecutionGuidedLadderPolicy` e `ArchitectEditorPolicy`). Um roteador adaptativo que escolheria política por tier
  e por telemetria é trabalho futuro. Ele dependeria de medições com n maior para ter critério de decisão.

## 7. Modelo `gpt-6.1-luna` (catálogo `openai-codex`)

- Registrado no catálogo local com os metadados de `gpt-6-luna` (API `openai-codex-responses`, janela de 272.000 e
  mesmos preços). O pedido citava `codex-responses`, mas o valor real herdado é `openai-codex-responses`.
- Os preços são **herdados e não verificados** para o 6.1: o catálogo não traz uma fonte própria para eles.
- **Probe live** (`runLiveProbe`, `openai-codex`, subscription, ~20 tokens): status `INCONCLUSIVE`. As duas chamadas
  retornaram: *"The 'gpt-6.1-luna' model is not supported when using Codex with a ChatGPT account."* A conta ChatGPT
  desta máquina **não aceita** o modelo. A mesma mensagem está documentada no `dv-baseline`.
- O comentário da lista em `catalog/providers/openai-codex.ts` registra a exceção. O modelo fica no catálogo, mas
  **não é utilizável nesta conta**.

## 8. Reprodução

```bash
npm run typecheck && npm run lint && npm test          # 100% verde
node scripts/dv-bench.ts --tier frontier --repeats 3 --temperature 0 \
  --policies single,ladder,architect-editor --auth-mode subscription \
  --max-tokens 1500000 --model anthropic/claude-haiku-5-5 \
  --escalation-model anthropic/claude-sonnet-4-6 --outdir runs/<novo-diretorio>
```

Cada `summary.md` declara o contrato (SHA-256), os tetos do editor, as réplicas, a temperatura por modelo e o IC de
Wilson por linha.

## 9. Rodada holdout N=3 (auditada)

**Conjunto:** holdout da partição fixa (9 tarefas: `easy-02-log-parser`, `easy-04-rle-codec`, `frontier-01-ssa-dominator-opt`, `frontier-03-incremental-type-infer`, `hard-02-wal-ledger-replay`, `hard-04-crdt-lww-map`, `medium-01-semver-resolver`, `medium-03-topo-build-planner`, `medium-05-rate-limiter-sliding`), 3 réplicas, 27 execuções por braço. Assinatura (subscription), temperatura 0, teto de 1,5 M tokens por execução. Resumos e saída consolidada em `runs/holdout-n3/` (não versionados).

**Proveniência (`dv_agent_commit` gravado em cada ledger):** Haiku, 27/27 em `a0194fe`. Sonnet, 26 em `a0194fe` e 1 em `52c1f6e` (o commit seguinte só acrescenta o bootstrap e o CLI de métricas, sem mudar o caminho de execução). Roteador, 30 degraus em `52c1f6e`, antes de `922ef1f` alterar o runner.

| Braço | Resolvidas | IC 95% (Wilson) | Tokens | Chamadas | Custo estimado (USD)* |
|---|---|---|---|---|---|
| `single` Haiku 5.5 | 25/27 | [76,6%; 97,9%] | 2.590.886 | 278 | 0,15 |
| `single` Sonnet 4.6 | 26/27 | [81,7%; 99,3%] | 9.261.330 | 522 | 11,34 |
| Roteador (`predictive-harness-router`) | **27/27** | [87,5%; 100%] | **5.019.231** | 388 | 1,77 |

\*Custo calculado a partir dos buckets medidos (entrada não cacheada, leitura e escrita de cache, saída) × preços do catálogo local (USD por 1M: Haiku 0,10 / 0,50 / cache 0,01 / 0,125; Sonnet 3 / 15 / 0,30 / 3,75). Em assinatura o CLI não reporta USD; o valor é referência de fronteira.

**Falhas:** Haiku em `frontier-01#2` e `frontier-03#2`; Sonnet em `medium-01#2`; roteador nenhuma. O roteador escalou para o Sonnet em 3 de 27 execuções, todas em `frontier-03` (uma em cada réplica). O escalonamento resgatou a falha do Haiku em `frontier-03#2`. Em `frontier-01#2`, o Haiku sozinho resolveu.

**Orçamento:** estimado em 27,5 M tokens e US$ 20 para N=3. Realizado: 16,9 M tokens e US$ 13,3 (estimado).

### 9.1 Métricas de roteamento (`dv-bench-metrics.ts`)

- **PGR (ponto único) = 1,997** e **APGR = 1,443**. Os dois passam de 1 porque o roteador (27/27) superou o Sonnet (26/27) em uma única execução. Não é ganho sustentado sobre o forte.
- **Fronteira de Pareto** (tokens × taxa de resolução): Haiku e roteador. O Sonnet fica dominado pelo roteador.
- **AIQ do conjunto** (um ponto por política, `x_max` = 9.261.330 tokens): 0,711.

### 9.2 Bootstrap pareado por tarefa (GAP-8)

9 tarefas, 10.000 reamostragens, seed `20261123`. **Sinal:** braço − baseline, média por execução. O CLI imprime `single − roteador`, com o sinal inverso; a tabela já está no sinal `roteador − baseline`.

| Comparação | Métrica | Diferença | IC 95% |
|---|---|---|---|
| roteador − Sonnet | taxa de resolução | +0,037 | [0; +0,111] |
| roteador − Sonnet | tokens | **−157.115** | **[−290.095; −45.119]** |
| roteador − Haiku | taxa de resolução | +0,074 | [0; +0,185] |
| roteador − Haiku | tokens | +89.939 | [−4.831; +223.620] |

Custo em USD: n/a no bootstrap (não há valor pareado de custo em assinatura).

**Leitura.** Contra o Sonnet, a economia de tokens do roteador é sustentada: o IC inteiro fica abaixo de zero. A vantagem de resolução não é: o IC toca zero. Contra o Haiku, nem a qualidade nem o custo são conclusivos com n = 9 tarefas.

### 9.3 Nota de governança (conformidade do braço Sonnet)

- **Classificação oficial:** o braço Sonnet tem duas violações de conformidade, em `medium-05-rate-limiter-sliding` rep-1 e rep-2, com a mensagem "padrão de segredo presente sem redação". Essas violações estão no `summary.json` e não foram editadas. Como as duas execuções foram resolvidas, elas entram no `solve_rate` de 26/27.
- **Inspeção:** os trechos casados eram `token = 0` e `token = math.ceil(raw)`, código gerado pelo modelo. Nenhum padrão de credencial de provedor (`sk-`, `Bearer`, `AIza`, `AKIA`, PEM, `gh*_`) aparece nos ledgers. A causa é a regra `token\s*[=:]` do redator e do verificador, que era ampla demais. Foi corrigida em `8293d60`, para rodadas futuras.
- **Reavaliação informativa:** com a regra nova, nenhum dos 84 ledgers do holdout continua marcado. Essa reavaliação não altera a classificação registrada no resumo histórico.
- **Sensibilidade:** excluir as duas execuções levaria o Sonnet a 24/25. A decisão de exclusão não foi tomada, e esta seção não a toma.
- **Conformidade v4 dos três braços:** `INCONCLUSIVE` por regra (c), porque o teto de custo em USD não é verificável em assinatura.

### 9.4 Limites desta rodada

- **n pequeno.** Com 27 execuções e 9 tarefas, os intervalos de confiança se sobrepõem. A diferença de qualidade entre braços não é significativa.
- **O roteador não exercitou o atalho.** O limiar calibrado é `null`, então todas as tarefas começam no Haiku. O braço mede a escada com o roteador novo, não a predição estática.
- **Haiku ignora temperatura** (`supportsTemperature = false`). Só o Sonnet recebeu temperatura 0.
- **Proveniência mista.** A branch recebeu commits de outra sessão durante a coleta (`52c1f6e`, `922ef1f`, `986271a`). Os caminhos de execução usados pelo holdout não foram alterados por eles, conforme a tabela de proveniência acima.

### 9.5 Reprodução (somente leitura, sem chamadas)

```bash
node scripts/dv-bench-metrics.ts --weak anthropic/claude-haiku-5-5 --strong anthropic/claude-sonnet-4-6 \
  runs/holdout-n3/weak-haiku/summary.json runs/holdout-n3/strong-sonnet/summary.json runs/holdout-n3/router/summary.json

node scripts/dv-bench-metrics.ts --paired-policy-a predictive-harness-router --paired-policy-b single \
  --seed 20261123 --resamples 10000 runs/holdout-n3/strong-sonnet/summary.json runs/holdout-n3/router/summary.json
```
