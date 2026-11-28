# Protocolo de cascata barata-primeiro com modelos gratuitos (pré-registrado)

Status: **pré-registrado, não executado.** Nenhuma chamada live foi feita. Qualquer execução depende de autorização explícita do operador, de verificadores fixados e de janela de cota.
Mudança nas regras, nos critérios de decisão ou nas tarefas depois de ver resultados invalida este protocolo. Mudança exige nova versão do documento, com data e commit.

Este protocolo é uma **afirmação separada** do desenho `C-T1` (compactação, `FT-S2-MB3-01`, em `CLAIM-EXPERIMENT-RUNNER.md`). Não substitui nem altera aquele desenho.

## 1. Pergunta

Uma cascata que tenta primeiro um modelo gratuito barato e escala para um modelo mais forte só quando o oráculo reprova reduz o total de tokens por tarefa, sem reduzir a taxa de resolução além de uma margem fixada agora?

Hipótese nula: a cascata não reduz tokens, ou reduz resolução além da margem.

## 2. Por que este desenho e não outro

- **Escalonamento disparado pelo oráculo**, não por confiança declarada pelo modelo. A escada atual usa a mesma regra. Confiança declarada (como no `tiny-router-llm`) não tem evidência de calibração e não entra aqui.
- **Métrica principal em tokens e tempo de parede**, não em USD. Modelos gratuitos têm custo monetário zero, e o contrato v4 mede USD. Ver §5.
- **Sem roteador aprendido** (bandit, Thompson). Esse tipo de roteamento precisa de avaliação própria, e o `bayesroute` não a oferece. Fica fora deste protocolo.

## 3. Braços

| Braço | Sequência de modelos | Escalonamento |
| :--- | :--- | :--- |
| B0 | forte sozinho (ex.: `anthropic/claude-sonnet-4-6`) | nenhum |
| B1 | barato sozinho (ex.: `gemini_free`, `groq_free`) | nenhum |
| K2 | barato → forte | se o oráculo reprovar a saída do degrau 1 |

Os IDs dos modelos gratuitos são **`UNVERIFIED_AGAINST_LIVE_FREE_TIER`** até uma verificação live, registrada no resumo. Nenhum braço usa modelo fora desta lista.

Os braços B0 e B1 existem para separar o efeito da cascata do efeito de cada modelo sozinho. Sem eles, uma melhora ou piora não se atribui à cascata.

## 4. Tarefas e partição

- **Corpus:** o mesmo corpus da escada (`dv-eval`, tiers `easy`, `medium`, `hard`, `frontier`).
- **Calibração:** nenhuma. O protocolo não ajusta limiares. A regra de escalonamento é "o oráculo reprovou".
- **Avaliação:** as tarefas escolhidas antes da coleta, listadas no arquivo de desenho com `sha256` do corpus.
- **Bloqueio atual:** a execução exige verificadores fixados e bundles materializados para cada tarefa. Hoje o `S2-W01` tem `admitted_count: 0`, então este protocolo não pode rodar enquanto esse gate estiver em GAP. Isso é declarado, não contornado.
- **Mínimo:** 9 tarefas e 3 réplicas por braço. Abaixo disso, o resultado é piloto e não recebe conclusão de economia.

## 5. Métricas e contabilidade

Seguem as regras já existentes no repositório (`FREE != ZERO_COST`):

- **Tokens:** entrada, saída e cache, por tentativa HTTP. Tentativa sem `usage` informado (429, timeout, 5xx) faz o total da linha ser **`null`**, nunca zero. Linha com `null` não entra na média; ela é reportada à parte.
- **USD:** `0.0` com `usd_basis: FREE_QUOTA_NOT_BILLED` para modelos gratuitos. Não é comparado com o custo dos braços pagos.
- **Tempo de parede** por tarefa.
- **Resolução:** verificada pelo oráculo, como na escada.
- **Taxa de escalonamento** (só K2): fração de tarefas em que o degrau 2 foi chamado.
- **Contagem de 429** por braço e por modelo, como ruído de cota.

Métrica principal: tokens totais por tarefa. Métrica de segurança: taxa de resolução.

## 6. Análise

- Comparação **pareada por tarefa**: K2 contra B0 e contra B1.
- Bootstrap pareado por tarefa, 10.000 reamostragens, semente fixada e registrada no resumo, IC de 95%.
- Diferenças reportadas com IC, nunca só com ponto.
- Falhas de cota (429) separadas de falhas do modelo. Uma tarefa com 429 não é contada como falha de resolução; é reexecutada até o limite de tentativas fixado no desenho, e as tentativas são todas registradas.

## 7. Critério de decisão (fixado agora)

A cascata K2 é **defensável como economia** só se, ao mesmo tempo:

1. o IC de 95% da diferença de tokens (K2 − B0) for inteiramente negativo;
2. o IC de 95% da diferença de resolução (K2 − B0) não cruzar **−δ**, com **δ = 0,05** (proposta; fixar antes da coleta, e mudar δ invalida o protocolo);
3. nenhuma linha relevante estiver como `null` em mais de 10% das tentativas. Acima disso, o resultado é INCONCLUSIVO por cota.

Se (1) falhar, a conclusão é "sem economia demonstrada". Se (2) falhar, a conclusão é "economia à custa de resolução". Em nenhum dos casos a cascata é recomendada.

## 8. Limites declarados antes da coleta

- Escala de piloto se houver menos de 9 tarefas ou menos de 3 réplicas.
- IDs de modelos gratuitos não verificados. Limites de cota variam sem aviso.
- Modelos gratuitos podem mudar de comportamento entre execuções. A variância entre dias não é controlada por este desenho; isso precisa ser declarado em qualquer resultado.
- A comparação com B0 usa um modelo pago. Não mede o que um gratuito faria no lugar do pago, só o efeito da cascata.
- O runtime precisa ser registrado por execução (pi-ai e pi-agent-core na versão real usada). Resultados anteriores a 27/11 não valem como linha de base deste protocolo.

## 9. Relatório

Todo resultado sai com: sha256 do desenho, sha256 do corpus, versões do runtime, IDs de modelo verificados, contagem de 429 por braço, linhas com `null`, IC de cada diferença e a conclusão pelo critério da §7. Falhas e linhas `null` aparecem no relatório, não só as tarefas que deram certo.

## 10. Comandos

Nenhum comando de execução está autorizado por este documento. Após autorização explícita, o comando será registrado aqui com o arquivo de desenho correspondente.
