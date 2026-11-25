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

## Fila de Ingestão Automatizada de Estudos

<!-- BEGIN:AUTO-INGEST -->
### Ingestão automatizada em 2026-11-24 (Payload SHA-256: `a4f9ac6670afd6b1...`)

Total ingerido: 19 itens (19 novos). Todos em status `UNTESTED` / `E0`.

| Identificador | Referência / Título | Data | URL Canônica | Status na Triagem |
|---|---|---|---|---|
| arXiv:2611.31217 | Shaokang Jiang, Kira Yuha Cho — *A Mixed-Methods Study of Personal Software Creation* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31217) | Novo (E0/UNTESTED) |
| arXiv:2611.31205 | Zexin He, Rui Li — *ACAP: Asynchronous Coding Agents for Efficient Robot Control* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31205) | Novo (E0/UNTESTED) |
| arXiv:2611.31033 | Mohit Tekriwal, Het Mankad — *AI-Assisted Auto-formalization for Trustworthy Scientific Computing: Case Studies and Lessons Learned* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31033) | Novo (E0/UNTESTED) |
| arXiv:2611.31002 | Jinkun Liu, Yingze Wang — *RoboUniverse-10K: Toward the Scaling Era of Agentic Robotics via Real-to-Sim Environments* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31002) | Novo (E0/UNTESTED) |
| arXiv:2611.30894 | Carlos Rafael Catalan, Lheane Marie Dizon — *Useful but Unwieldy: How Software Engineers Perceive the Design of Chain-of-Thought Explanations in Coding Agents* | 2026-11-23 | [link](https://arxiv.org/abs/2611.30894) | Novo (E0/UNTESTED) |
| arXiv:2611.31201 | Xiao-Ming Wu, Kang Liao — *Embo-Harness: Towards Understanding Frontier-Model-as-Policy Harness* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31201) | Novo (E0/UNTESTED) |
| arXiv:2611.31117 | Jiajun Fan, Neil He — *Self-Upgrading Embodied Agents* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31117) | Novo (E0/UNTESTED) |
| arXiv:2611.31110 | Yaman Jandali, Nojan Sheybani — *Preflight: Agentic Last-Mile Verification for AI Software Supply Chains* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31110) | Novo (E0/UNTESTED) |
| arXiv:2611.31098 | Jinzhong Gu, Jiakai Chen — *Real2Worlds2Real: Scaling Self-Improving Agentic Real2Sim2Real for Robot Manipulation* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31098) | Novo (E0/UNTESTED) |
| arXiv:2611.31053 | Yicheng Xu, Wencan Jiang — *ReWeave: Emergent Physical Task Topologies for Embodied Harness Optimization and Cross-Task Meta-Distillation* | 2026-11-23 | [link](https://arxiv.org/abs/2611.31053) | Novo (E0/UNTESTED) |
| arXiv:2611.25673 | Jiayi Chen, Lizhe Chen — *CompAct-Bench: A Benchmark for Working-Context Compaction in Long-Horizon Agent Tasks* | 2026-11-19 | [link](https://arxiv.org/abs/2611.25673) | Novo (E0/UNTESTED) |
| arXiv:2611.23346 | Deep Shah, Nehal Kathrotia — *Securing and Auditing Long-Horizon LLM Agents: State-Transfer Auditing and Controls in the Agent Harness* | 2026-11-17 | [link](https://arxiv.org/abs/2611.23346) | Novo (E0/UNTESTED) |
| arXiv:2611.06876 | Yulu An, Yifei Feng — *SpecCompact: Accelerating LLM Agent Context Compaction with Slot-Parallel Semantic Speculative Verification* | 2026-11-04 | [link](https://arxiv.org/abs/2611.06876) | Novo (E0/UNTESTED) |
| arXiv:2611.06445 | Jizhe Zhang, Ang Li — *SUMONE: A Simple and Efficient Summarizer for Plug-and-Play Agent Memory* | 2026-11-04 | [link](https://arxiv.org/abs/2611.06445) | Novo (E0/UNTESTED) |
| arXiv:2611.04510 | Muhammad Uzair Ul Haq, Davide Rigoni — *Fast, Cheap, and Fair? Evaluating Decision Models* | 2026-11-03 | [link](https://arxiv.org/abs/2611.04510) | Novo (E0/UNTESTED) |
| arXiv:2611.30983 | Yitong Qiao, Lei Liu — *MedUIGym: Evaluating and Training GUI Agents for Clinical Workflows* | 2026-11-23 | [link](https://arxiv.org/abs/2611.30983) | Novo (E0/UNTESTED) |
| arXiv:2611.30733 | Andrei Khurshudov — *Can Cities Have Personalities? Introducing the SCD City Personality Assessment* | 2026-11-23 | [link](https://arxiv.org/abs/2611.30733) | Novo (E0/UNTESTED) |
| arXiv:2611.29822 | Syed Fatiul Huq, Md. Asif Haider — *Can Vibe Coding Produce Accessible Websites: An Empirical Study on LLM Coding Agents and Skills* | 2026-11-22 | [link](https://arxiv.org/abs/2611.29822) | Novo (E0/UNTESTED) |
| arXiv:2611.27920 | Xuyang Liu, Zhiwei Xu — *Autonomous Parameter Surgery: How LLMs Implant Selective Backdoors into Language Models* | 2026-11-20 | [link](https://arxiv.org/abs/2611.27920) | Novo (E0/UNTESTED) |
<!-- END:AUTO-INGEST -->

Nenhuma dessas hipóteses foi testada no DV. Os achados acima são de outros estudos, sob outras configurações de modelo e benchmark, e não se transferem automaticamente (ver `docs/EVIDENCE-POLICY.md`: suporte é sempre escopado).
