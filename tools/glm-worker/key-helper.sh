#!/bin/bash
# Ключ Z.ai для Claude Code (apiKeyHelper): процесс claude берёт его сам, в окружение исполнителя он не попадает.
if command -v security >/dev/null; then
  exec security find-generic-password -a "$USER" -s claude-glm-zai -w
fi
exec cat "${XDG_CONFIG_HOME:-$HOME/.config}/claude-glm/key"
