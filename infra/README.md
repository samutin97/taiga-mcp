# Локальный стенд Taiga

Тестовый инстанс, против которого отлаживается и тестируется плагин.
Сам каталог `taiga-docker/` — клон стороннего репозитория, он не версионируется.
Здесь записано, как воссоздать его точь-в-точь.

## Требования

- Docker Desktop (WSL2-бэкенд). Демон не стартует сам — запускать вручную.
- Python 3.10+ с `requests` — для сидера.

## Развёртывание

```bash
# 1. Клон. core.autocrlf=false обязателен: CRLF ломает entrypoint-скрипты
#    внутри контейнеров, и taiga-back не поднимается.
git clone -c core.autocrlf=false --depth 1 \
    https://github.com/taigaio/taiga-docker.git infra/taiga-docker

cd infra/taiga-docker

# 2. Правки .env против дефолта:
#    - SECRET_KEY: свой случайный вместо публичного "taiga-secret-key"
#    - ENABLE_TELEMETRY=False: по умолчанию Taiga шлёт анонимную телеметрию наружу
python - <<'PY'
import re, secrets, pathlib
p = pathlib.Path(".env"); t = p.read_text(encoding="utf-8")
t = re.sub(r"^SECRET_KEY=.*$", f'SECRET_KEY="{secrets.token_urlsafe(48)}"', t, flags=re.M)
t = re.sub(r"^ENABLE_TELEMETRY=.*$", "ENABLE_TELEMETRY=False", t, flags=re.M)
p.write_text(t, encoding="utf-8")
PY

# 3. Поднять (первый раз тянет ~2-3 ГБ образов)
docker compose up -d

# 4. Дождаться миграций taiga-back
until curl -s -o /dev/null -w "%{http_code}" http://localhost:9000/api/v1/ \
      | grep -qE "^(200|401|403)$"; do sleep 5; done

# 5. Администратор
docker compose exec -T taiga-back python manage.py shell -c "
from django.contrib.auth import get_user_model
U = get_user_model()
u, _ = U.objects.get_or_create(username='admin',
    defaults={'email':'admin@taiga.local','full_name':'Local Admin'})
u.set_password('TaigaLocal2026!')
u.is_superuser = u.is_staff = u.is_active = True
u.save()
"

# 6. Тестовые данные
cd ../.. && python infra/seed_test_data.py
```

## Доступ

| | |
|---|---|
| UI | http://localhost:9000 |
| API | http://localhost:9000/api/v1 |
| Логин | `admin` / `TaigaLocal2026!` |

Одноразовые креды локального стенда. В плагин не попадают.

## Что создаёт сидер

Проект **MCP Sandbox** (`mcp-sandbox`): 2 спринта, 2 эпика, 9 user stories
с разными статусами и оценками, 6 задач, 4 issue, 3 комментария, wiki-страница.

Заодно заводит второго участника проекта — `tester2` / «Tester Two» — тем
же способом, что и админа (шаг 5); он нужен, чтобы проверять распределение
задач между разными людьми (`taiga_stats.load`), а не только на одном админе.

Пересоздать данные — просто запустить сидер ещё раз (создаст новый проект).

## Управление

```bash
cd infra/taiga-docker
docker compose ps                  # состояние
docker compose stop                # остановить, данные сохраняются
docker compose up -d               # поднять обратно
docker compose down -v             # снести вместе с данными
docker compose logs -f taiga-back  # логи API
```

## Версии

Taiga **6.9.0**. Версия инстанса читается плагином при старте и попадает
в диагностику скилла `taiga-setup` — на бою версия может отличаться.
