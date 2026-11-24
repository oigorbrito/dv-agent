# Plano de reuso upstream do DV

**Status:** ATIVO  
**Modo atual de engenharia:** `REUSE_ONLY`  
**Aplica-se a:** fase atual do DV até que uma decisão explícita de saída seja registrada  
**Autoridade:** complementa `AGENTS.md`, `docs/ARCHITECTURE-GOVERNANCE.md` e `docs/PROJECT-OBJECTIVE.md`

## Finalidade

A fase atual do DV existe para determinar quanto da capacidade-alvo já está implementado por projetos upstream e pode ser reutilizado diretamente.

A premissa padrão desta fase é:

> Não criar código de implementação do DV. Executar, inspecionar, medir e compor primeiro os projetos doadores existentes.

Isso é intencionalmente mais estrito do que a ordem de arquitetura do repositório. O objetivo é impedir que o programa de pesquisa derive para um grande harness, runtime, roteador, orquestrador, controlador ou benchmark customizado antes que o ecossistema existente tenha sido esgotado.

## Regra da fase atual

### Fase A — upstream primeiro, zero implementação customizada

Enquanto este documento estiver ATIVO:

- não implementar um runtime do DV;
- não implementar um orquestrador do DV;
- não implementar um roteador nem um controlador adaptativo do DV;
- não implementar um framework genérico de agentes do DV;
- não implementar nova infraestrutura de memória/estado;
- não implementar um novo benchmark ou harness quando um existente puder exercitar o mesmo contrato;
- não reproduzir localmente algoritmos upstream apenas para ter controle mais firme sobre eles;
- não portar nem reescrever código doador, a menos que o reuso no lugar tenha sido mostrado como impossível;
- não adicionar abstrações de conveniência que dupliquem a interface existente de um projeto doador.

O trabalho permitido se limita a:

- descobrir projetos doadores candidatos;
- clonar ou obter repositórios upstream;
- fixar URL do repositório, licença, SHA do commit, release/tag e estado de dependências;
- executar cada doador sem modificações;
- ler e mapear sua arquitetura e seu comportamento de runtime;
- registrar quais contratos de capacidade do DV ele já satisfaz;
- registrar lacunas com evidência direta no código;
- usar testes, exemplos, benchmarks e harnesses fornecidos pelo upstream;
- adicionar documentação, proveniência, evidência, configuração e metadados de reprodutibilidade necessários para avaliar o reuso.

O resultado desejado da Fase A é `REUSE_ONLY` sempre que o ecossistema existente já satisfizer o contrato exigido.

### Fase B — exceção de adaptador mínimo

Código mínimo de adaptador específico do DV não faz parte do trabalho padrão da Fase A.

Um adaptador só pode ser introduzido depois que todos os itens abaixo forem registrados:

1. a implementação doadora foi executada com sucesso na sua forma upstream;
2. o contrato exigido pelo DV não pode ser exercitado por uma interface upstream existente;
3. a peça faltante é cola de integração, e não reimplementação do comportamento do doador;
4. o adaptador é menor e tem manutenção mais barata do que um fork ou uma reescrita;
5. a mudança tem um experimento ou uma decisão de integração explícita que a exija.

Se aprovado, o adaptador deve:

- conter apenas tradução, vinculação, conversão de protocolo ou cola de configuração;
- delegar o comportamento substantivo ao projeto doador;
- evitar copiar algoritmos do doador para o DV;
- preservar a proveniência e os requisitos de licença do doador;
- ser removível se o projeto upstream expuser depois a interface necessária.

## Ordem de avaliação de doadores

Os principais portões de doadores estão ordenados:

1. **AOrchestra** — candidato principal para reuso de composição/orquestração de runtime.
2. **MaAS** — candidato para busca/adaptação automática de arquitetura de agentes e seleção sensível a custo.
3. **AgentSquare** — candidato para composição modular de capacidades de agentes.
4. **SkillOrchestra** — candidato para orquestração reutilizável de skills/capacidades.
5. **ClawArena / ClawArena-Team** — candidato a benchmark/harness, depois de esgotados os doadores reutilizáveis de runtime/composição.

Fontes secundárias de infraestrutura e evidência incluem:

- **TwinRouterBench / Agent-as-a-Router** — infraestrutura de avaliação de roteamento e de custo/capacidade.
- **OpenHands / SWE-bench / Terminal-Bench 2.1** — infraestrutura de execução e verificação em engenharia de software. Preferir Terminal-Bench 2.1 a 2.0 e SWE-Bench Pro V2 a splits anteriores do SWE-bench; ver `docs/research/EXTERNAL-FINDINGS-2026.md`.

Esta é uma fila de pesquisa com portões, não um mandato de integração. Não auditar o próximo doador só porque ele está listado. Avançar somente quando o doador atual deixar uma lacuna relevante para o contrato. Se um doador fechar a lacuna, parar para aquele contrato.

Antes de tratar um doador como dependência do DV, registrar seu repositório canônico, licença, commit ou release fixado, instruções de execução e a capacidade exata que está sendo reutilizada.

## Protocolo de auditoria para cada doador

Para cada candidato, responder a partir do código-fonte e da evidência de execução, e não apenas das afirmações do README:

1. Quais decisões são tomadas dinamicamente em runtime?
2. O que pode ser composto, substituído, habilitado, desabilitado ou delegado?
3. Em que granularidade a adaptação acontece: tarefa, subtarefa, passo, chamada de ferramenta, agente ou chamada de modelo?
4. Quais destes são selecionáveis ou mutáveis: modelo, ferramentas, contexto, instruções, memória/estado, verificador, retentativas, transferência, subagentes?
5. Existe um objetivo explícito de custo, qualidade, latência ou sucesso?
6. O projeto preserva o estado através de mudanças ou transferências?
7. Ele já expõe semântica de composição/decomposição com outro nome?
8. Quais contratos do DV já são plenamente satisfeitos?
9. Quais lacunas restam depois de usar o doador conforme previsto?
10. Cada lacuna restante pode ser resolvida por configuração ou por um ponto de extensão existente antes de qualquer adaptador ser considerado?

A execução operacional deste protocolo é regida por `docs/research/UPSTREAM-AUDIT-HARNESS.md`. Esse harness separa afirmações da documentação, comportamento confirmado no código, qualificação do ponto de entrada, confirmação em runtime e conclusões bloqueadas pela execução; ele também define regras explícitas de não reparo e de parada, para que a auditoria de doadores não derive para a manutenção dos doadores.

A auditoria deve distinguir dois eixos independentes:

- **o que pode mudar** — modelo, prompt/raciocínio, ferramentas, memória/estado, contexto, instruções, skills, subagentes, topologia/workflow, verificador, retentativas, transferência;
- **quando pode mudar** — offline, em tempo de treinamento, por conjunto de dados, por consulta, por episódio, por rollout, por subtarefa, entre delegações, por passo, por chamada de ferramenta ou durante um executor já ativo.

Um doador que gera arquiteturas diferentes por consulta não demonstra, por isso, recomposição durante uma trajetória ativa.

## Registro de decisão de reuso

Para cada capacidade relevante, registrar um dos itens:

- `REUSE_AS_IS`
- `REUSE_WITH_CONFIGURATION`
- `REUSE_WITH_MINIMAL_ADAPTER`
- `FORK_REQUIRED`
- `BUILD_CUSTOM_REQUIRED`
- `NO_BUILD`
- `INCONCLUSIVE`

`FORK_REQUIRED` e `BUILD_CUSTOM_REQUIRED` não são conclusões válidas sem evidência no código que mostre por que os modos de reuso de menor custo falham no contrato exigido.

## Regra de benchmark e de testes

Testes não são o produto desta fase.

Preferir, nesta ordem:

1. testes e exemplos do próprio projeto doador;
2. benchmark ou harness de avaliação publicado pelo doador;
3. um benchmark externo já aceito pela comunidade de pesquisa relevante;
4. uma verificação fina de integração do DV;
5. um novo benchmark do DV somente quando a propriedade exigida não puder ser medida pelas quatro opções anteriores.

A preferência de versão de benchmark externo para referências e notas futuras (Terminal-Bench 2.1, SWE-Bench Pro V2, Compact-Bench para métricas pós-compactação) está registrada em `docs/research/EXTERNAL-FINDINGS-2026.md`.

Um teste novo deve responder a uma pergunta específica e não resolvida do DV. Não criar matrizes de teste só porque é possível.

## Requisito de proveniência

Para cada doador usado em evidência, registrar no mínimo:

- repositório canônico;
- SHA do commit ou release/tag imutável;
- licença;
- data de aquisição;
- modificações locais, se houver;
- comando exato usado para executar;
- informações de ambiente/dependências necessárias para reprodução.

Nunca apresentar código ou evidência de um doador como se tivesse origem no DV.

## Critérios de saída do modo REUSE_ONLY

Este documento permanece ATIVO até que pelo menos um dos itens abaixo seja registrado:

1. o comportamento exigido pelo DV está totalmente disponível upstream, produzindo um desfecho `REUSE_ONLY` ou `NO_BUILD`; ou
2. uma lacuna concreta de capacidade permanece depois que os projetos doadores relevantes foram executados e inspecionados, e a lacuna não pode ser fechada por configuração ou por pontos de extensão existentes.

Apenas o caso 2 pode justificar a passagem da Fase A para a exceção de adaptador mínimo.

Uma passagem além dos adaptadores mínimos exige uma decisão arquitetural separada, apoiada por evidência experimental.

## Estado atual da auditoria e próxima ação imediata

A AOrchestra teve a execução confirmada para delegação dinâmica e criação de subagentes novos. O MaAS teve a seleção de arquitetura condicionada à consulta confirmada por leitura de código, mas sua revisão fixada apresenta bloqueios de reprodutibilidade upstream para uma execução limitada do HumanEval (incluindo ativos externos de dados ausentes, incompatibilidade entre checkpoint e carregador, e suporte a subconjuntos não exposto pelo caminho de CLI).

O contrato não resolvido continua sendo:

> Um doador upstream consegue recompor capacidades relevantes durante uma trajetória de execução já ativa, com base no estado intermediário, e não apenas entre delegações ou antes da execução da consulta?

Prosseguir para o **AgentSquare**, usando `docs/research/UPSTREAM-AUDIT-HARNESS.md`.

Não reparar a AOrchestra nem o MaAS, e não escrever código de runtime do DV apenas para reforçar a evidência além do que o portão atual exige.
