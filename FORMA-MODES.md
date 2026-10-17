# Forma — четыре уровня и независимые Thinking Effort

Кнопка выбора уровня расположена справа возле отправки сообщения. Её ширина соответствует самому длинному названию — **Intensive**. При нажатии **под кнопкой**, как на макете, открывается компактное меню с четырёхступенчатым ползунком: белый бегунок следует за мышкой, оранжевая полоса заполняется позади него и после отпускания фиксируется на ближайшей ступени. Заблокированные уровни выбрать нельзя.

Уровни: **Minimal**, **Moderate**, **Intensive**, **Extreme**. По умолчанию доступны первые два. Reasoning и Speed расположены на отдельных строках, их подменю открываются отдельно. Значения по умолчанию: **Medium** для Reasoning и **Normal** для Speed. Переключение уровня само по себе не меняет эти значения.

## Настройка без изменения кода

Редактируйте `config/modes.yaml`, а не `config/modes.example.yaml`. Forma перечитывает YAML при следующем обращении к API.

- `levels.minimal.enabled`, `levels.moderate.enabled`, `levels.intensive.enabled`, `levels.extreme.enabled` — доступность **каждой ступени**.
- `levels.<уровень>.models.<reasoning>.enabled` — **отдельная блокировка каждого Thinking Effort внутри каждого уровня**. Это 4 × 5 = 20 независимых `enabled`. Например, `levels.minimal.models.high.enabled: false` отключает High только для Minimal, но не для Moderate.
- `levels.<уровень>.models.<reasoning>.<speed>` — назначение реальной модели Ollama. Например, `levels.minimal.models.medium.normal`. Пока ничего не назначено, оставляйте `""`.
- `speed.normal.enabled`, `speed.fast.enabled` — два общих переключателя Speed (их не меняли).
- `custom.enabled` — включение/выключение Custom. Для каждого из пяти `custom.options.option_1` … `option_5` есть собственные `enabled` и `label`. Эти пункты пока не связаны с маршрутизацией запросов.

Пример **фрагмента** файла (не заменяйте им весь YAML):

```yaml
levels:
  minimal:
    enabled: true
    models:
      low:
        enabled: true
        normal: ""
        fast: ""
      medium:
        enabled: true
        normal: "your-installed-model:tag"
        fast: ""
      high:
        enabled: false
        normal: ""
        fast: ""
  moderate:
    enabled: true
    models:
      high:
        enabled: true  # High для Moderate не зависит от High для Minimal
        normal: ""
        fast: ""
```

Остальные поля приведены в полном `config/modes.yaml`. Для переключателя `enabled` используются только значения `true` и `false` в нижнем регистре.

Блокировки применяются как в интерфейсе, так и при обработке запроса сервером. Если модель не назначена, отправка недоступна, даже если все нужные переключатели включены. Идентификаторы моделей **не отправляются в браузер**: API сообщает только о доступности и показывает подписи Custom.

Исторические сообщения с Core, Plus, Pro и Ultra читаются соответственно как Minimal, Moderate, Intensive и Extreme. Данные и структура БД в этой версии не изменялись.
