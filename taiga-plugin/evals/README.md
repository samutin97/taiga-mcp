# Evals: taiga-plugin

`--case <glob>` matches only the **leaf directory name** of a case — not its
full path. Every skill's activation case lives at `<skill>/positive-1/` and
`<skill>/negative-1/`, so the leaf name is always `positive-1` or
`negative-1` (never e.g. `taiga-setup/positive-1`); a glob like
`taiga-setup/*` or `taiga-*` matches nothing (`No eval cases found matching
--case "…"`) — there is no case whose *name* starts with `taiga-`, only
cases whose *path* does. Voice cases live at `voice/1` … `voice/6`, so their
leaf name is a bare digit.

## Как запускать обычный набор (без `holdout/`)

Активация — двумя проходами (позитив и негатив), голос — третьим:

```bash
cd taiga-plugin
claude plugin eval . --case "positive-1" --runs 3 --max-cost-usd 15 --threshold 0.8 --no-publish --trust-plugin
claude plugin eval . --case "negative-1" --runs 3 --max-cost-usd 15 --threshold 0.8 --no-publish --trust-plugin
claude plugin eval . --case "?"          --ablation none --runs 3 --max-cost-usd 15 --threshold 0.8 --no-publish --trust-plugin
```

(`--ablation none` on the voice run: see "Что значат дельты" below — the
`without` arm has no mocked MCP server at all, so a voice case's graders have
literally nothing to check there, which only burns budget without signal.
`--case "?"` — a single-character glob — is how you reach the six
one-character voice case names (`1`…`6`); `[1-6]` looks like it should work
but returns zero matches, the matcher doesn't treat it as a character class.)

Each of the three globs above was confirmed to return `casesTotal > 0` in
`--json` before being written here (10, 10 and 6 respectively — see
task-20-fix-report.md §4 for the runs that did it); `taiga-*`,
`taiga-setup/*`, `[1-6]` and `*` were tried first and confirmed to return
**zero**, **zero**, **zero** and **all 29** cases respectively, which is why
only `positive-1`/`negative-1`/`?` appear above.

## `holdout/` — не входит в обычный набор, запускать отдельно

`holdout/` is excluded from both commands above (their globs don't reach
into it by name collision, but don't rely on that — always target it
explicitly and run it alone). Not used while tuning a skill's description or
body; run once at acceptance, after the regular suite is green:

```bash
claude plugin eval . --case "stories-from-spec" --runs 3 --max-cost-usd 5 --no-publish --trust-plugin
claude plugin eval . --case "prioritize"        --runs 3 --max-cost-usd 5 --no-publish --trust-plugin
claude plugin eval . --case "voice"             --ablation none --runs 3 --max-cost-usd 5 --no-publish --trust-plugin
```

(These three globs are plain multi-character leaf names, the same shape as
`positive-1`/`negative-1` that were verified to work — they were not
separately run this round: fix round 1 explicitly excluded `holdout/` from
the run that verified the other globs.)

## Структура

- `<skill>/positive-1/` и `<skill>/negative-1/` — по одному кейсу активации на
  каждый из 10 вызываемых скиллов (`taiga-voice` не вызывается напрямую и своих
  кейсов активации не имеет — ни `positive-1`, ни `negative-1`). Промпт —
  как запрос набрал бы пользователь, без имени скилла.
  - `positive-1/graders/skill.md` (`type: tool_used`, `tool: Skill`,
    `input_match: <имя скилла>`, `arm: both`) — скилл обязан сработать.
    `arm: both` — намеренное отступление от умолчания `with-only` для
    `tool: Skill`: без него грейдер не входит в счёт ни в одной руке
    (`with-only` не скорится), а без другого outcome-грейдера в кейсе счёт
    остаётся нулевым в обеих руках и сравнивать нечего — здесь именно этот
    грейдер и есть то единственное, что должно отличать `with` от `without`.
  - `negative-1/graders/skill.md` — тот же грейдер, `min: 0, max: 0` — этот
    конкретный скилл не должен сработать.
  - `negative-1/graders/no-taiga-skill.md` — `input_match: taiga-`,
    `min: 0, max: 0` — **никакой** `taiga-*` скилл не должен сработать, не
    только целевой (иначе кейс не ловит модель, которая на офтопик-вопрос
    ошибочно дёргает соседний скилл).
  - `taiga-backlog-grooming/positive-1`, `taiga-prioritize/positive-1` и
    `taiga-backlog-health/positive-1` дополнительно несут по два
    sibling-грейдера (`graders/sibling-*.md`, тот же `tool_used`,
    `min:0,max:0,arm:both`) — три скилла легко перепутать по формулировке
    запроса, и позитивный кейс должен доказывать не только «этот скилл
    сработал», но и «сработал именно этот, а не один из двух других».
- `voice/1..6` — шесть кейсов голоса: история, задача, issue, комментарий,
  bulk из трёх историй, `append_description`. Промпт даёт исходник (заметки
  со встречи, чата поддержки и т.п.), просит завести это в Taiga и явно
  разрешает писать сразу, без уточняющих вопросов (однопроходный harness не
  даёт кейсу второго хода пользователя, чтобы ответить на уточнение — без
  этой оговорки модель, следуя `taiga-voice` про «показать текст перед
  записью», один раз так и не написала ничего, см. task-20-fix-report.md).
  Три грейдера:
  - `graders/regex.md` (`type: regex`, `target: mock_calls`,
    `match: not_contains`) — одна комбинированная регулярка из `hard`
    (`ai-authorship`) плюс `heading-label`, `as-a-user`, `emoji` из
    `scripts/voice-rules.json`. Эти три правила в исходнике анкерятся `^` —
    но `mock_calls` отдаёт JSON-трассу вызовов, где каждая «строка» на деле
    начинается с `{"tool":…`, так что голый `^` (даже с флагом `m`) никогда
    не совпадёт с началом значения поля. Анкер расширен до
    `(?:^|\n|")[ \t]*`, чтобы ловить совпадение сразу после открывающей
    кавычки JSON-строки — `server/test/evals.test.ts` пересобирает этот же
    паттерн из `scripts/voice-rules.json` и проверяет побайтовое совпадение
    с тем, что лежит в каждом из 7 файлов.
  - `graders/voice-judge.md` (`type: llm`, `focus: mock_calls`) — бинарный
    судья. `focus`/`target` во всей схеме рантайма (`regex`, `llm`) не имеют
    отдельного «фильтра по инструменту» — только `trace | last_message |
    files | mock_calls | {source:file,path}` — так что нет способа показать
    судье только вход пишущих вызовов на уровне схемы; вместо этого сам
    промпт судьи явно перечисляет, какие поля (`subject`, `description`,
    `comment`, `append_description`, `blocked_note`) внутри `input`
    пишущих вызовов (`…_create`, `…_update`, `comment_add`, `bulk_create`)
    оценивать, а имена инструментов, id, структуру JSON, ответы (`output`) и
    вызовы на чтение — игнорировать.
  - `graders/wrote.md` (`type: tool_used`, конкретный
    `mcp__plugin_taiga_taiga__taiga_<tool>` этого кейса, `min: 1`,
    `arm: both`) — без него прогон, который дошёл только до `taiga_whoami` и
    ничего не написал, всё равно получал `score: 0.5` («нечего проверять» ⇒
    оба остальных грейдера трактовали пусто как «чисто»/тривиальный провал
    вместо явного нуля).
- `holdout/` — по одному дополнительному кейсу для `taiga-stories-from-spec`,
  `taiga-prioritize` и голоса. **Не входит в обычный прогон**, не
  используется при доводке описаний скиллов — только чтобы разово
  подтвердить на приёмке, что скилл не переобучен под конкретные
  формулировки из `positive-1`/`voice/N`. Смотри команды выше.
- `mocks/plugin_taiga_taiga/` — канонические ответы MCP-сервера плагина для
  `--mocks record` (по умолчанию, без `--allow-real-servers`): `_tools.json`
  — **полный** срез `tools/list`, все 42 инструмента плагина (не только
  замоканные — без записи здесь агент видит инструмент с «permissive
  schema» и без описания, даже если знает его имя) — и по одному `<tool>.md`
  (`type: fixed`, тело — сырой JSON) на 21 инструмент: `taiga_whoami`,
  `taiga_project_schema`, `taiga_userstory_list` (9 историй стенда, slim),
  `taiga_userstory_get` (полная форма истории #5), `taiga_task_list`,
  `taiga_task_update`, `taiga_issue_list`, `taiga_sprint_list`,
  `taiga_sprint_get`, `taiga_epic_list`, `taiga_epic_create`,
  `taiga_comment_list`, `taiga_search`, `taiga_attachment_list`,
  `taiga_stats`, `taiga_userstory_create`, `taiga_task_create`,
  `taiga_issue_create`, `taiga_comment_add`, `taiga_bulk_create`,
  `taiga_userstory_update` — у созданных/обновлённых записей заведомо
  фиктивные `ref` (9001+), не пересекающиеся с реальными данными стенда.
  Остальные 21 инструмента плагина видны агенту по имени и схеме (из
  `_tools.json`), но не имеют своего `<tool>.md` — вызов любого из них
  вернётся как немокнутый (нет ответа), так что кейсы намеренно не просят
  того, что требует одного из них.

  **`taiga_stats` — один фиксированный (project-scope) ответ.** У этого
  инструмента ОДИН канонический ответ на любые аргументы — реальный вызов
  умеет как `taiga_stats` без `sprint` (числа по всему проекту), так и с
  `sprint: "Sprint N"` (бёрндаун по дням), но responder `fixed` не различает
  входные аргументы: что бы кейс ни передал, вернётся один и тот же ответ
  уровня проекта. Значит под моками спринтовая ветка `taiga_stats` не
  проверяется вообще — если это понадобится, нужен `type: agent` responder
  (`_server.md` с прозой и `abort_when`) вместо `fixed`, здесь не заводили.

  Промпты выровнены под то, что реально есть в моках: `taiga_sprint_report`
  спрашивает про «спринт 1» (моки знают только Sprint 1/Sprint 2, третьего
  нет), `taiga_test_plan` — про историю «#5» (реальный диапазон рефов в
  `taiga_userstory_list` — 3–11, никакого #42).

## Что значат дельты

`--ablation with-without` запускает каждый кейс дважды: «с плагином» и «без».
Для кейсов активации (`positive-1`/`negative-1`) дельта — это буквально
разница между «скилл вызвался» и «скилла и его триггеров вообще не существует
для модели». Единица — ожидаемый результат для позитивных кейсов, ноль — для
негативных (в обеих руках, поскольку `min: 0, max: 0` выполняется тривиально
и без плагина). Провал позитивного кейса **без** плагина — не находка, это
и есть работающий контроль (без скилла результата взяться неоткуда). Провал
**с** плагином — повод править триггеры в `description` скилла или его тело,
а не сам кейс: скилл либо не подхватывает фразу пользователя, либо жанр
промпта пересекается с другим скиллом сильнее, чем с целевым.

Для кейсов `voice/*` дельта не содержательна: без плагина мокнутого
MCP-сервера не существует ни в каком виде, `mock_calls`-грейдерам буквально
нечего проверять («no mock stand-ins were active in this run»). Обычный
прогон голоса — `--ablation none`.

## Доводка скиллов

При правке `description`/тела скилла из-за провала `positive-1`/`negative-1`
или `voice/N` — не трогайте формулировки `holdout/`. Если после исправления
`holdout/*` тоже проходит — хорошо, но это не критерий приёмки самого
исправления (тот — обычный набор); если `holdout/*` начинает шататься при
стабильном обычном наборе, это сигнал, что описание скилла подогнано под
конкретные фразы, а не под класс запросов.
