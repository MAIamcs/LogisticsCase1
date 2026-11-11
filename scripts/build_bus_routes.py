"""Offline bus-route display chains from retained OSM relation member ways.

Only consecutive pieces sharing an exact endpoint are merged. Disconnected
pieces remain separate features; no straight connectors or street-name joins.
Run from any directory: python scripts/build_bus_routes.py [--check].
"""
import argparse
import csv
import gzip
import hashlib
import json
from math import isfinite
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "contracts/geography/source/osm-bus-route-members.json.gz"
ROAD_MATCHES = ROOT / "contracts/geography/source/osm-bus-road-matches.json.gz"
PBF_SHA256 = "f4b91aaf673d32904fbbce902a2c069fcc5479f439109728624b68289e42cb47"
# Complete city routes in the retained OSM snapshot; these are demonstration
# corridors, not an asserted match to the model's unidentified training roads.
REFERENCE_RELATIONS = (18674224, 1694925, 13758152, 13766528, 13761753)


def connected_chains(pieces):
    chain = []
    way_ids = []
    for way_id, original in pieces:
        if len(original) < 2:
            raise ValueError("A source member way must have at least two positions")
        piece = original
        if chain and chain[-1] == piece[-1]:
            piece = list(reversed(piece))
        if chain and chain[-1] == piece[0]:
            chain.extend(piece[1:])
            way_ids.append(way_id)
        else:
            if chain:
                yield chain, way_ids
            chain = list(piece)
            way_ids = [way_id]
    if chain:
        yield chain, way_ids


def source_way_geometries(source):
    ways = {}
    for route in source["features"]:
        way_ids = route["properties"]["route_way_osm_ids"]
        pieces = route["geometry"]["coordinates"]
        for way_id, piece in zip(way_ids, pieces, strict=True):
            if way_id in ways and piece not in (ways[way_id], ways[way_id][::-1]):
                raise ValueError(f"Conflicting retained geometry for OSM way {way_id}")
            ways[way_id] = piece
    return ways


def verified_csv_roads(path, source):
    source_ways = source_way_geometries(source)
    supplied_ids = set()
    matches = {}
    different_geometry = 0
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            way_id = int(row["osm_id"])
            if way_id <= 0 or way_id in supplied_ids:
                raise ValueError(f"Invalid or duplicate road OSM ID {way_id}")
            supplied_ids.add(way_id)
            coords = json.loads(row["geometry"])
            start = [float(row["start_lon"]), float(row["start_lat"])]
            end = [float(row["end_lon"]), float(row["end_lat"])]
            valid_positions = all(
                isinstance(point, list) and len(point) == 2
                and all(type(value) in (int, float) and isfinite(value) for value in point)
                and -180 <= point[0] <= 180 and -90 <= point[1] <= 90
                for point in coords
            )
            if not valid_positions or len(coords) < 2 or len(coords) != int(row["points_count"]) or coords[0] != start or coords[-1] != end:
                raise ValueError(f"Invalid geometry or endpoints in supplied road {way_id}")
            original = source_ways.get(way_id)
            if original is None:
                continue
            if coords in (original, original[::-1]):
                matches[way_id] = coords
            else:
                different_geometry += 1
    return {
        "input_file": path.name,
        "input_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "input_road_count": len(supplied_ids),
        "matching_road_count": len(matches),
        "same_osm_id_different_geometry_count": different_geometry,
        "ways": [{"osm_id": way_id, "coordinates": coords} for way_id, coords in sorted(matches.items())],
    }


def build(source, road_matches):
    verified = {way["osm_id"]: way["coordinates"] for way in road_matches["ways"]}
    output = []
    for feature in source["features"]:
        props = feature["properties"]
        if props["mode"] != "bus":
            raise ValueError("Bus source must not mix other modes")
        relation = props["osm_relation_id"]
        pieces = []
        for way_id, original in zip(props["route_way_osm_ids"], feature["geometry"]["coordinates"], strict=True):
            supplied = verified.get(way_id)
            if supplied is None:
                pieces.append((way_id, original))
            elif supplied == original:
                pieces.append((way_id, supplied))
            elif supplied[::-1] == original:
                pieces.append((way_id, supplied[::-1]))
            else:
                raise ValueError(f"Retained CSV match differs from OSM way {way_id}")
        chains = list(connected_chains(pieces))
        for index, (coordinates, way_ids) in enumerate(chains):
            identifier = f"osm-bus-{relation}-chain-{index}"
            output.append({
                "type": "Feature", "id": identifier,
                "properties": {
                    "feature_id": identifier, "source_id": "osm", "category": "bus_route",
                    "name": props["name"] or f"Автобус {props['route_ref']}",
                    "route_ref": props["route_ref"], "osm_relation_id": relation,
                    "mode": "bus", "chain_index": index, "route_chain_count": len(chains),
                    "from_name": props["from_name"], "to_name": props["to_name"],
                    "is_complete_source_chain": len(chains) == 1 and not props["missing_route_way_count"],
                    "source_way_count": len(way_ids),
                    "csv_matched_way_count": sum(way_id in verified for way_id in way_ids),
                },
                "geometry": {"type": "LineString", "coordinates": coordinates},
            })
    selected = []
    for relation in REFERENCE_RELATIONS:
        matches = [f for f in output if f["properties"]["osm_relation_id"] == relation]
        if len(matches) != 1 or not matches[0]["properties"]["is_complete_source_chain"]:
            raise ValueError(f"Reference route {relation} is not a complete connected source chain")
        selected.extend(matches)
    return {"type": "FeatureCollection", "features": output}, {"type": "FeatureCollection", "features": selected}


def artifacts():
    source_bytes = SOURCE.read_bytes()
    source = json.loads(gzip.decompress(source_bytes))
    match_bytes = ROAD_MATCHES.read_bytes()
    road_matches = json.loads(gzip.decompress(match_bytes))
    all_routes, references = build(source, road_matches)
    route_bytes = (json.dumps(all_routes, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    reference_bytes = (json.dumps(references, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    yield "bus_routes.geojson", route_bytes
    yield "bus_corridors.geojson", reference_bytes
    provenance = {
        "source": "OpenStreetMap bus route relations and their ordered traveled member ways",
        "source_url": "https://builder.osmand.net/osm-extract/russia_novosibirsk_asia/russia_novosibirsk_asia.pbf",
        "pbf_sha256": PBF_SHA256, "source_snapshot_retrieved": "2026-11-09",
        "service_validity_date": None, "license": "ODbL-1.0",
        "license_url": "https://opendatacommons.org/licenses/odbl/1-0/",
        "attribution": "© OpenStreetMap contributors",
        "attribution_url": "https://www.openstreetmap.org/copyright",
        "source_file": "source/osm-bus-route-members.json.gz",
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "bus_relation_count": len(source["features"]),
        "connected_chain_count": len(all_routes["features"]),
        "reference_corridor_count": len(references["features"]),
        "disconnected_relation_count": sum(f["properties"]["way_connectivity_gap_count"] > 0 for f in source["features"]),
        "geometry_rule": "Merge only consecutive source member ways sharing an exact endpoint. Reverse a piece only when its endpoint exactly matches. Preserve every source edge. Never bridge gaps.",
        "supplied_road_match_rule": "Use supplied geometry only when OSM way ID and the full ordered vertex sequence match the retained OSM member, allowing reversal. Other ways retain their original OSM geometry.",
        "supplied_road_input": {key: value for key, value in road_matches.items() if key != "ways"},
        "matched_roads_source_file": "source/osm-bus-road-matches.json.gz",
        "matched_roads_source_sha256": hashlib.sha256(match_bytes).hexdigest(),
        "matched_member_occurrences": sum(f["properties"]["csv_matched_way_count"] for f in all_routes["features"]),
        "source_member_occurrences": sum(f["properties"]["source_way_count"] for f in all_routes["features"]),
        "scope": "Snapshot route geometry, not live service, a full routing graph, measured traffic or model labels. Reference corridors are not identified training roads.",
        "official_transit_map_data_used": False,
        "assets": {
            "bus_routes.geojson": {"sha256": hashlib.sha256(route_bytes).hexdigest(), "bytes": len(route_bytes)},
            "bus_corridors.geojson": {"sha256": hashlib.sha256(reference_bytes).hexdigest(), "bytes": len(reference_bytes)},
        },
    }
    yield "bus_routes.provenance.json", (json.dumps(provenance, ensure_ascii=False, indent=2) + "\n").encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--roads-csv", type=Path, help="Refresh exact OSM member-way matches from a local roads CSV")
    args = parser.parse_args()
    if args.roads_csv:
        source = json.loads(gzip.decompress(SOURCE.read_bytes()))
        matches = verified_csv_roads(args.roads_csv, source)
        compact = json.dumps(matches, ensure_ascii=False, separators=(",", ":")).encode()
        ROAD_MATCHES.write_bytes(gzip.compress(compact, mtime=0))
    for name, content in artifacts():
        target = ROOT / "contracts/geography" / name
        if args.check:
            if not target.exists() or target.read_bytes() != content:
                raise SystemExit(f"Stale bus-route asset: {name}")
        else:
            target.write_bytes(content)
    print("Bus-route assets are current" if args.check else "Bus-route assets generated")


if __name__ == "__main__":
    main()
