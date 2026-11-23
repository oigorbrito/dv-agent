# Relatório de benchmark — dv-agent

Consolidação da trajetória empírica do projeto. Todos os números de desempenho vêm dos `summary.json` em `runs/`,
lidos por um script que reaproveita a função `wilsonInterval` do próprio bench. Os tokens de entrada do primeiro
turno vêm dos ledgers. Onde um número citado no pedido não pôde ser verificado no repositório, isso está dito
explicitamente na seção 6.

## 1. Resumo

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
