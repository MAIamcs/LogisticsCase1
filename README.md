# LogisticsCase1

Каркас инструмента транспортного планирования Новосибирска: React + TypeScript +
Vite + MapLibre GL JS и отдельно запускаемый FastAPI.

**Карта использует реальные геоданные десяти районов. В разделе «Планирование»
численные показатели и критические интервалы остаются синтетическими. Раздел
«Модель загруженности» в режиме API выполняет предоставленную обученную CatBoost
и показывает её расчётный индекс 0–10 и суточный профиль. Обучение не запускается.**

## Локальный запуск

Нужны Node.js 22.12+ (CI: 24), pnpm 11.25.0 и Python 3.12 для CatBoost (CI: 3.12).
Клонирование в новый каталог:

```sh
git clone https://github.com/MAIamcs/LogisticsCase1.git ~/Desktop/LogisticsCase
cd ~/Desktop/LogisticsCase
```

В подготовленной рабочей среде `~/Desktop/LogisticsCase` — ссылка на существующий
checkout `~/Desktop/LogisticsCase1`; повторное клонирование туда не требуется.

Frontend в demo-режиме, без backend:

```sh
cd ~/Desktop/LogisticsCase/frontend
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Откройте URL из терминала, обычно `http://127.0.0.1:5173/`. Скрипт запуска копирует
канонические fixtures и географию в генерируемые каталоги `frontend/public/`.
Здания загружаются при включённом слое и приближении карты, остальные слои
независимы. В верхней панели только шкала 2026–2030. Год, показатель, сценарий и
выбранный объект сохраняются в URL: ссылкой можно поделиться или обновить страницу.

Backend запускается в отдельном терминале из корня репозитория:

```sh
cd ~/Desktop/LogisticsCase
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements-dev.lock -r backend/requirements-model.lock
python scripts/import_geography.py
python -m uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

OpenAPI: `http://127.0.0.1:8000/openapi.json`, Swagger: `http://127.0.0.1:8000/docs`.
Для локального API задайте в `frontend/.env.local` и перезапустите Vite:

```dotenv
VITE_DATA_MODE=api
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_BASE_PATH=/
```

В API-режиме ошибки показываются явно, автоматического перехода на demo нет.
Примеры среды: [frontend](frontend/.env.example), [backend](backend/.env.example).
Backend `.env.example` не загружается автоматически: переменные нужно экспортировать.

После запуска обоих процессов откройте «Модель загруженности», заполните семь
признаков и нажмите «Рассчитать». Население и полосность не подставляются:
обучающий CSV с профилями дорог не приложен. Час и четыре циклических признака
обрабатываются как в `analyzer.ipynb`. Модель не имеет признака года и не
предсказывает время проезда: переключатель 2026–2030 относится к демонстрации
планирования, а не к CatBoost. Категорию сезона нужно указать как в обучении;
подсказки не являются восстановленным словарём обучающего CSV.

Проверка готовности: `GET /api/v1/model/metadata`; расчёт:
`POST /api/v1/model/predict`. Пакетный CLI, команды Windows PowerShell, точный
формат семи признаков и ограничения — в
[инструкции интеграции модели](docs/model-integration.md).

## Проверки и сборка

Из корня, после установки зависимостей и активации `.venv`:

```sh
python scripts/export_contract.py --check
python scripts/import_geography.py
python scripts/create_forecast_fixtures.py --check
python scripts/import_geography.py --check
python scripts/validate_fixtures.py
python scripts/check_secrets.py
python -m pytest backend/tests -q
cd frontend
pnpm types:check
pnpm typecheck
pnpm test
VITE_DATA_MODE=demo VITE_BASE_PATH=/LogisticsCase1/ pnpm build
pnpm check:build --serve
```

FastAPI/Pydantic — источник OpenAPI, JSON Schema и типов TypeScript.
`types:check` проверяет типы без изменения исходников. Все статические ответы
проходят схемы и проверки семантики; `check:build` проверяет пути и идентичность
данных, с `--serve` также HTTP-загрузку ресурсов и обновление страницы.

GitHub Actions запускает backend-тесты и frontend typecheck/tests/build в обоих
режимах. Официальный Pages workflow публикует только frontend из `main` после
проверок; pull request не выполняет публикацию.

## GitHub Pages и отдельный API

Для этого репозитория путь — `/LogisticsCase1/`. Vite `base` и пути JSON/GeoJSON
учитывают префикс. Интерфейс использует одну страницу с query-параметрами и
якорями; вложенных клиентских маршрутов, требующих серверного fallback, нет.

В Settings → Pages выберите **GitHub Actions**. По умолчанию публикуется demo.
Адрес проекта после успешного deployment:
[maiamcs.github.io/LogisticsCase1/](https://maiamcs.github.io/LogisticsCase1/).
Наличие workflow само по себе не подтверждает публикацию.

Для API-режима требуется отдельно развёрнутый **HTTPS backend**. До сборки задайте
Actions variables `VITE_DATA_MODE=api`, `VITE_API_BASE_URL=https://ваш-api-хост`
(без `/api/v1`) и `VITE_BASE_PATH=/LogisticsCase1/`. На backend разрешите точный
origin `https://maiamcs.github.io` в `CORS_ALLOW_ORIGINS`, без пути и завершающего
слеша. `CORS_ALLOW_CREDENTIALS=false`; wildcard origins не используются.
Все `VITE_*` доступны посетителю — секреты туда не помещают. GitHub Pages не
запускает и не публикует FastAPI.

## Совместная работа и подключение модели

Frontend отвечает за представления, доступность и оба транспорта; backend — за
валидацию, API, CORS и провайдеры; команда модели — за исходные данные, единицы,
версии, пропуски, агрегаты и обоснованные критические интервалы. Годовая модель реализует
`ForecastProvider.get_metadata()` и `get_forecast(...)`; при смене географии
передаётся `GeographyProvider`. Для реального поставщика задаются точные
`model_version`, `data_version`, `is_demo=false` и ограничения применимости.
Контракт и маршруты сохраняются; проверочные примеры и adapter-тесты обязательны.

Предоставленная CatBoost использует отдельный `CongestionModel`: её контракт
не содержит года, сценария или критических интервалов. Существующий
`ForecastProvider` не подменяется этим индексом. Артефакт и SHA-256 находятся
в `backend/models/manifest.json`; `catboost_info` не нужен для инференса.

- [Правила участия, роли и процедура изменения контракта](CONTRIBUTING.md)
- [Архитектура и потоки данных](docs/architecture.md)
- [API и географические endpoints](docs/api-contract.md)
- [Контракт ForecastProvider: null, нулевая база, агрегаты и интервалы](docs/forecast-contract.md)
- [Источники и условия геоданных](docs/geodata.md)
- [Карта, шкалы и связанные графики](docs/map.md)
- [Разработка, ветки, PR, CI и deployment](docs/development.md)

Не редактируйте сгенерированные схемы/типы или `frontend/public/` вручную.
Не заменяйте чужие изменения, не используйте force push. Новые функции проходят
фокусированный PR с соответствующими проверками и обзором контракта.

Крупные `contracts/geography/roads.geojson` и `buildings.geojson` генерируются
из версионированного `source/osm-context.json.gz` и не хранятся повторно в Git.
Подготовка: `python3 scripts/import_geography.py` из корня. Frontend-команды
`pnpm dev`, `pnpm test` и `pnpm build` восстанавливают отсутствующие слои
автоматически; для этого нужен Python 3.11+. Содержимое GeoJSON и контрольные
суммы сохраняются без изменения.
