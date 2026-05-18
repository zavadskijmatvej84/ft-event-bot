# Funtime Telegram Center

Отдельный Node.js сервис рядом с Minecraft-чекером.

Что внутри:

- Telegram-бот с меню:
  - `Текущие ивенты`
  - `Предстоящие`
  - `Настройки`
- пользовательские фильтры:
  - только активные / известные
  - сортировка от меньшего к большему
  - сортировка от большего к меньшему
  - выбор нескольких ивентов
- обязательные подписки
- веб-админка:
  - список пользователей
  - история переписок
  - отправка сообщений пользователю
  - глобальные объявления
  - управление обязательными подписками
  - просмотр текущего snapshot ивентов
  - системные настройки

## Запуск

- [start-telegram-center.bat](</E:/Users/SERGEY/ft event bot/telegram-app/start-telegram-center.bat>)
- [start-admin-panel.bat](</E:/Users/SERGEY/ft event bot/telegram-app/start-admin-panel.bat>)

Оба батника поднимают один и тот же сервис.

После запуска открой:

- [http://127.0.0.1:3080](http://127.0.0.1:3080)

## Логин в админку

По умолчанию:

- логин: `admin`
- пароль: `change_me_please`

Сразу поменяй это в:

- [config/runtime-config.json](</E:/Users/SERGEY/ft event bot/telegram-app/config/runtime-config.json>)

## Откуда берутся ивенты

Сервис читает данные из:

- [run/logs/latest.log](</E:/Users/SERGEY/ft event bot/run/logs/latest.log>)

Путь можно изменить в настройках панели.

## Важно

- токен Telegram-бота уже был отправлен в чат и считается засвеченным
- лучше перевыпустить токен через `@BotFather`, потом заменить его в `runtime-config.json`
