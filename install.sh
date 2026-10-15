#!/usr/bin/env bash
set -euo pipefail
COMPACT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo '需要 Node.js（用于安全编辑 JSONC 配置）。' >&2; exit 1; }
command -v npm >/dev/null || { echo '需要 npm。' >&2; exit 1; }
if [[ " ${*:-} " != *' --uninstall '* && " ${*:-} " != *' --check '* ]]; then
  command -v opencode >/dev/null || { echo '未找到 opencode。' >&2; exit 1; }
  COMPACT_VERSION="$(opencode --version | sed 's/^opencode v//')"
  if [[ "$COMPACT_VERSION" != '2.0.26' && " ${*:-} " != *' --allow-untested '* ]]; then
    echo "当前 OpenCode 为 $COMPACT_VERSION；此插件针对 2.0.26 验证。要自行测试其他 2.x 版本，请加 --allow-untested。" >&2
    exit 1
  fi
  if [[ "$COMPACT_VERSION" != 2.* ]]; then
    echo '此版本仅支持 OpenCode 2.x。' >&2; exit 1
  fi
fi
cd -- "$COMPACT_ROOT"
if [[ ! -d node_modules/jsonc-parser || ( " ${*:-} " != *' --uninstall '* && " ${*:-} " != *' --check '* ) ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci --ignore-scripts --no-audit --no-fund
  else
    npm install --ignore-scripts --no-audit --no-fund
  fi
fi
node scripts/install.mjs "$@"
