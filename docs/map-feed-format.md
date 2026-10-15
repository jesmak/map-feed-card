# Map Feed format, version 1

A map feed is a Home Assistant entity that describes a set of things on a map, such as ships, trains, buses, road
works, road cameras or anything else with a position. The [map feed card](../README.md) draws any entity in this
format. Any integration or template entity can produce a feed.

The keywords **MUST**, **SHOULD** and **MAY** are used as described in
[RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

## Contents

- [Overview](#overview)
- [Entity](#entity)
  - [Feed type](#feed-type)
  - [Legend](#legend)
  - [List](#list)
- [Features](#features)
- [Feature properties](#feature-properties)
  - [A row in the list](#a-row-in-the-list)
- [Lines and polygons](#lines-and-polygons)
- [Rules for sources](#rules-for-sources)
- [Examples](#examples)
- [Versioning](#versioning)

## Overview

One entity is one feed, for example "ships within 15 km of the cabin". Items coming and going never create
or remove entities.

```
sensor.ships_near_the_cabin
├─ state                 6   (number of items)
└─ attributes
   ├─ map_feed_version    1
   ├─ attribution         "Fintraffic / digitraffic.fi, CC BY 4.0"
   ├─ area                {center, radius_km} | {bbox}
   ├─ updated             ISO 8601, last successful fetch
   ├─ legend              what the feed's own colours mean
   ├─ list                how the card's list can be sorted
   └─ geojson             GeoJSON FeatureCollection
      └─ features[]
         ├─ id            "ship:230113940"
         ├─ geometry      Point [longitude, latitude], or a line or polygon
         └─ properties    name, kind, heading, …
```

The items are [GeoJSON (RFC 7946)](https://datatracker.ietf.org/doc/html/rfc7946), so a feed also works
with any map that draws GeoJSON, as plain dots.

Properties are structured data, never HTML. The card builds the markup, escapes every value and renders
anything that changes on its own, such as "2 min ago".

## Entity

| Field              | Type     | Required | Meaning                                                                                                                        |
| ------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| state              | integer  | **MUST** | Number of items. The source decides what an item is. Usually it is the number of Point features.                               |
| `map_feed_version` | integer  | **MUST** | `1`. The card uses this to recognise a feed.                                                                                   |
| `geojson`          | object   | **MUST** | A GeoJSON `FeatureCollection` object (not a JSON string).                                                                      |
| `feed_type`        | string   | SHOULD   | What the feed is about, `ship`, `train`, `transit`, `road`, `nature` or `other`. See [feed type](#feed-type).                  |
| `attribution`      | string   | SHOULD   | Data credit, added to the map's attribution line. Required when the data licence asks for credit.                              |
| `area`             | object   | MAY      | `{"center": [lat, lon], "radius_km": 15}` or `{"bbox": [south, west, north, east]}`. Drawn by the card when `show_area` is on. |
| `updated`          | ISO 8601 | SHOULD   | When the source last fetched successfully.                                                                                     |
| `legend`           | object[] | MAY      | What the feed's own colours mean, in its own language. See [legend](#legend).                                                  |
| `list`             | object   | MAY      | How the card's list of items can be sorted, and what an item is called. See [list](#list).                                     |

Note that `area` uses latitude first, like the rest of Home Assistant, while GeoJSON coordinates use
longitude first.

### Feed type

`feed_type` says what the feed is about, in the same families as the [kinds](#kinds) of its items, `ship`, `train`,
`transit`, `road`, `nature` or `other`. A feed has one type even when its items are of several kinds, such as road works,
accidents and announcements in a feed of traffic messages, which is `road`.

The card's editor offers a feed only the options that make sense for it. Delay colours are for trains and public
transport, and an age limit for anything with positions, which leaves out sightings that the source already limits by
their age. A feed without a type, or with one the card doesn't know, is offered every option.

### Legend

```json
[
  { "color": "#2e7d32", "label": "Sighting" },
  { "color": "#d84315", "label": "Notable sighting" }
]
```

A feed that colours its items with `color` says what the colours mean, since the card can't. Each entry is a CSS hex
`color` and a `label`, and entries without both are left out. The card shows the legend over the map. Without one, it
shows its own, the delay classes when it colours by delay, and the kinds on the map when there is more than one.

### List

The card can show the items as a list beside or below the map. A feed says what the list can be sorted by, since
only the feed knows what makes sense, such as delay and train number for trains, or distance and freshness for bird
sightings.

```json
{
  "sort": [
    { "key": "distance", "label": "Distance", "property": "distance_km" },
    { "key": "recent", "label": "Most recent", "property": "updated", "order": "desc" }
  ],
  "default": "distance",
  "count": "sites"
}
```

| Field     | Type     | Required | Meaning                                                                                         |
| --------- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| `sort`    | object[] | MAY      | The orders the list offers, each a sort key (below).                                            |
| `default` | string   | MAY      | The `key` of the order the list starts in. Defaults to the first sort key.                      |
| `count`   | string   | MAY      | What the items are called in the count above the list, in the feed's language, such as `sites`. |

A sort key:

| Field      | Type   | Required | Meaning                                                                                                 |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `key`      | string | **MUST** | Identifies the order, so the card's `sort` option can name it. Stable between updates.                  |
| `label`    | string | **MUST** | Shown in the list's sort menu, in the feed's language.                                                  |
| `property` | string | **MUST** | The feature property to sort by. Any property, including one of the source's own such as `distance_km`. |
| `order`    | string | MAY      | `asc` (the default) or `desc`.                                                                          |

Numbers sort as numbers, ISO 8601 times as times and everything else as text, in the feed's language. Items without
the property come last, in the feed's order. Without sort keys, the list keeps the feed's order. When there is more than one, the user can change the order on the card, and the card's `sort` option picks the one it starts in.

## Features

| Field      | Type   | Required | Meaning                                                                                                                                                                                                                            |
| ---------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | string | **MUST** | Unique within the feed and stable between updates. The card uses it to move an existing marker and keep its details open. Prefix it with the kind of identifier, as in `ship:230113940`, `train:2026-09-14/8`, `vehicle:LPR/1042`. |
| `geometry` | object | **MUST** | A GeoJSON `Point`, or a line or polygon (see [lines and polygons](#lines-and-polygons)). WGS84 `[longitude, latitude]`.                                                                                                            |

## Feature properties

| Property        | Type     | Required | Meaning                                                                                                                                   |
| --------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | string   | **MUST** | Title of the details, such as `LARISSA B`, `IC 8` or `Linja 5`.                                                                           |
| `kind`          | string   | **MUST** | Picks the icon and default colour. See [kinds](#kinds).                                                                                   |
| `updated`       | ISO 8601 | SHOULD   | When this position was measured. The card shows its age and hides items older than `max_age_minutes`. An item without it is never hidden. |
| `heading`       | number   | MAY      | Degrees 0–360, clockwise from north. Missing means unknown.                                                                               |
| `stationary`    | boolean  | MAY      | Moored, parked or stopped. Drawn as a dot instead of an arrow.                                                                            |
| `speed_kmh`     | number   | MAY      | Speed over ground. Shown in knots for `ship.*` kinds, km/h otherwise.                                                                     |
| `delay_minutes` | number   | MAY      | Negative means early. Used by `color_by: delay`.                                                                                          |
| `cancelled`     | boolean  | MAY      | Shown as cancelled.                                                                                                                       |
| `badge`         | string   | MAY      | Short text drawn inside the marker, such as `IC 8` or `5`. Keep it to a few characters.                                                   |
| `label`         | string   | MAY      | Text beside the marker when labels are on. Defaults to `name`.                                                                            |
| `subtitle`      | string   | MAY      | Second line of the details, such as `Joensuu → Helsinki`.                                                                                 |
| `color`         | string   | MAY      | CSS hex colour. Replaces the kind's default colour when the card colours by kind.                                                         |
| `details`       | row[]    | MAY      | Detail rows, in display order. See [rows](#rows).                                                                                         |
| `notices`       | string[] | MAY      | Free-text notices shown under the rows.                                                                                                   |
| `footer`        | string   | MAY      | Small grey line at the bottom of the details, such as `MMSI 210533000 · IMO 9466219`.                                                     |
| `detail_action` | object   | MAY      | More details, loaded when the item is selected. See [detail actions](#detail-actions).                                                    |
| `images`        | image[]  | MAY      | Pictures shown in the details, such as a road camera's views. See [images](#images).                                                      |
| `link`          | object   | MAY      | A link at the end of the details, such as the item's page on the source's site. See [links](#links).                                      |
| `opacity`       | number   | MAY      | 0–1, how strongly the item is drawn. Defaults to 1. See [opacity](#opacity).                                                              |
| `point`         | string   | MAY      | The `id` of the Point feature a line or polygon belongs to.                                                                               |
| `list`          | object   | MAY      | The item's row in the card's list, where its name and subtitle aren't the best fit. See [a row in the list](#a-row-in-the-list).          |

Properties the card doesn't know are ignored, apart from a feed's own properties that a [sort key](#list) names.

### Kinds

| Family  | Kinds                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ships   | `ship.cargo`, `ship.tanker`, `ship.passenger`, `ship.pilot`, `ship.tug`, `ship.fishing`, `ship.pleasure`, `ship.icebreaker`, `ship.other`                                                                                                                                                                   |
| Trains  | `train.long_distance`, `train.commuter`, `train.cargo`, `train.other`                                                                                                                                                                                                                                       |
| Transit | `bus`, `tram`, `metro`, `ferry`                                                                                                                                                                                                                                                                             |
| Road    | `road.roadwork`, `road.announcement`, `road.accident`, `road.weight_restriction`, `road.exempted_transport`, `road.maintenance`, `road.maintenance_track`, `road.condition.normal`, `road.condition.poor`, `road.condition.extremely_poor`, `road.condition.unknown`, `road.weather_station`, `road.camera` |
| Nature  | `bird`                                                                                                                                                                                                                                                                                                      |
| Other   | `other`                                                                                                                                                                                                                                                                                                     |

An unknown kind is drawn as a grey arrow or dot. Within the ship or train family (`ship.hovercraft`), its details show
speed and the position's age like the family's other kinds. Variations of the transit kinds, such as `bus.night`, have
no family prefix and count as `other`.

Road works, announcements, accidents, weight restrictions and exempted transports are drawn as a warning sign,
`road.camera` as a camera, and `bird` as a bird. A bird's badge starts with a small bird. The details of something
that moves (ships, trains, transit and `road.maintenance`) shows how old its position is. For everything else it
shows when the item was updated.

### Rows

```json
{ "label": "Draught", "value": 2.2, "unit": "m" }
```

| Field   | Type             | Required | Meaning                                                       |
| ------- | ---------------- | -------- | ------------------------------------------------------------- |
| `label` | string           | **MUST** | Written by the source, in the language it was configured for. |
| `value` | string or number | **MUST** | Shown as is.                                                  |
| `unit`  | string           | MAY      | Appended after the value.                                     |
| `image` | image            | MAY      | A small picture before the label. See below.                  |
| `tag`   | object           | MAY      | A short tag at the end of the row. See below.                 |

A row's `image` takes the fields of an [image](#images). The card shows it as a small square before the label,
and tapping it shows the picture large at the top of the details, with its caption. Consecutive rows with a picture
are drawn as a list of pictures, and rows without one as a table of labels and values. Use it when each row is a thing with a picture of its own, such as the species seen at
a place, and the item's `images` when the pictures belong to the item as a whole, such as a road camera's views.

```json
{
  "label": "Mallard",
  "value": "6 birds · 12:38",
  "image": {
    "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Anas_platyrhynchos_male_female_quadrat.jpg/500px-Anas_platyrhynchos_male_female_quadrat.jpg",
    "caption": "Mallard · Richard Bartz, CC BY-SA 2.5"
  }
}
```

A row's `tag` marks it out, such as a species that is rare or endangered:

```json
{ "label": "Velvet scoter", "value": "2 birds · 7:30", "tag": { "text": "VU", "tone": "warning" } }
```

| Field  | Type   | Required | Meaning                                                                                      |
| ------ | ------ | -------- | -------------------------------------------------------------------------------------------- |
| `text` | string | **MUST** | A word or two, in the source's language.                                                     |
| `tone` | string | MAY      | `warning`, `info`, `neutral` (the default) or `item`. The card picks the colours from these. |

`warning`, `info` and `neutral` take Home Assistant's theme colours. `item` takes the item's own colour, the one its
marker has, so it leads from the marker to the row that gave the marker its colour, such as the species that made a
place a notable sighting. A tag has no colour of its own.

The card translates only what it renders itself, which is ages, speeds, delays and "cancelled". Everything else
comes from the source in its own words, so a feed can carry any data without a card release.

### Images

```json
{
  "url": "https://weathercam.digitraffic.fi/C0355801.jpg?t=1789472853",
  "caption": "Towards Imatra",
  "time": "2026-09-15T11:47:33Z"
}
```

| Field     | Type     | Required | Meaning                                                   |
| --------- | -------- | -------- | --------------------------------------------------------- |
| `url`     | string   | **MUST** | An `https` URL. Images with any other URL are left out.   |
| `caption` | string   | MAY      | Shown under the picture.                                  |
| `time`    | ISO 8601 | MAY      | When the picture was taken. The card shows how old it is. |

The card shows at most six images per item, not counting the pictures on rows. Browsers cache pictures by URL, so a source whose picture changes
behind the same address SHOULD add something that changes with it, such as the time the picture was taken.

### Links

```json
{ "url": "https://ebird.org/hotspot/L1234567", "label": "Hotspot on eBird" }
```

| Field   | Type   | Required | Meaning                                                                     |
| ------- | ------ | -------- | --------------------------------------------------------------------------- |
| `url`   | string | **MUST** | An `https` URL. A link with any other URL is left out.                      |
| `label` | string | MAY      | The link's text, in the source's language. Defaults to the URL's host name. |

The card shows the link last in the details and opens it in a new tab.

### Opacity

A source fades an item to make it stand back, such as a place where birds were seen days ago next to one where
they were seen this morning. The source decides what fading means for its data, and the card draws the marker, or
the line or polygon, at that opacity. Values below 0.3 are drawn at 0.3, so that nothing on the map is too faint to
find and tap. An item too old to be useful is better left out of the feed, or hidden with `max_age_minutes`.

### Detail actions

```json
{
  "action": "digitraffic_live.get_train_composition",
  "data": { "departure_date": "2026-09-14", "train_number": 8 }
}
```

When the item is selected, the card calls the action with a response requested. The response is
`{"details": [rows]}`, and the card appends those rows to the details. The action MUST be read-only.

The card calls only an action of the integration that created the feed entity, such as
`digitraffic_live.get_train_composition` for a Digitraffic Live sensor. Selecting an item calls the action with the
viewer's rights, so a feed can't make the viewer run anything else, such as a script. A template entity's feed can't
use detail actions. The rows are loaded once per item and action, and a failed load is tried again the next time the
item is selected.

### A row in the list

In the card's list, an item is a row with a title, a text under it and a value on the right. Without `list`, the title is
the item's `name`, the text its `subtitle`, and the value its delay, or the age of its position or update. A train whose
badge already says its name has its route, the `subtitle`, as the title instead.

```json
{ "title": "Joensuu → Helsinki", "text": "Past Kouvola", "value": "3.9 km" }
```

| Field   | Type   | Required | Meaning                                                                |
| ------- | ------ | -------- | ---------------------------------------------------------------------- |
| `title` | string | MAY      | The row's title.                                                       |
| `text`  | string | MAY      | The line under the title. An empty string leaves it out.               |
| `value` | string | MAY      | Shown on the right, such as a distance. An empty string leaves it out. |

Each field replaces only its own part, so a feed can give a bird sighting's distance as the `value` and keep the rest.
The value of something late takes its delay's colour, everything else the secondary text colour.

## Lines and polygons

Features MAY have a `LineString`, `MultiLineString`, `Polygon` or `MultiPolygon` geometry, such as a stretch of
road under construction, the route a snow plough has driven, a road section's driving conditions or an area.

They take the same properties as points, apart from the ones about movement and markers (`heading`,
`stationary`, `speed_kmh`, `delay_minutes`, `cancelled`, `badge`, `label`, `detail_action`), which are ignored.
The card colours them by `kind` or `color`, shows `name` on hover, and show their details when they are tapped and
have something to show. Road kinds are drawn wider than other lines, and `road.maintenance_track` is drawn thin and
faint, so routes stay in the background.

A line or polygon MAY belong to a Point feature, named in its `point` property. It is then drawn in that point's
colour, and tapping it selects the point, so the details are written once, on the point:

```json
[
  {
    "type": "Feature",
    "id": "traffic_message:GUID50470660",
    "geometry": { "type": "Point", "coordinates": [27.5163, 60.9187] },
    "properties": {
      "name": "Tie 26, Hamina, Luumäki. Tietyö",
      "kind": "road.roadwork",
      "subtitle": "Tie 26 välillä Hamina - Lappeenranta.",
      "details": [
        { "label": "Status", "value": "starts 21.9. 00:00" },
        { "label": "Restrictions", "value": "One lane closed" }
      ]
    }
  },
  {
    "type": "Feature",
    "id": "traffic_message:GUID50470660/area",
    "geometry": {
      "type": "MultiLineString",
      "coordinates": [
        [
          [27.1919, 60.6151],
          [27.1865, 60.6049]
        ],
        [
          [27.26, 60.6594],
          [27.2382, 60.6458]
        ]
      ]
    },
    "properties": { "kind": "road.roadwork", "point": "traffic_message:GUID50470660" }
  }
]
```

Lines with thousands of points make a feed large. Sources SHOULD simplify them to what a map shows, for
example with the Douglas–Peucker algorithm and a tolerance of 10–20 metres.

## Rules for sources

- Integrations **MUST** list `geojson` in `_unrecorded_attributes`, so only the count reaches the database.
  Template entities can't do this, so exclude them from the recorder instead. Without that, the recorder drops
  all attributes above 16 384 bytes and logs a warning on every update.
- Feature ids **MUST** be stable between updates, and coordinates **MUST** be `[longitude, latitude]`.
- Actions named in `detail_action` **MUST** be read-only.
- Sources **SHOULD** include only items inside their configured area and keep the attribute to a few tens
  of kilobytes. Home Assistant pushes every change to every open dashboard, including ones without a map.
- Sources **SHOULD** refresh no more often than every 30 seconds and round coordinates to 5 decimals
  (about 1 m). A source of live vehicle positions, which report every few seconds, **MAY** refresh as often as
  every 15 seconds, and should let the user choose a longer interval.
- Sources **SHOULD** leave out properties that have no value instead of writing `null`.
- Sources **SHOULD** become `unavailable` when fetching fails, like a standard update coordinator, rather
  than keep showing old positions as live.

## Examples

### A ship

```json
{
  "state": "6",
  "attributes": {
    "friendly_name": "Ships near the cabin",
    "map_feed_version": 1,
    "attribution": "Fintraffic / digitraffic.fi, CC BY 4.0",
    "area": { "center": [60.569, 27.198], "radius_km": 15 },
    "updated": "2026-09-14T21:10:03+03:00",
    "geojson": {
      "type": "FeatureCollection",
      "features": [
        {
          "type": "Feature",
          "id": "ship:230113940",
          "geometry": { "type": "Point", "coordinates": [27.17012, 60.53044] },
          "properties": {
            "name": "PILOT L117",
            "kind": "ship.pilot",
            "updated": "2026-09-14T21:09:41+03:00",
            "heading": 88,
            "speed_kmh": 20.4,
            "label": "PILOT L117",
            "details": [
              { "label": "Status", "value": "Under way using engine" },
              { "label": "Destination", "value": "FIHMN" },
              { "label": "Draught", "value": 2.2, "unit": "m" },
              { "label": "Size", "value": "13 × 4", "unit": "m" }
            ],
            "footer": "MMSI 230113940"
          }
        }
      ]
    }
  }
}
```

### A train

```json
{
  "type": "Feature",
  "id": "train:2026-09-14/8",
  "geometry": { "type": "Point", "coordinates": [27.30011, 60.90204] },
  "properties": {
    "name": "IC 8",
    "kind": "train.long_distance",
    "updated": "2026-09-14T21:09:58+03:00",
    "speed_kmh": 113,
    "delay_minutes": 11,
    "badge": "IC 8",
    "label": "→ Helsinki",
    "subtitle": "Joensuu → Helsinki",
    "details": [
      { "label": "Passed", "value": "Kaitjärvi 21:04" },
      { "label": "Next stop", "value": "Kouvola 21:19, track 6" }
    ],
    "notices": ["The train is delayed due to track works."],
    "detail_action": {
      "action": "digitraffic_live.get_train_composition",
      "data": { "departure_date": "2026-09-14", "train_number": 8 }
    }
  }
}
```

### A bus, from a GTFS Realtime feed

```json
{
  "type": "Feature",
  "id": "vehicle:LPR/1042",
  "geometry": { "type": "Point", "coordinates": [28.18793, 61.05871] },
  "properties": {
    "name": "Line 5",
    "kind": "bus",
    "updated": "2026-09-14T21:09:50+03:00",
    "heading": 214,
    "delay_minutes": 2,
    "badge": "5",
    "subtitle": "Keskusta → Skinnarila"
  }
}
```

### A template entity

Anything with coordinates can be a feed. This turns a boat's GPS tracker into a one-item feed. Exclude the
entity from the recorder, because a template can't mark attributes as unrecorded.

```yaml
template:
  - trigger:
      - trigger: state
        entity_id: device_tracker.boat
    sensor:
      - name: Boat on the map
        state: 1
        attributes:
          map_feed_version: 1
          geojson: >
            {% set t = states.device_tracker.boat %}
            {{ {"type": "FeatureCollection", "features": [{
                "type": "Feature", "id": "boat:boat",
                "geometry": {"type": "Point",
                             "coordinates": [t.attributes.longitude, t.attributes.latitude]},
                "properties": {"name": "Boat", "kind": "ship.pleasure",
                               "updated": t.last_updated.isoformat()}}]} }}

recorder:
  exclude:
    entities:
      - sensor.boat_on_the_map
```

## Versioning

`map_feed_version` changes only for breaking changes. New optional properties are added to version 1
without changing it, and cards ignore properties they don't know.
