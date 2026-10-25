#!/bin/bash
# Ключ Z.ai для Claude Code (apiKeyHelper): процесс claude берёт его сам, в окружение исполнителя он не попадает.
# macOS: Связка ключей. Иначе файл, который пишет `claude-glm --set-key` (~/.agents-os/keys/glm), а если его нет,
# прежний ~/.config/claude-glm/key. Windows: этот скрипт не нужен, `agent-run --init glm` пишет apiKeyHelper сам.
if command -v security >/dev/null; then
  exec security find-generic-password -a "${USER:-${USERNAME:-$(id -un 2>/dev/null || echo user)}}" -s claude-glm-zai -w
fi
for f in "${AGENTS_OS_HOME:-$HOME/.agents-os}/keys/glm" "${XDG_CONFIG_HOME:-$HOME/.config}/claude-glm/key"; do
  # перевод строки и \r в конце файла не часть ключа
  if [[ -f "$f" ]]; then tr -d '\r\n' < "$f"; exit 0; fi
done
echo "Ключа GLM нет. Сохраните его: claude-glm --set-key" >&2
exit 1
