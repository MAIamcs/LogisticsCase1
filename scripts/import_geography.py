"""Rebuild local Novosibirsk geography from retained, attributed source snapshots.

Normal/check operation uses only the standard library and retained snapshots.
To refresh the OSM subset from a regional .osm.pbf, additionally install
osmium==4.3.2 and shapely==2.2.0, then pass --osm-pbf PATH. No coordinates are
invented or manually traced. Administrative contours are never simplified.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "contracts" / "geography"
RETRIEVED_AT = "2026-11-09"
GEOGRAPHY_VERSION = "nsk-geography-2026-11-11"
DISTRICT_URL = "https://maps.nso.ru/arcgis2/rest/services/Common/Boundary/MapServer/7"
DISTRICT_QUERY = DISTRICT_URL + "/query?where=1%3D1&outFields=*&outSR=4326&f=json"
OSM_EXTRACT = "https://builder.osmand.net/osm-extract/russia_novosibirsk_asia/russia_novosibirsk_asia.pbf"
# Actual city districts plus a small context margin. The analytical camera is
# derived separately from administrative polygons, never from this rectangle.
CONTEXT_BBOX = (82.745, 54.795, 83.17, 55.205)
SLUGS = {
    "Дзержинский": "dzerzhinsky", "Железнодорожный": "zheleznodorozhny",
    "Заельцовский": "zaeltsovsky", "Калининский": "kalininsky",
    "Кировский": "kirovsky", "Ленинский": "leninsky",
    "Октябрьский": "oktyabrsky", "Первомайский": "pervomaysky",
    "Советский": "sovetsky", "Центральный": "tsentralny",
}


def encoded(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": sorted(features, key=lambda f: f["id"])}


def signed_area(ring: list[list[float]]) -> float:
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def districts() -> dict:
    source = json.loads((DIRECTORY / "source" / "districts.esri.json").read_text())
    assert source["spatialReference"]["wkid"] == 4326
    assert len(source["features"]) == len(SLUGS) == 10
    features = []
    for item in source["features"]:
        name = item["attributes"]["District"]
        identifier = "district-" + SLUGS[name]
        polygons = []
        for ring in item["geometry"]["rings"]:
            assert len(ring) >= 4 and ring[0] == ring[-1]
            # All supplied ESRI rings are clockwise outer rings, not holes.
            # Калининский has two disconnected exteriors including Пашино.
            assert signed_area(ring) < 0, "Source topology changed: review ring nesting before importing"
            polygons.append([list(reversed(ring))])
        geometry = {"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1 else {"type": "MultiPolygon", "coordinates": polygons}
        features.append({"type": "Feature", "id": identifier, "properties": {
            "feature_id": identifier, "name": name + " район",
            "source_id": "nso-boundary-7-object-" + str(item["attributes"]["OBJECTID"]),
        }, "geometry": geometry})
    assert {f["properties"]["name"] for f in features} == {name + " район" for name in SLUGS}
    return collection(features)


def extract_osm(path: Path) -> dict:
    # These tools are import-time tooling only, not backend runtime dependencies.
    import osmium
    from shapely.geometry import box, mapping, shape

    region = box(*CONTEXT_BBOX)
    factory = osmium.geom.GeoJSONFactory()
    layers: dict[str, dict[str, dict]] = {name: {} for name in ["roads", "buildings", "water", "stops"]}
    drivable = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}

    def overlaps_nodes(rings) -> bool:
        # Reject most of the regional extract before JSON/Shapely conversion.
        x0 = y0 = float("inf")
        x1 = y1 = float("-inf")
        for ring in rings:
            for node in ring:
                if not node.location.valid():
                    continue
                x0 = min(x0, node.lon); x1 = max(x1, node.lon)
                y0 = min(y0, node.lat); y1 = max(y1, node.lat)
        return not (x1 < CONTEXT_BBOX[0] or x0 > CONTEXT_BBOX[2] or y1 < CONTEXT_BBOX[1] or y0 > CONTEXT_BBOX[3])

    def add(layer: str, osm_type: str, identifier: int, tags: dict[str, str], geometry: dict, clip: bool = False):
        geometry_shape = shape(geometry)
        if geometry_shape.is_empty or not region.intersects(geometry_shape):
            return
        if clip:
            # Only context water is cropped to the advertised coverage. District
            # borders and road/building vertices are retained without smoothing.
            if not geometry_shape.is_valid:
                return
            geometry_shape = geometry_shape.intersection(region)
            if geometry_shape.is_empty or geometry_shape.geom_type not in {"Polygon", "MultiPolygon", "LineString", "MultiLineString"}:
                return
            geometry = mapping(geometry_shape)
        feature_id = f"osm-{osm_type}-{identifier}"
        properties = {"feature_id": feature_id, "source_id": feature_id,
            "category": {"roads": "road", "buildings": "building", "water": "water", "stops": "station"}[layer],
            "kind": tags.get("highway", tags.get("waterway", tags.get("water", tags.get("building", tags.get("railway", ""))))),
            "name": tags.get("name:ru", tags.get("name", ""))}
        if layer == "stops" and not properties["name"]:
            properties["name"] = "Станция без названия в OpenStreetMap"
        layers[layer][feature_id] = {"type": "Feature", "id": feature_id, "properties": properties, "geometry": geometry}

    class Handler(osmium.SimpleHandler):
        def node(self, node):
            tags = dict(node.tags)
            if tags.get("railway") in {"station", "halt"} and node.location.valid():
                add("stops", "node", node.id, tags, {"type": "Point", "coordinates": [node.location.lon, node.location.lat]})

        def way(self, way):
            tags = dict(way.tags)
            is_road = tags.get("highway") in drivable
            is_water = tags.get("waterway") in {"river", "stream", "canal"}
            if not (is_road or is_water):
                return
            if not overlaps_nodes([way.nodes]):
                return
            try:
                geometry = json.loads(factory.create_linestring(way))
                if is_road:
                    add("roads", "way", way.id, tags, geometry)
                if is_water:
                    add("water", "way", way.id, tags, geometry, clip=True)
            except (osmium.InvalidLocationError, RuntimeError):
                pass

        def area(self, area):
            tags = dict(area.tags)
            is_building = "building" in tags and tags["building"] != "no"
            is_water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank" or tags.get("landuse") == "reservoir"
            if not (is_building or is_water):
                return
            if not overlaps_nodes(area.outer_rings()):
                return
            try:
                geometry = json.loads(factory.create_multipolygon(area))
                osm_type = "way" if area.from_way() else "relation"
                if is_building:
                    add("buildings", osm_type, area.orig_id(), tags, geometry)
                if is_water:
                    add("water", osm_type, area.orig_id(), tags, geometry, clip=True)
            except (osmium.InvalidLocationError, RuntimeError):
                pass

    Handler().apply_file(str(path), locations=True, idx="flex_mem")
    return {"source_url": OSM_EXTRACT, "retrieved_at": RETRIEVED_AT,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bbox": CONTEXT_BBOX, "layers": {name: collection(list(features.values())) for name, features in layers.items()}}


def outputs(snapshot: dict) -> dict[str, bytes]:
    from build_bus_routes import artifacts as bus_artifacts

    result = {"districts.geojson": encoded(districts())}
    for name, layer in snapshot["layers"].items():
        result[name + ".geojson"] = encoded(layer)
    result.update(bus_artifacts())
    sources = [{
        "id": "nso-boundary", "name": "Геопортал Новосибирской области — Границы районов г. Новосибирск",
        "url": DISTRICT_URL, "query_url": DISTRICT_QUERY,
        "license": "Условия повторного использования не опубликованы в метаданных слоя",
        "license_url": DISTRICT_URL, "attribution": "Геопортал Новосибирской области",
        "retrieved_at": RETRIEVED_AT,
        "description": "Опубликованный GIS-слой; дата вступления юридических границ в силу в метаданных не указана. Полные координаты сохранены без упрощения.",
    }, {
        "id": "osm", "name": "OpenStreetMap contributors; региональный extract OsmAnd",
        "url": OSM_EXTRACT, "license": "ODbL-1.0", "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
        "attribution": "© OpenStreetMap contributors", "attribution_url": "https://www.openstreetmap.org/copyright",
        "retrieved_at": snapshot["retrieved_at"], "source_sha256": snapshot["source_sha256"],
        "description": "Срез реальных объектов OpenStreetMap, без синтетических геометрий. Полнота объектов зависит от исходной базы.",
    }]
    details = {
        "districts": ("Районы", "nso-boundary", ["Polygon", "MultiPolygon"], "10 районов города; исходные контуры областного GIS без упрощения."),
        "roads": ("Дороги", "osm", ["LineString", "MultiLineString"], "Автомобильные дороги OpenStreetMap; класс дороги передан в kind."),
        "bus-routes": ("Автобусные маршруты", "osm", ["LineString"], "Связные цепочки дорожных участков из автобусных отношений OpenStreetMap."),
        "bus-corridors": ("Коридоры планирования", "osm", ["LineString"], "Пять полных направлений маршрутов для демонстрационных показателей."),
        "buildings": ("Здания", "osm", ["Polygon", "MultiPolygon"], "Контуры зданий OpenStreetMap во всём охвате города; не кадастровые сведения."),
        "water": ("Реки и водоёмы", "osm", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"], "Реки, ручьи, каналы, водоёмы OpenStreetMap; обрезаны по охвату фоновых слоёв."),
        "stops": ("Станции", "osm", ["Point"], "Имеющиеся в OpenStreetMap железнодорожные станции и станции метро; не полный реестр остановок."),
    }
    layer_descriptors = []
    for identifier, (name, source_id, geometry_types, description) in details.items():
        filename = identifier.replace("-", "_") + ".geojson"
        data = json.loads(result[filename])
        layer_descriptors.append({"id": identifier, "name": name, "file": filename, "source_id": source_id,
            "geometry_types": geometry_types, "feature_count": len(data["features"]), "description": description,
            "sha256": hashlib.sha256(result[filename]).hexdigest()})
    result["manifest.json"] = encoded({"geography_version": GEOGRAPHY_VERSION, "retrieved_at": RETRIEVED_AT,
        "is_synthetic": False, "bbox": list(CONTEXT_BBOX), "sources": sources, "layers": layer_descriptors})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--osm-pbf", type=Path, help="Refresh the retained OSM subset from a local regional PBF")
    parser.add_argument("--check", action="store_true", help="Verify generated local assets against retained source snapshots")
    args = parser.parse_args()
    snapshot_path = DIRECTORY / "source" / "osm-context.json.gz"
    if args.osm_pbf:
        if args.check:
            parser.error("--check cannot refresh the source; use it separately")
        snapshot = extract_osm(args.osm_pbf)
        snapshot_path.write_bytes(gzip.compress(encoded(snapshot), mtime=0))
    else:
        snapshot = json.loads(gzip.decompress(snapshot_path.read_bytes()))
    expected = outputs(snapshot)
    for name, content in expected.items():
        target = DIRECTORY / name
        if args.check:
            assert target.read_bytes() == content, f"Geography asset differs from retained source: {name}"
        else:
            target.write_bytes(content)
    for name, layer in snapshot["layers"].items():
        print(f"{name}: {len(layer['features'])} features")
    print("Geography assets are current" if args.check else "Geography assets generated")


if __name__ == "__main__":
    main()
