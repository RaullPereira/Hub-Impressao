#!/bin/bash
# Limpa a pasta dist para permitir novo build (corrige permission denied no macOS)
set -e
DIST="dist"
if [ -d "$DIST" ]; then
  echo "Ajustando permissões em $DIST..."
  chmod -R u+rwx "$DIST" 2>/dev/null || true
  echo "Removendo $DIST..."
  rm -rf "$DIST"
  echo "Pronto. Rode: npm run build:mac"
else
  echo "Pasta $DIST não existe."
fi
