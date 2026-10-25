# Подключение моделей

Как собрать на своём компьютере команду из нескольких нейросетей и видеть её работу
на одной карте Agents OS:

```
Вы ──▶ Claude Code, главный агент (Opus): думает, ставит задачи, принимает работу
          ├── помощники Sonnet и Haiku (субагенты Claude Code)
          ├── GLM-исполнитель: Claude Code на моделях Z.ai, пишет код по ТЗ
          └── Codex (GPT): отдельные сессии, видны на карте

Agents OS читает переписки всех троих локально и рисует одну карту:
кто работает, над чем, на какой модели и кто кого запустил.
```

Займёт 15 минут. Нужны macOS, Linux или Windows 10/11, Node 18+ и установленный
[Claude Code](https://docs.claude.com/en/docs/claude-code). На Windows команды
подключения другие, они собраны в разделе [Windows](#windows) ниже; шаги 1 и 2
там такие же.

## 1. Agents OS

```bash
git clone https://github.com/saint4ai/agents-os.git
cd agents-os
npm start
```

Откройте http://127.0.0.1:3939. Зависимостей нет, `npm install` не нужен.

Получилось, если на экране «Сейчас» видны ваши проекты Claude Code.

## 2. Claude Code

Настраивать ничего не нужно. Agents OS читает `~/.claude/projects`: главные сессии,
помощники и сообщения между ними (`SendMessage`) видны сразу.

## 3. GLM через Z.ai

GLM работает как второй экземпляр Claude Code: тот же инструмент, другие модели и
своя папка с историей. Код по готовому ТЗ он пишет заметно дешевле Opus.

Нужен ключ [Z.ai Coding Plan](https://z.ai).

```bash
# из папки репозитория agents-os
mkdir -p ~/.local/bin ~/.glm-worker
cp tools/claude-glm tools/agent-run ~/.local/bin/ && chmod +x ~/.local/bin/claude-glm ~/.local/bin/agent-run
cp tools/glm-worker/CLAUDE.md tools/glm-worker/settings.json tools/glm-worker/key-helper.sh ~/.glm-worker/
chmod 700 ~/.glm-worker/key-helper.sh

# если ~/.local/bin ещё нет в PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc

claude-glm --set-key   # ключ уходит в Связку ключей macOS или в файл с правами 600
claude-glm --check     # в ответе должно быть «работаю»
```

Что лежит в `~/.glm-worker`:
- `CLAUDE.md` — правила исполнителя: делать только ТЗ, не коммитить и не выкатывать,
  отчитываться по форме;
- `settings.json` — права: тесты и `git diff` можно, `git push`, `rm -rf`, `ssh`,
  `env`/`printenv` и чтение `.env` запрещены;
- `key-helper.sh` — отдаёт ключ самому Claude Code (`apiKeyHelper`). В окружение
  исполнителя ключ не попадает: команда `env` в его Bash ключа не покажет.

Своя папка нужна по двум причинам. Первая: у исполнителя свои правила и права, а
ваши настройки Claude Code он не видит. Вторая: Z.ai подменяет имя модели на
`claude-opus-…`, и Agents OS отличает GLM от Claude только по папке.

## 4. Codex (GPT)

```bash
npm install -g @openai/codex
codex login
```

Сессии Codex пишутся в `~/.codex/sessions`, Agents OS показывает их в проекте с
пометкой GPT. Пока есть ограничения, они описаны в разделе «Ограничения» в конце.

## Другие модели: DeepSeek, Kimi, Qwen, MiniMax

У этих провайдеров есть API, совместимое с Anthropic: исполнитель — тот же
Claude Code, другие модели и своя папка. Один и тот же скрипт `tools/agent-run`
запускает любого из них; провайдеры описываются в `~/.agents-os/providers.json`.
Базовые URL ниже — из документации провайдеров на момент написания: перед
подключением сверьте их с документацией провайдера.

```bash
cp tools/agent-run ~/.local/bin/ && chmod +x ~/.local/bin/agent-run

mkdir -p ~/.agents-os
cat > ~/.agents-os/providers.json <<'JSON'
{
  "profiles": [
    { "id": "deepseek", "kind": "claude-like", "label": "DeepSeek",
      "historyDir": "~/.ds-worker/projects",
      "baseUrl": "https://api.deepseek.com/anthropic" },
    { "id": "kimi", "kind": "claude-like", "label": "Kimi",
      "historyDir": "~/.kimi-worker/projects",
      "baseUrl": "https://api.moonshot.ai/anthropic" },
    { "id": "qwen", "kind": "claude-like", "label": "Qwen",
      "historyDir": "~/.qwen-worker/projects",
      "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic" },
    { "id": "minimax", "kind": "claude-like", "label": "MiniMax",
      "historyDir": "~/.minimax-worker/projects",
      "baseUrl": "https://api.minimax.io/anthropic" }
  ]
}
JSON

agent-run --init deepseek      # папка: settings.json (права как у glm-worker) и CLAUDE.md
agent-run --set-key deepseek   # ключ в Связку ключей или в ~/.agents-os/keys/deepseek (600)
agent-run --check deepseek     # в ответе должно быть «работаю»

# запуск исполнителя по ТЗ (флаги — как у claude):
cd ~/my-project && agent-run deepseek -p "$(cat ~/.agents-os/tasks/feature.md)" --output-format json
```

Ключ в окружение исполнителя не попадает: Claude Code берёт его сам через
`apiKeyHelper` (`agent-run --print-key <профиль>`), как у GLM. Модель выбирает
провайдер; свою можно задать: `AGENT_RUN_MODEL=модель agent-run kimi -p …`.
Каждый профиль появляется на карте отдельным источником, запуски вида
`agent-run deepseek -p …` распознаются так же, как `claude-glm`, — видны связи
«кто кого запустил».

## Роли: кто мозг, кто исполнитель

Роли записаны в файле `~/.agents-os/team.json`. Agents OS его только читает и
показывает на карте: строка «Мозг: Claude · исполнители: GLM, DeepSeek» в
шапке проекта, метка «мозг» у строки агента, подпись «мозг → исполнитель» на
проводе в «Цепочке». Меняется файл не в интерфейсе, а разговором: просите
агента — он переписывает файл.

Без файла: мозг — Claude, исполнителями считаются все профили, у которых есть
запуски. Роль — договорённость, запуск — факт из переписок: если агент запустил
того, кого нет в списке исполнителей, связь на карте всё равно рисуется, с
пометкой «не в команде».

```json
{
  "version": 1,
  "brain": "claude",
  "executors": [
    { "profile": "glm", "projects": ["*"] },
    { "profile": "deepseek", "projects": ["~/my-project"] }
  ],
  "updatedAt": "2026-10-23T10:00:00Z",
  "updatedBy": "claude:7f3a…"
}
```

`projects` — пути проектов (`~` разрешён) или `"*"`: исполнителю можно
разрешить один проект, а остальным — все. Кто последним менял файл, видно по
`updatedBy`: если что-то пошло не так, это первое место проверки.

Чтобы главный агент сам вёл этот файл, добавьте в `~/.claude/CLAUDE.md`:

```markdown
Роли команды агентов записаны в `~/.agents-os/team.json`. В начале задачи прочитай его: кто мозг, кому отдавать исполнение. Когда человек просит сменить мозг или исполнителя, перепиши файл (`brain`, `executors`, `updatedAt`, `updatedBy`) и подтверди одной строкой. Других правок в нём не делай.
```

Разговор выглядит так:

> **Вы:** Сделай мозгом Codex, а Claude — исполнителем.
>
> **Агент:** Готово: `~/.agents-os/team.json` переписан — мозг Codex, исполнитель Claude.

Файл после такого разговора:

```json
{
  "version": 1,
  "brain": "codex",
  "executors": [
    { "profile": "claude", "projects": ["*"] },
    { "profile": "glm", "projects": ["*"] }
  ],
  "updatedAt": "2026-10-23T10:12:00Z",
  "updatedBy": "codex:9b21…"
}
```

На карте при следующем обновлении метка «мозг» перееходит на сессии Codex.

## 5. Как модели работают вместе

Роли:

| Кто | Что делает |
|---|---|
| Главный Claude (Opus) | Разбирает задачу, пишет ТЗ, принимает работу, коммитит, решает всё необратимое |
| GLM | Пишет код по готовому ТЗ: реализация, тесты, правки по списку |
| Помощник Sonnet | То, где нужны глаза: вёрстка по образцу, проверка в браузере, ресёрч |
| Помощник Haiku | Обёртка для запуска GLM и сбор фактов |

### ТЗ для GLM

Истории чата у исполнителя нет, поэтому ТЗ самодостаточное. Шаблон:

```
ЦЕЛЬ: одна фраза.
КОНТЕКСТ: файлы, решения, на что опереться.
МОЖНО МЕНЯТЬ: точный список файлов.
НЕЛЬЗЯ: что не трогать.
ГОТОВО, КОГДА: проверяемые условия.
ПРОВЕРКА: точная команда.
```

Начинайте ТЗ со строки `ЦЕЛЬ:`. По ней Agents OS называет задачу на карте. Если
сессию продолжали несколько раз, показывается последняя цель и «задача N из M».

ТЗ храните в файлах в `~/.glm-worker/tasks/`, логи запусков — в `~/.glm-worker/runs/`.
`/tmp` очищается при перезагрузке, и запуск уйдёт с пустой задачей.

### Запуск

```bash
cd ~/my-project && claude-glm -p "$(cat ~/.glm-worker/tasks/feature-x.md)" \
  --output-format json > ~/.glm-worker/runs/feature-x.json
```

- Из ответа взять `result` (отчёт исполнителя) и `session_id`.
- Доработка в той же сессии: `claude-glm -p --resume <session_id> "что исправить" --output-format json`.
- Команду проверки, которой нет в `settings.json`, разрешите флагом:
  `--allowedTools "Bash(make build)"`.

Запускайте GLM фоном (`run_in_background`) через помощника Haiku. Тогда контекст
главной сессии не забивается логом, а на карте запуск виден отдельной веткой:
главный → помощник → GLM.

### Приёмка

Отчёту исполнителя на слово не верить:
1. `git diff`: изменены только разрешённые файлы.
2. Самому запустить команду проверки.
3. Прочитать изменённый код.
4. Если это интерфейс — посмотреть глазами.

Не в порядке — вернуть с конкретными замечаниями через `--resume`.

### Правило для главного агента

Чтобы главный Claude сам отдавал механику GLM, добавьте в `~/.claude/CLAUDE.md`:

```markdown
# Код по ТЗ пишет GLM, главный агент руководит и принимает

Исполнитель — Claude Code на GLM: `claude-glm` (правила в ~/.glm-worker/CLAUDE.md).
Отдавать GLM механику по ясному ТЗ: реализацию по плану, тесты, правки по списку.
Себе оставлять архитектуру, безопасность, миграции, выкат и всё необратимое.
Что требует глаз или браузера — помощнику Sonnet.
ТЗ — по шаблону ЦЕЛЬ / КОНТЕКСТ / МОЖНО МЕНЯТЬ / НЕЛЬЗЯ / ГОТОВО, КОГДА / ПРОВЕРКА,
файлом в ~/.glm-worker/tasks/. Запуск фоном через помощника Haiku.
Приёмка всегда сама: diff, проверка, чтение кода, скриншот.
Один исполнитель на один набор файлов.
```

## 6. Что видно на карте

- **Проект:** полоса «Модели» (Opus, Sonnet, Haiku, GLM, GPT), зона «В работе».
- **Цепочка:** главная сессия → помощники → GLM-исполнители. Связь с GLM находится
  по команде `claude-glm -p …` или `--resume <id>` в переписке запустившего.
- **Отчёт GLM:** задача, что сделано, проверки, «Кто поставил задачу».
- **Межпроектные связи:** если `cd` в команде запуска ведёт в другой проект, связь
  видна с обеих сторон.

Проверка, что всё связалось:
1. Попросите главного Claude отдать GLM маленькую задачу по шаблону.
2. На экране «Сейчас» появится строка GLM в «В работе».
3. В «Цепочке» главной сессии GLM висит под помощником.
4. После конца в отчёте GLM есть блок «Кто поставил задачу».

## Windows

Карта Agents OS работает на Windows 10/11 в PowerShell. Исполнители (`claude-glm`,
`agent-run`) это bash-скрипты, их запускают из Git Bash: Claude Code на Windows
выполняет Bash-команды именно там.

Нужно:

1. Node 18+ (проверка: `node -v` в PowerShell).
2. [Git for Windows](https://git-scm.com/downloads/win): в нём есть Git Bash. Сам
   Claude Code по документации работает и без него (тогда команды идут через
   PowerShell), но скрипты исполнителей написаны на bash, поэтому для них Git for
   Windows нужен.
3. Установленный Claude Code.

### Карта (шаги 1 и 2)

В PowerShell, как на других системах:

```powershell
git clone https://github.com/saint4ai/agents-os.git
cd agents-os
npm start
```

Откройте http://127.0.0.1:3939. Agents OS читает `%USERPROFILE%\.claude\projects`
(`~` на Windows это `C:\Users\имя`). Демо: `npm run demo`.

### GLM и другие исполнители

Дальше команды выполняются в Git Bash (меню «Пуск», «Git Bash»), из папки
`agents-os`. Там `~` тоже `C:\Users\имя`, а диск `C:` называется `/c`.

```bash
# скрипты в ~/.local/bin; chmod +x на Windows не нужен, Git Bash читает первую строку #!/bin/bash
mkdir -p ~/.local/bin
cp tools/agent-run tools/claude-glm ~/.local/bin/

# строка PATH в ~/.bashrc
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

agent-run --init glm   # создаёт ~/.glm-worker: settings.json (права) и CLAUDE.md (правила исполнителя)
claude-glm --set-key   # ключ Z.ai, ввод скрыт
claude-glm --check     # в ответе должно быть «работаю» (это живой запрос к Z.ai)
```

Если в новом окне Git Bash `agent-run --list` отвечает «command not found», строка
PATH не прочитана: добавьте её ещё и в `~/.bash_profile`.

Что отличается от macOS и Linux:

- **Ключ в файле, а не в Связке ключей.** Связки ключей на Windows нет, ключ лежит в
  `C:\Users\имя\.agents-os\keys\<профиль>` (у GLM файл `glm`). Файл создаётся в
  папке профиля пользователя и наследует её права: по умолчанию остальные
  пользователи компьютера к ней не допущены. `chmod 600` на Windows ничего не
  меняет, скрипт его выполняет без ошибки и идёт дальше. Ключ вставляется без
  эха; перевод строки и `\r` в конце файла (файл, созданный в Блокноте)
  отбрасываются.
- **`apiKeyHelper` запускается через cmd.** По документации Claude Code
  (docs.claude.com/en/docs/claude-code/settings) команда `apiKeyHelper`
  выполняется в системной оболочке: `/bin/sh` на macOS и Linux и `cmd` на Windows.
  Поэтому `agent-run --init` на Windows записывает в `settings.json` команду,
  которая зовёт Git Bash по полному пути:
  `"C:\Program Files\Git\bin\bash.exe" "C:/Users/имя/.local/bin/agent-run" --print-key glm`.
  Просто `bash` в cmd может оказаться bash из WSL, поэтому путь полный.
- **`tools/glm-worker/key-helper.sh` и `tools/glm-worker/settings.json` на
  Windows не копируйте.** В `settings.json` оттуда стоит `~/.glm-worker/key-helper.sh`,
  а cmd не раскрывает `~` и не запускает `.sh`. Вместо них работает `agent-run --init glm`.
- **`cd` в команде запуска.** `cd /c/Проекты/x && claude-glm -p "…"` Agents OS читает
  как запуск исполнителя в проекте `C:\Проекты\x`. Понимаются и `cd C:/Проекты/x`,
  `cd "C:\Проекты\x"`, `cd ~/x`, относительный `cd`.
- **Проект один.** `c:\Проекты` и `C:\Проекты` это одна папка, на карте она одна.

Другие провайдеры (DeepSeek, Kimi, Qwen, MiniMax) подключаются так же, как в разделе
выше: файл `%USERPROFILE%\.agents-os\providers.json`, затем в Git Bash
`agent-run --init deepseek`, `agent-run --set-key deepseek`.

### Codex на Windows

Здесь только то, что сказано в официальной документации Codex
(https://developers.openai.com/codex, раздел про Windows), без догадок:

- Codex работает на Windows в приложении ChatGPT для Windows, в CLI и в расширении
  для IDE. Приложение может работать нативно в PowerShell с песочницей Windows, без
  WSL и виртуальной машины.
- По умолчанию рекомендуется нативная песочница Windows. WSL выбирают, если нужны
  инструменты Linux или процесс уже построен на WSL2.
- Лучшая основа: Windows 11. Актуальная Windows 10 работает по принципу «best effort»;
  практически нужна версия Windows 10 1809 или новее. Должен быть доступен `winget`.
- Для WSL: в PowerShell `wsl --install`, затем внутри WSL установщик из
  документации (`curl -fsSL https://chatgpt.com/codex/install.sh | sh`) и `codex`.
  Репозитории документация советует держать в домашней папке Linux.

Команду установки CLI для самой Windows (вне WSL) берите на странице Codex для
Windows в документации: в прочитанных страницах её нет, и здесь она не придумана.
Где именно Codex хранит сессии на Windows, документация тоже не говорит. Agents OS
ищет их в `%USERPROFILE%\.codex\sessions`; если у вас иначе, укажите папку
переменной `CODEX_SESSIONS_DIR`. На живых сессиях Codex под Windows Agents OS не
проверялся.

## Ограничения

- **Codex.** Связь «Claude запустил Codex» на карте не рисуется: распознаётся только
  запуск `claude-glm`. Отчёта для Codex нет, только переписка. Адаптер написан по
  формату файлов Codex и на живых сессиях пока не проверялся.
- **Правки через Bash** (`sed -i`, скрипты) не попадают в «Как выполнял», видны только
  Edit, Write и похожие инструменты.
- **Запись экрана.** «Скрыть пути» в меню «⋯» прячет `/Users/имя` и `C:\Users\имя`, но не названия
  проектов. Для записи держите на экране только проекты, которые можно показывать.

## Безопасность

- Ключ Z.ai хранится в Связке ключей macOS (`claude-glm-zai`) или в файле
  `~/.agents-os/keys/glm` (Linux: права 600; Windows: права папки профиля
  пользователя). Прежний `~/.config/claude-glm/key` `key-helper.sh` читает как
  запасной. В файлы проекта и в переписку ключ не попадает.
- Agents OS слушает только `127.0.0.1`, ничего никуда не отправляет и маскирует
  секреты в переписке до показа в браузере.
