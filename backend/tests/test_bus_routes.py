import gzip
import json
from collections import Counter, defaultdict
from pathlib import Path

GEOGRAPHY = Path(__file__).resolve().parents[2] / "contracts/geography"


def source_json(name):
    return json.loads(gzip.decompress((GEOGRAPHY / "source" / name).read_bytes()))


def asset_json(name):
    return json.loads((GEOGRAPHY / name).read_bytes())


def edges(coordinates):
    # A member can reverse to align with the previous exact endpoint.
    return Counter(tuple(sorted((tuple(a), tuple(b)))) for a, b in zip(coordinates, coordinates[1:]))


def test_bus_chains_preserve_all_route_edges_without_bridging_gaps():
    source = source_json("osm-bus-route-members.json.gz")
    matches = source_json("osm-bus-road-matches.json.gz")
    supplied = {way["osm_id"]: way["coordinates"] for way in matches["ways"]}
    expected_edges = defaultdict(Counter)
    expected_matched = Counter()
    matched_ids = set()
    for route in source["features"]:
        properties = route["properties"]
        relation = properties["osm_relation_id"]
        assert properties["mode"] == "bus"
        for way_id, part in zip(properties["route_way_osm_ids"], route["geometry"]["coordinates"], strict=True):
            expected_edges[relation].update(edges(part))
            if way_id in supplied:
                assert supplied[way_id] in (part, part[::-1])
                expected_matched[relation] += 1
                matched_ids.add(way_id)
    assert matched_ids == supplied.keys()

    actual_edges = defaultdict(Counter)
    actual_matched = Counter()
    routes = asset_json("bus_routes.geojson")["features"]
    for chain in routes:
        properties = chain["properties"]
        relation = properties["osm_relation_id"]
        assert chain["geometry"]["type"] == "LineString"
        assert len(chain["geometry"]["coordinates"]) >= 2
        actual_edges[relation].update(edges(chain["geometry"]["coordinates"]))
        actual_matched[relation] += properties["csv_matched_way_count"]
    assert actual_edges == expected_edges
    assert actual_matched == expected_matched

    routes_by_id = {route["id"]: route for route in routes}
    assert len(routes_by_id) == len(routes)
    for corridor in asset_json("bus_corridors.geojson")["features"]:
        assert corridor == routes_by_id[corridor["id"]]
        assert corridor["properties"]["is_complete_source_chain"]
        assert corridor["properties"]["csv_matched_way_count"] > 0
