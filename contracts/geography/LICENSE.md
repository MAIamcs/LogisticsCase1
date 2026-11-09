# Sources and reuse

`roads.geojson`, `buildings.geojson`, `water.geojson`, `stops.geojson` and the
OSM subset in `source/osm-context.json.gz` contain data © OpenStreetMap
contributors, available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
See [OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright).
The manifest identifies the public OsmAnd regional extract and its source hash.

`districts.geojson`, `source/districts.esri.json` and
`source/districts.layer.json` come from the [Novosibirsk regional Geoportal,
district boundary layer 7](https://maps.nso.ru/arcgis2/rest/services/Common/Boundary/MapServer/7).
Its published layer metadata has no explicit reuse license. Do not apply the
OSM license to these government-source polygons. Preserve their source
attribution and consult the source for reuse terms.

The geography source dates, full descriptions and processing details are in
`manifest.json` and [docs/geodata.md](../../docs/geodata.md). Analytical demo
values are separate; none of these geometry files supplies a real forecast.
