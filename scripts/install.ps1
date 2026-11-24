[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $HOME "dv-agent"),
  [string]$Branch = "feat/harness-router",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/oigorbrito/dv-agent.git"

function Fail([string]$Message) {
  Write-Error "ERRO: $Message"
  exit 1
}

$Git = Get-Command git -ErrorAction SilentlyContinue
$Node = Get-Command node -ErrorAction SilentlyContinue
$Npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $Git) { Fail "Git não encontrado. Instale Git: https://git-scm.com/downloads" }
if (-not $Node -or -not $Npm) { Fail "Node.js >= 22.19.0 com npm não encontrado. Instale: https://nodejs.org/" }

$NodeVersion = (& node -p "process.versions.node").Trim()
$VersionParts = $NodeVersion.Split(".") | ForEach-Object { [int]$_ }
if (($VersionParts[0] -lt 22) -or (($VersionParts[0] -eq 22) -and ($VersionParts[1] -lt 19))) {
  Fail "Node.js $NodeVersion detectado; é necessário >= 22.19.0."
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$Parent = Split-Path -Parent $InstallDir
if (-not (Test-Path $Parent)) { New-Item -ItemType Directory -Force -Path $Parent | Out-Null }

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Host "Atualizando repositório em $InstallDir..."
  git -C $InstallDir fetch --depth 1 origin $Branch
  if ($LASTEXITCODE -ne 0) { Fail "Falha ao buscar a branch $Branch." }
  git -C $InstallDir checkout $Branch
  if ($LASTEXITCODE -ne 0) { Fail "Falha ao selecionar a branch $Branch." }
  git -C $InstallDir pull --ff-only origin $Branch
  if ($LASTEXITCODE -ne 0) { Fail "Falha ao atualizar o repositório." }
} elseif (Test-Path $InstallDir) {
  Fail "$InstallDir já existe e não é um clone Git. Escolha outro caminho com -InstallDir."
} else {
  Write-Host "Clonando DV Agent..."
  git clone --depth 1 --branch $Branch $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail "Falha ao clonar o repositório." }
}

Set-Location $InstallDir
Write-Host "Instalando dependências npm..."
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) { Fail "npm install falhou." }

Write-Host "Baixando o catálogo de modelos..."
npm run hydrate:pi-ai-data
if ($LASTEXITCODE -ne 0) { Fail "Falha ao hidratar os dados do pi-ai." }

Write-Host "Compilando runtime..."
npm run build:runtime
if ($LASTEXITCODE -ne 0) { Fail "A compilação do runtime falhou." }

Write-Host "Verificando tipos..."
npm run typecheck
if ($LASTEXITCODE -ne 0) { Fail "A verificação de tipos falhou." }

if (-not $SkipTests) {
  Write-Host "Executando testes offline..."
  npm test
  if ($LASTEXITCODE -ne 0) { Fail "Os testes falharam." }
}

Write-Host ""
Write-Host "DV Agent instalado em: $InstallDir"
Write-Host "Próximos passos:"
Write-Host "  Set-Location '$InstallDir'"
Write-Host "  npm run probe:providers"
Write-Host "  node scripts/dv-smoke.ts --policy ladder --auth-mode offline-faux"
Write-Host "Consulte README.md para configurar autenticação por assinatura."
