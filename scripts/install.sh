#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/oigorbrito/dv-agent.git"
INSTALL_DIR="${DV_INSTALL_DIR:-$HOME/dv-agent}"
BRANCH="${DV_INSTALL_BRANCH:-main}"
SKIP_TESTS=0

usage() {
  cat <<'EOF'
Instalador do DV Agent (Linux/macOS)

Uso:
  bash scripts/install.sh [--dir CAMINHO] [--branch BRANCH] [--skip-tests]

Variáveis:
  DV_INSTALL_DIR     Diretório de instalação (padrão: ~/dv-agent)
  DV_INSTALL_BRANCH  Branch Git (padrão: main)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?Informe o caminho após --dir}"; shift 2 ;;
    --branch) BRANCH="${2:?Informe a branch após --branch}"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; usage; exit 2 ;;
  esac
done

fail() { echo "ERRO: $*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "Git não encontrado. Instale Git e execute novamente."
command -v node >/dev/null 2>&1 || fail "Node.js >= 22.19.0 não encontrado. Instale em https://nodejs.org/."
command -v npm >/dev/null 2>&1 || fail "npm não encontrado. Reinstale o Node.js incluindo npm."

NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<19)) process.exit(1)' \
  || fail "Node.js $NODE_VERSION detectado; é necessário >= 22.19.0."

INSTALL_DIR="$(mkdir -p "$(dirname "$INSTALL_DIR")" && cd "$(dirname "$INSTALL_DIR")" && pwd)/$(basename "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Atualizando repositório em $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [[ -e "$INSTALL_DIR" ]]; then
  fail "$INSTALL_DIR já existe e não é um clone Git. Escolha outro caminho com --dir."
else
  echo "Clonando DV Agent..."
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "Instalando dependências npm..."
npm install --ignore-scripts

echo "Baixando o catálogo de modelos necessário ao runtime..."
npm run hydrate:pi-ai-data

echo "Compilando o runtime..."
npm run build:runtime

echo "Verificando tipos..."
npm run typecheck

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  echo "Executando testes offline..."
  npm test
fi

cat <<EOF

DV Agent instalado em: $INSTALL_DIR

Próximos passos:
  cd "$INSTALL_DIR"
  npm run probe:providers                 # probe offline
  node scripts/dv-smoke.ts --policy ladder --auth-mode offline-faux

Para autenticação por assinatura, consulte a seção correspondente no README.md.
EOF
