# Achados externos 2026 — engenharia de agentes

**Status:** prior art externo. Não é evidência DV. Todas as hipóteses derivadas permanecem `UNTESTED` / `E0` em `claims/claims-v1.json` até que um experimento local, com spec, ambiente e verificador versionados, produza evidência.

**Escopo da leitura:** metadados e resumos (abstracts) de cada fonte, verificados em 2026-10 via arXiv. Os textos completos não foram auditados. Antes de citar um número como fato, confira o paper completo.

## Fontes

| ID | Referência | Data (arXiv) | Uso no DV |
|---|---|---|---|
| F1 | Fan, Run-Ze et al. — *An Empirical Study of Harness Design for Coding Agents*, arXiv:2609.20804 | 2026-09-17 | Compactação, planejamento e espaço de ações (C-T1, C-T2, C-P1, C-S1) |
| F2 | Buchanan, E. Kelly et al. — *Benchmarks as Software: Terminal-Bench and the Case for Continuous Benchmarks*, arXiv:2611.08417 | 2026-11-05 | Preferência por Terminal-Bench 2.1; orçamento de recursos como parte da especificação |
| F3 | Dan, Soham et al. — *SWE-Bench Pro V2*, arXiv:2610.24206 | 2026-10-16 | Preferência por SWE-Bench Pro V2 |
| F4 | Sun, Ruopei et al. — *Compact-Bench: Measuring What Context Compaction Costs Long-Horizon Coding Agents*, arXiv:2610.31710 | 2026-10-22 | Métricas de retomada pós-compactação (C-T1, C-T2) |

Observação de nomenclatura: o paper de compactação se chama **Compact-Bench** (arXiv:2610.31710); "COMPACTIONBENCH" não é o título verificado.

## Achados por fonte (conforme resumos)

### F1 — Fan et al. (harness design)

Experimento controlado: loop de execução fixo; variam-se planejamento, espaço de ações e gestão de contexto. Quatro modelos, SWE-Bench Verified e Terminal-Bench 2.1, 176 configurações pareadas.

- Gestão de contexto ganha valor com janela de contexto menor, sobretudo por evitar falhas de estouro.
- Elision baseada em regras antes de sumarização por LLM dá a melhor eficiência geral entre as estratégias de contexto. Conteúdo elidido recuperável adiciona mecanismo que modelos raramente usam e não gera ganho de acurácia.
- Planejamento deixa de ser scaffold de acurácia para modelos fracos e passa a ser redutor de custo para modelos fortes, com pouca mudança de acurácia.
- Ferramentas predefinidas ajudam modelos com proficiência fraca em bash; modelos capazes operam com bash-only e custam substancialmente menos, sobretudo em tarefas de linha de comando.

### F2 — Terminal-Bench 2.1

A auditoria do Terminal-Bench 2.0 identificou problemas em **cerca de 30%** do benchmark (o resumo diz "roughly 30%"; o valor de 31% citado anteriormente não foi confirmado no resumo). As correções, publicadas como 2.1, mudaram resultados: acurácia subiu mais de 10 pontos percentuais, com posições no ranking variando até três posições (Spearman ρ = 0,958). Tempo de parede fixo também altera a conclusão: estender o limite fecha uma diferença de 20 pp entre harnesses para um modelo e reduz outra de 30 pp para 5 pp em um modelo menor.

### F3 — SWE-Bench Pro V2

Revisão pública do SWE-Bench Pro: 480 de 731 tarefas foram reparadas ou aposentadas, com 404 horas de engenheiros e verificação de instruções por um segundo engenheiro. O protocolo endurecido restringe o acesso à rede ao endpoint do modelo e reavalia cada patch em container limpo.

### F4 — Compact-Bench

Pares de continuação com histórico completo e apenas resumo, a partir do mesmo estado de repositório: 35 reparos do SWE-bench, 146 sessões agênticas e 106 cadeias de produção. Dano estável entre 5% e 64% das 22 continuações com sucesso no histórico completo, dependendo do sumarizador. Com o mesmo sumarizador (Kimi-K3), o prompt do Kimi Code preserva mais continuações (19/22), enquanto o Claude Code retém mais detalhes recorrentes (15,0%). Esses números vêm do resumo; a análise completa não foi auditada.

## Preferência de benchmarks para registros futuros do DV

Regras para referências e notas futuras (ver também `docs/research/UPSTREAM-REUSE-PLAN.md`, seção "Benchmark and test rule"):

1. **Terminal-Bench:** usar **2.1**. Não citar resultados do 2.0 sem indicar o problema de tarefas com defeito.
2. **SWE-Bench:** usar **SWE-Bench Pro V2** para tarefas de longo horizonte. Versões anteriores só com justificativa registrada.
3. **Compactação e retomada pós-compactação:** usar as métricas do **Compact-Bench** (F4) como referência de medição, sem substituir as métricas de `TOTAL_SYSTEM_TOKENS / VERIFIED_SOLVED_TASK`.
4. **Orçamento de recursos faz parte da especificação:** toda execução deve registrar limite de tempo de parede, de tokens e de tentativas, porque F2 mostra que esses limites mudam conclusões.

## Mapeamento para claims

| Claim | Fonte(s) | Teste local necessário |
|---|---|---|
| C-T1 — elision por regras antes de sumarização | F1, F4 | Mesma tarefa, mesmo verificador, duas estratégias de compactação, custo total e acurácia verificada |
| C-T2 — recall reversível | F1 | Elision-only vs. elision + recall, com custo de recall contabilizado |
| C-P1 — planejamento condicional ao porte do modelo | F1 | Executores fracos e fortes, com e sem scaffold de planejamento |
| C-S1 — bash-only vs. ferramentas estruturadas | F1 | Por classe de tarefa e capacidade do executor, com custo e sucesso verificado |

Nenhuma dessas hipóteses foi testada no DV. Os achados acima são de outros estudos, sob outras configurações de modelo e benchmark, e não se transferem automaticamente (ver `docs/EVIDENCE-POLICY.md`: suporte é sempre escopado).
