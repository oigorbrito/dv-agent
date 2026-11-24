# Instalação do DV Agent

## Requisitos

- Git
- Node.js **22.19.0 ou superior** (com npm)
- Conexão com a internet durante a instalação, para instalar dependências e hidratar o catálogo de modelos

O instalador não instala Git nem Node.js automaticamente. Isso evita alterar o gerenciador de pacotes ou a instalação global do runtime sem consentimento.

## Linux e macOS

Execute no terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/oigorbrito/dv-agent/feat/harness-router/scripts/install.sh | bash
```

Ou, depois de clonar/baixar o projeto:

```bash
bash scripts/install.sh
```

Opções:

```bash
bash scripts/install.sh --dir "$HOME/apps/dv-agent" --branch feat/harness-router
bash scripts/install.sh --skip-tests
```

## Windows (PowerShell)

Em PowerShell:

```powershell
irm https://raw.githubusercontent.com/oigorbrito/dv-agent/feat/harness-router/scripts/install.ps1 | iex
```

Ou, depois de baixar o projeto:

```powershell
.\scripts\install.ps1
```

Parâmetros:

```powershell
.\scripts\install.ps1 -InstallDir "$HOME\apps\dv-agent" -Branch feat/harness-router
.\scripts\install.ps1 -SkipTests
```

Se o PowerShell bloquear a execução de scripts locais, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## O que o instalador faz

1. Confere Git, Node.js e npm.
2. Clona o repositório ou atualiza um clone existente (somente fast-forward).
3. Instala dependências com `npm install --ignore-scripts`.
4. Executa `npm run hydrate:pi-ai-data`, necessário para obter o catálogo do runtime.
5. Compila os pacotes vendorados com `npm run build:runtime`.
6. Executa `npm run typecheck` e, por padrão, `npm test`.

O instalador não solicita nem armazena chaves de API, tokens OAuth ou credenciais de assinatura. A autenticação é configurada separadamente; consulte o README.

## Reinstalação e atualização

Execute novamente o mesmo comando. Em um clone existente, o instalador busca a branch selecionada e aplica atualização fast-forward. Alterações locais que impeçam o fast-forward não são sobrescritas.

## Limitações

- O instalador prepara o workspace e compila o runtime; não configura automaticamente credenciais nem executa chamadas a provedores.
- A hidratação do catálogo depende da disponibilidade da fonte upstream no momento da instalação.
- O modo assinatura usa o arquivo local de autenticação do pi e deve ser configurado pelo usuário conforme o README.
