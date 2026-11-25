# Piloto Live — Adaptive Harness Scaling (easy-02-log-parser)

**Status:** INTERROMPIDO na pré-verificação. **Nenhuma chamada paga foi feita.**
**Branch:** `study/adaptive-harness-scaling` · **HEAD:** `2e54494`
**Evidências:** `runs/live-pilot/preflight.json`, `runs/live-pilot/check-prices.mts`

---

## 1. Resultado por braço

Não houve execução. Os quatro braços (A, B, C, D) não foram iniciados.

## 2. Custo real individual e acumulado

USD 0,00. Nenhuma requisição foi enviada a provedor.

## 3. Consumo de tokens · 4. Latência · 5. Resultado funcional

Não medidos (sem execução).

## 6. Erros e interrupções

**Interrupção na pré-verificação:** `ANTHROPIC_API_KEY` ausente no processo, nas variáveis de ambiente do usuário e da máquina, e sem arquivo `.env`.

O `~/.pi/agent/auth.json` tem uma credencial Anthropic do tipo OAuth de assinatura (`access`/`refresh`). Ela **não** foi usada como substituta de `--auth-mode api-key`: trocaria o modo de cobrança e removeria o teto em USD autorizado.

## 7. Comparação com as estimativas

Não há dados medidos para comparar. As estimativas de token e custo continuam não verificadas.

## 8. Projeção para nove tarefas (estimativa)

Não é possível projetar sem a medição do piloto. O único limite conhecido é o teto máximo: 4 braços × USD 1,53 = **USD 6,12**. Isso é um teto, não uma previsão de gasto.

## 9. Recomendação

- **Antes de qualquer nova tentativa:** o operador define `ANTHROPIC_API_KEY` no ambiente da sessão (não no chat) e reautoriza explicitamente o piloto.
- **Não substituir** por assinatura OAuth sem autorização explícita. Esse modo não tem teto em USD e exige `--max-tokens`.

---

## Pré-verificação concluída

| Item | Resultado |
|---|---|
| Branch | `study/adaptive-harness-scaling` ✔ |
| Alterações preexistentes | Só `biome.json` (ver abaixo); nenhuma será sobrescrita |
| `stash@{0}` | Intacto ✔ |
| Contratos v4 / v5 | Hashes inalterados ✔ |
| `npm run hydrate:pi-ai-data` | Exit 0 ✔ |
| Preço hidratado | Ver tabela abaixo ✔ |
| `ANTHROPIC_API_KEY` | **Ausente ✘** |

### Preços hidratados (USD por 1M tokens)

| Modelo | input | output | cache read | cache write | faixa |
|---|---:|---:|---:|---:|---|
| `anthropic/claude-haiku-5-5` | 0,10 | 0,50 | 0,01 | 0,125 | > 100k tokens de entrada: 0,50 / 2,50 |
| `anthropic/claude-sonnet-4-6` | 3,00 | 15,00 | 0,30 | 3,75 | — |

### Inspeção de `--max-cost` (antes de qualquer chamada)

A implementação original era **pós-chamada**: o teto só era verificado depois que uma chamada terminava. Por isso, a última chamada podia ultrapassar o teto inteiro. Também havia dois vazamentos:

1. **Faixas de preço ignoradas.** O custo do ledger usa a tabela base. Haiku acima de 100k tokens de entrada é subcontado.
2. **Retries do SDK.** O cliente Anthropic faz 2 retries por padrão, e esse custo não aparece no ledger.

**Correção aplicada** (commit `2e54494`, 325/325 testes):
- Gate **pré-chamada** por execução: estima a entrada (prefixo medido + cauda nova) pelo maior preço, e limita `maxTokens` ao saldo restante. Se nem a entrada cabe no saldo, a chamada não vai ao provedor e a execução termina em `budget_exceeded`.
- Gasto conservador (máximo entre tabela e custo com faixas do pi-ai) alimenta o gate. O ledger continua com o custo de tabela, para não quebrar a conformidade.
- `maxRetries: 0` nas chamadas.

Com isso, cada execução tem custo máximo igual ao seu teto (USD 1,53). Como os braços rodam em sequência, o total fica limitado a USD 6,12.

### Incidente

Durante a formatação (`biome check --write`), o `biome.json` do working copy foi revertido ao HEAD, desfazendo a alteração preexistente (troca de `"!**/probe-results/**"` e `"!**/tasks/**"` por versões sem `/**`). Restaurei exatamente essa alteração. O diff volta a ser `674 -> 668 bytes`, como no início da sessão.
