#!/usr/bin/env bash
set -euo pipefail
COMPACT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { echo '需要 Node.js（用于安全编辑 JSONC 配置）。' >&2; exit 1; }
command -v npm >/dev/null || { echo '需要 npm。' >&2; exit 1; }
if [[ " ${*:-} " != *' --uninstall '* && " ${*:-} " != *' --check '* ]]; then
  command -v opencode >/dev/null || { echo '未找到 opencode。' >&2; exit 1; }
  COMPACT_VERSION="$(opencode --version)"
  if [[ "$COMPACT_VERSION" != '1.18.34' && " ${*:-} " != *' --allow-untested '* ]]; then
    echo "当前 OpenCode 为 $COMPACT_VERSION；此插件针对 1.18.34 验证。要自行测试其他 1.x 版本，请加 --allow-untested。" >&2
    exit 1
  fi
  if [[ "$COMPACT_VERSION" != 1.* ]]; then
    echo '不支持 OpenCode 2.x；请勿把 v1 插件装入 v2。' >&2; exit 1
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
