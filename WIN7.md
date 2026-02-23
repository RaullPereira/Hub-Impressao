# Branch Win7 – Suporte a Windows 7

Esta branch (`win7`) mantém o **Hub Impressão** compatível com **Windows 7**, usando **Electron 22**.

## Por que esta branch existe

- A partir do **Electron 23**, o Windows 7/8/8.1 deixou de ser suportado.
- A branch **main** usa Electron 28 e exige **Windows 10 ou superior**.
- Quem ainda precisa rodar em máquinas com Windows 7 pode usar esta branch.

## O que mudou nesta branch

| Item        | Branch `main` | Branch `win7`   |
|------------|----------------|------------------|
| Electron   | ^28.x          | ^22.3.x          |
| electron-builder | ^24.13.x | ^24.6.x    |
| Windows 7  | Não suportado  | Suportado        |

O resto do código (src, assets, lógica de impressão) é o mesmo.

## Como usar

```bash
# Usar esta branch
git checkout win7

# Instalar dependências (no Windows)
npm install

# Gerar ícones (opcional, se ainda não tiver app.ico)
npm run build:icons

# Build instalador para Windows (x64 e ia32)
npm run build:win7
# ou
npm run build:win
```

O instalador será gerado em `dist/` (ex.: `Hub Impressao Setup 1.0.1.exe`).

## Limitações e cuidados

- **Electron 22** não recebe mais atualizações de segurança do projeto Electron.
- **Windows 7** está fora do suporte da Microsoft desde 2020.
- Use esta branch apenas se for estritamente necessário (ex.: máquinas que não podem ser atualizadas).
- Para novas instalações, prefira a **main** com Windows 10+.

## Manutenção

- Correções de bugs do app (impressão, UI, etc.) podem ser feitas na `main` e depois trazidas para a `win7` (merge ou cherry-pick), desde que não dependam de APIs do Electron 23+.
- Não subir a versão do Electron nesta branch; manter em 22.3.x para continuar compatível com Windows 7.
