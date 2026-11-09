"""Deterministic, invented demonstration data. Never a forecast or observed dataset."""
import json
from pathlib import Path

TARGET = Path(__file__).resolve().parents[1] / "contracts" / "fixtures"
META = {
    "schema_version": "1.0", "source": "synthetic", "is_synthetic": True,
    "disclaimer": "Синтетические данные для демонстрации интерфейса. Не прогноз и не фактические измерения. Геометрия связей схематична.",
}
SCENARIOS = [
    {"id": "morning", "name": "Утренний час пик", "description": "Учебный набор транспортных связей агломерации", "period": "07:00–09:00"},
    {"id": "evening", "name": "Вечерний час пик", "description": "Второй учебный набор для проверки смены сценария", "period": "17:00–19:00"},
]
CORRIDORS = [
    ("c1", "Центр — Академгородок", "Центр", "Академгородок", 32.4, 46, 86, 28400,
     [[82.931, 55.03], [82.951, 55.009], [82.983, 54.978], [83.045, 54.946], [83.091, 54.912], [83.106, 54.854]]),
    ("c2", "Площадь Маркса — Центр", "Площадь Маркса", "Центр", 8.6, 24, 72, 23100,
     [[82.893, 54.982], [82.909, 54.995], [82.926, 55.006], [82.942, 55.019], [82.931, 55.03]]),
    ("c3", "Обь — Новосибирск", "Обь", "Новосибирск", 22.1, 35, 54, 12600,
     [[82.692, 54.997], [82.744, 54.999], [82.81, 54.997], [82.857, 54.989], [82.893, 54.982]]),
    ("c4", "Калининский район — Центр", "Калининский район", "Центр", 11.2, 28, 79, 19400,
     [[82.967, 55.105], [82.957, 55.082], [82.951, 55.06], [82.942, 55.043], [82.931, 55.03]]),
    ("c5", "Академгородок — Бердск", "Академгородок", "Бердск", 16.8, 22, 38, 8700,
     [[83.106, 54.854], [83.12, 54.831], [83.13, 54.802], [83.111, 54.762]]),
    ("c6", "Кольцово — Академгородок", "Кольцово", "Академгородок", 18.3, 26, 47, 6200,
     [[83.181, 54.937], [83.16, 54.917], [83.13, 54.887], [83.106, 54.854]]),
]


def write(name, value):
    TARGET.mkdir(parents=True, exist_ok=True)
    (TARGET / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


write("scenarios.json", {"meta": META, "data": SCENARIOS})
for index, scenario in enumerate(SCENARIOS):
    features = []
    for i, (id_, name, from_, to, length, minutes, load, trips, coordinates) in enumerate(CORRIDORS):
        properties = {
            "id": id_, "name": name, "from_name": from_, "to_name": to,
            "load_percent": load if index == 0 else max(0, min(100, load + (8 if i % 2 else -9))),
            "travel_time_min": minutes if index == 0 else minutes + (4 if i % 2 else -3),
            "length_km": length, "daily_trips": trips if index == 0 else trips + (1200 if i % 2 else -800),
        }
        features.append({"type": "Feature", "id": id_, "geometry": {"type": "LineString", "coordinates": coordinates}, "properties": properties})
    values = [feature["properties"] for feature in features]
    write(f'{scenario["id"]}.json', {
        "meta": META,
        "data": {"scenario": scenario, "summary": {
            "daily_trips": sum(p["daily_trips"] for p in values),
            "mean_travel_time_min": round(sum(p["travel_time_min"] for p in values) / len(values), 1),
            "mean_load_percent": round(sum(p["load_percent"] for p in values) / len(values), 1),
        }, "corridors": {"type": "FeatureCollection", "features": features}},
    })

# Local, deliberately schematic backdrop. No third-party tile/font requests.
context = []


def shape(kind, coordinates, category):
    context.append({"type": "Feature", "properties": {"category": category}, "geometry": {"type": kind, "coordinates": coordinates}})


river = [[82.78, 55.16], [82.82, 55.11], [82.868, 55.065], [82.883, 55.02], [82.917, 54.972], [82.99, 54.923], [83.016, 54.868], [83.04, 54.82], [83.07, 54.75]]
shape("Polygon", [river + [[x - 0.024, y] for x, y in reversed(river)] + [river[0]]], "water")
for x, y, width, height in [(82.95, 55.09, .04, .028), (83.055, 54.87, .048, .035), (82.82, 54.945, .045, .025), (83.12, 54.95, .046, .028), (83.08, 54.785, .04, .02)]:
    shape("Polygon", [[[x, y], [x + width, y + .006], [x + width * .9, y + height], [x - .01, y + height * .8], [x, y]]], "park")
for i in range(13):
    x = 82.81 + i * .018
    shape("LineString", [[x, 54.97], [x + .022, 55.045], [x + .01, 55.10]], "street")
for i in range(9):
    y = 54.971 + i * .014
    shape("LineString", [[82.80, y], [82.92, y + .006], [83.05, y - .005]], "street")
for _, _, _, _, _, _, _, _, line in CORRIDORS:
    shape("LineString", line, "road")
write("context.geojson", {"type": "FeatureCollection", "features": context})
