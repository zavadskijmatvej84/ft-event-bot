# Funtime Event Bot 1.21.8

Клиентский Fabric-мод для Minecraft `1.21.8`, который:

- открывает GUI на `Right Shift`
- имеет кнопки `Start` / `Stop`
- по очереди обходит анархии:
  - `/an101 - /an114`
  - `/an201 - /an236`
  - `/an301 - /an323`
  - `/an501 - /an514`
  - `/an901 - /an904`
- после входа на анархию пишет `/event delay`
- парсит ответ из чата
- ставит анархию в приоритет на время таймера `+ 5 секунд`
- если анархия переполнена, делает еще `5` попыток
- если после 5 попыток не вошел, ставит повтор через `1 минуту`
- умеет отправлять результат в Telegram
- имеет in-game account switcher с применением выбранной сессии
- умеет слать `/login` и `/register` для выбранного профиля

## Быстрый старт

1. Запусти [download-sources.bat](/E:/Users/SERGEY/ft%20event%20bot/download-sources.bat), если хочешь сразу подтянуть исходники Minecraft/Fabric для IDE.
2. Запусти [start.bat](/E:/Users/SERGEY/ft%20event%20bot/start.bat), чтобы открыть dev-клиент `1.21.8`.
3. Зайди на сервер.
4. Нажми `Right Shift`.
5. Открой конфиг кнопкой `Open config`.
6. Заполни Telegram и аккаунты.
7. Нажми `Start`.

## Батники

- [start.bat](/E:/Users/SERGEY/ft%20event%20bot/start.bat): запускает `runClient`
- [build.bat](/E:/Users/SERGEY/ft%20event%20bot/build.bat): собирает jar
- [download-sources.bat](/E:/Users/SERGEY/ft%20event%20bot/download-sources.bat): тянет sources для IDE
- [install-mod.bat](/E:/Users/SERGEY/ft%20event%20bot/install-mod.bat): собирает jar и копирует его в выбранную папку `mods`

## Конфиг

После первого запуска мод создаст:

- [config/funtime-event-watcher.properties](</E:/Users/SERGEY/ft event bot/run/config/funtime-event-watcher.properties>)

Главные поля:

- `anarchy_commands`: список анок через запятую; понимает и диапазоны вроде `101-114`
- `telegram_enabled=true|false`
- `telegram_bot_token=...`
- `telegram_chat_id=...`
- `telegram_send_mode=changes|all`
- `max_full_retries=5`
- `full_retry_cooldown_ticks=1200`
- `priority_offset_ticks=100`

### Формат account_profiles

Формат одной записи:

`label|username|uuid|accessToken|xuid|clientId|accountType|loginCommand|registerCommand`

Пример:

```properties
account_profiles=main|PlayerOne|||||LEGACY|/login pass123|/register pass123 pass123;alt|PlayerTwo|||||LEGACY|/login pass456|/register pass456 pass456
```

Что важно:

- `label`: имя профиля в GUI
- `username`: ник, который будет применен в клиентской сессии
- `uuid`: можно оставить пустым, тогда сгенерируется offline UUID
- `accessToken`, `xuid`, `clientId`: заполняй, только если у тебя есть реальные session-данные
- `accountType`: `LEGACY`, `MOJANG` или `MSA`
- `loginCommand` и `registerCommand`: команды для сервера

Старый короткий формат тоже поддерживается:

```properties
account_profiles=main|/login pass123|/register pass123 pass123
```

В таком случае `label` будет использован как ник для session switch.

## Как работает бот

1. Берет следующую анархию по кругу.
2. Пишет команду входа, например `/an101`.
3. Ждет переключение.
4. Пишет `/event delay`.
5. Если получает таймер, запоминает его.
6. Когда таймер заканчивается и проходит еще 5 секунд, эта анархия попадает в приоритетную очередь.
7. Если таких анархий несколько, они обрабатываются по очереди.
8. Потом бот возвращается к обычному циклу с того места, где был.

## Важные замечания

- Account switcher меняет текущую клиентскую сессию, но после кнопки `Apply account` нужно переподключиться.
- Для настоящего premium-переключения нужны валидные session-данные аккаунта.
- Если FunTime поменяет точный текст ответа `/event delay`, возможно, придется слегка поправить парсер.
- Telegram по умолчанию выключен, пока ты не вставишь токен и chat id.
