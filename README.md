# Map feed card

Home Assistant dashboard card that draws map feeds, such as trains, ships, buses, aircraft, road works and birds, on Home
Assistant's own map, with the selected item's details beside it.

[![GitHub Release][releases-shield]][releases] [![GitHub Release Date][release-date-shield]][releases] [![HACS][hacs-shield]][hacs] [![License][license-shield]](LICENSE)

<p>
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/trains-light.png#gh-light-mode-only" width="400" alt="Trains on a map coloured by their delay, a late train's details opened in the list below it">
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/trains-dark.png#gh-dark-mode-only" width="400" alt="Trains on a map coloured by their delay, a late train's details opened in the list below it">
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/birds-light.png#gh-light-mode-only" width="400" alt="Bird sightings on a map with a legend, a notable place's species with pictures and tags in the list below it">
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/birds-dark.png#gh-dark-mode-only" width="400" alt="Bird sightings on a map with a legend, a notable place's species with pictures and tags in the list below it">
</p>

## What is it?

A custom card for things that have a position and change, such as the trains on a stretch of track, the ships near a
harbour, the aircraft overhead, the buses of a line, road works and road cameras, or the places where birds were seen this week. Each one is a marker
on the map, coloured by its kind or by how late it is. Tap one, and its details open in a panel below the map, or
beside it when the card is wide. They show its status, its details as a table or a list of pictures, notices,
pictures and a link to the source.

The map is Home Assistant's own, the same vector map its map card draws, with the same styles and the same light and
dark looks. It needs no map service or key of its own.

The card reads sensors in the [map feed format](docs/map-feed-format.md), so it works with any integration that
writes it:

- [Digitraffic Live](https://github.com/jesmak/digitraffic_live): trains, ships, road works, road conditions,
  weather stations and road cameras in Finland.
- [Digitransit Live](https://github.com/jesmak/digitransit_live): buses, trams and metros in Finland.
- [Birds Nearby](https://github.com/jesmak/birds_nearby): recent bird sightings near home, from eBird.
- [ADS-B Live](https://github.com/jesmak/adsb_live): aircraft from your own ADS-B receiver, and from adsb.fi.

Integrations that write the format carry the GitHub topic
[`map-feed-card-source`](https://github.com/topics/map-feed-card-source), so that's where to look for more. If you
make one, give its repository the topic too. A template entity can write the format as well.

## Installation

### With HACS

1. Add this repository to HACS custom repositories with type **Dashboard**
2. Search for Map feed card in HACS and download it
3. Refresh your browser

### Manual

1. Take `dist/map-feed-card.js` from the source code of the [latest release][releases] and copy it to the
   `config/www` folder of your Home Assistant installation
2. In Home Assistant settings, open dashboards, click the three dots at the top right and open resources
3. Add a new resource with the path `/local/map-feed-card.js` and type JavaScript
4. Refresh your browser

The card needs Home Assistant 2026.9.3 or newer. Home Assistant serves the map tiles it draws since 2026.9.

## Options

| Name          | Type    | Default   | Description                                                                                                        |
| ------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `type`        | string  | required  | `custom:map-feed-card`                                                                                             |
| `entities`    | list    | required  | Map feed sensors, drawn on the same map, as entity ids or with their options below                                 |
| `title`       | string  |           | Shown at the top of the card                                                                                       |
| `map_style`   | string  | `default` | Home Assistant's map style, `default`, `colorful`, `natural`, `muted`, `gray` or `toner`                           |
| `map_height`  | number  | `300`     | The map's height in pixels. When the card is wide, the details beside it are as tall                               |
| `legend`      | boolean | `true`    | Show what the colours mean, over the map                                                                           |
| `list`        | boolean | `false`   | Show the items as a list beside or below the map, the selected one opened in place                                 |
| `list_height` | number  | `450`     | The list's height in pixels below the map. Beside the map, the list is as tall as the map                          |
| `sort`        | string  |           | The order the list starts in, one of the orders the feeds offer. With more than one, it can be changed on the card |

Each feed in `entities` can have options of its own:

| Name                | Type    | Default  | Description                                                                                  |
| ------------------- | ------- | -------- | -------------------------------------------------------------------------------------------- |
| `entity`            | string  | required | The map feed sensor                                                                          |
| `color_by`          | string  | `kind`   | `kind` colours by what the item is, `delay` trains and public transport by how late they are |
| `late_minutes`      | number  | `3`      | With `color_by: delay`, minutes late from which an item is yellow                            |
| `very_late_minutes` | number  | `10`     | With `color_by: delay`, minutes late from which an item is red                               |
| `max_age_minutes`   | number  |          | Hide items whose position is older than this                                                 |
| `show_area`         | boolean | `false`  | Draw the area the feed covers, as a dashed outline                                           |
| `area_color`        | string  |          | The area's colour, as a hex colour. By default a blue that suits the theme                   |
| `labels`            | boolean | `false`  | Show each item's name beside its marker                                                      |

Every option is in the card's visual editor, which offers each feed only the options that make sense for its [type](docs/map-feed-format.md#feed-type), such as no delays for bird sightings.

## What it shows

**The map** shows each item where it is. Something with a known heading has an arrow pointing where it is going, and
an item with a short label, such as a train's number, shows it in the marker. Road works, road cameras and birds have
symbols of their own, and an aircraft is the silhouette of its kind, such as a light aircraft, an airliner or a
helicopter, turned the way it flies. Lines and areas, such as a road under construction or the stretch a snow plough has cleared, are
drawn in their item's colour, and tapping one selects it. Pointing at a line or an area shows its name, and with
`labels` every marker has its name beside it. When the card opens, the map shows the feeds' areas, or everything in
them when they have none. The map follows the theme, light or dark, and takes the map colours a theme sets with `--ha-color-map-*` variables, as Home Assistant's own map does. Its corner credits each feed's source, with a link when the feed gives one.

<p>
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/road-traffic-light.png#gh-light-mode-only" width="830" alt="Road works, an announcement and a snow plough on a map, with the road works' stretch drawn as a line and a legend of their kinds">
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/road-traffic-dark.png#gh-dark-mode-only" width="830" alt="Road works, an announcement and a snow plough on a map, with the road works' stretch drawn as a line and a legend of their kinds">
</p>

**The details** of the item tapped open in the panel. The title is the item's name, or a train's route when its
marker already shows its number. Under it, something that moves has a status line with its delay, its speed and how
old its position is, coloured by the delay. Then come the item's details, drawn by their shape. Rows with a picture,
such as the species seen at a place, are a list with the pictures, and rows without one a table. A row can carry a
tag, such as an endangered species' status. Notices are highlighted below them. Tapping a picture shows it large, or opens its page when the feed links it there, as a photo's terms may ask.

**The list**, with `list: true`, shows every item as a row: a title, a line under it and a value, such as a delay or
a distance. A feed can say what the list can be sorted by, such as delay and number for trains, and the order is chosen on the card when there is more than one. Tapping a row unfolds its details beneath it and brings its marker into view, and tapping it again folds them away. Tapping a marker opens its row. Above the list is the number of items, with the sensor's name when the card shows one feed.

<p>
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/list-wide-light.png#gh-light-mode-only" width="830" alt="Bird sightings with the list beside the map, the nearest place opened to its species">
<img src="https://raw.githubusercontent.com/jesmak/map-feed-card/main/docs/images/list-wide-dark.png#gh-dark-mode-only" width="830" alt="Bird sightings with the list beside the map, the nearest place opened to its species">
</p>

**The legend** over the map explains the colours: the delay classes with `color_by: delay`, the feed's own colours
when it explains them, and otherwise the kinds on the map when there is more than one. With `color_by: delay`, only trains, public transport and anything the feed gives a delay or
marks cancelled are coloured by their delay. Everything else, such as birds or road works, keeps its own colour.

When the card is at least 640 pixels wide, the details or the list sit beside the map instead of below it.

## Examples

Trains coloured by their delay, hiding any whose position is more than five minutes old:

```yaml
type: custom:map-feed-card
entities:
  - entity: sensor.trains_example_town
    color_by: delay
    max_age_minutes: 5
```

Ships and road works on one map, with the ships' area outlined:

```yaml
type: custom:map-feed-card
title: Harbour
map_height: 400
entities:
  - entity: sensor.ships_near_the_harbour
    show_area: true
  - sensor.road_works_example_town
```

Bird sightings as a list beside the map, nearest first, with each place's name on the map:

```yaml
type: custom:map-feed-card
title: Birds
list: true
sort: distance
entities:
  - entity: sensor.birds_near_example_town
    labels: true
```

## Data

The items come from the sensors the card is given. The card itself fetches only the map, from Home Assistant, which
fetches it from [VersaTiles](https://versatiles.org/) and [OpenStreetMap](https://www.openstreetmap.org/copyright).

The [map feed format](docs/map-feed-format.md) describes the sensor the card reads, with its attributes, each item's
properties, how the card shows them, and the rules for sources. An integration that writes it gets the card for free,
and the format is meant to stay stable. New optional properties are added without changing its version.

## Translating

The card's texts are in `src/localize/languages/`, one JSON file per language, named by its language code, such as
`en.json` and `fi.json`. To add a language, copy `en.json` to the new language's code, such as `sv.json`, and
translate the values. Nothing else needs changing. The card finds the file by itself and uses it when Home Assistant
is set to that language. A text left out falls back to English. Names, details and notices come from the
integrations, in the language they were set up with.

## Development

Requires Node 22.13 or newer.

```
npm install
npm run check
```

`npm run check` typechecks, lints, checks formatting, runs the tests and builds `dist/map-feed-card.js`, which is the
file HACS installs and is committed to the repository. MapLibre is bundled with the card, its worker included, so the
card stays one file.

| Path                      | What it contains                             |
| ------------------------- | -------------------------------------------- |
| `src/map-feed-card.ts`    | The card itself                              |
| `src/editor.ts`           | The visual editor                            |
| `src/feed.ts`             | Reading the feeds                            |
| `src/map.ts`              | The map, its markers, lines and areas        |
| `src/map-tiles.ts`        | Home Assistant's map tiles and styles        |
| `src/map-theme.ts`        | Home Assistant's map colours and themes      |
| `src/list.ts`             | The list's rows and orders                   |
| `src/details.ts`          | The details panel                            |
| `src/style.ts`            | Colours and markers                          |
| `src/localize/languages/` | The card's texts, one JSON file per language |
| `docs/map-feed-format.md` | The format the card reads                    |
| `tests/`                  | Tests, run with vitest                       |

## Support

Hey dude! Help me out for a couple of :beers: or a :coffee:!

[![coffee](https://www.buymeacoffee.com/assets/img/custom_images/black_img.png)](https://www.buymeacoffee.com/jesmak)

## Thanks

The map is drawn with [MapLibre GL JS](https://maplibre.org/) (BSD 3-Clause, see
[LICENSE-maplibre-gl](LICENSE-maplibre-gl)), and its styles are built with
[VersaTiles style](https://github.com/versatiles-org/versatiles-style) (MIT, see
[LICENSE-versatiles-style](LICENSE-versatiles-style)), both bundled with the card. Home Assistant's map colours and
the table of its themes' map colours come from the [Home Assistant frontend](https://github.com/home-assistant/frontend)
(Apache 2.0, see [LICENSE-home-assistant-frontend](LICENSE-home-assistant-frontend)), so the card's map looks like
Home Assistant's own.

## License

MIT, see [LICENSE](LICENSE).

[releases-shield]: https://img.shields.io/github/release/jesmak/map-feed-card.svg?style=for-the-badge
[release-date-shield]: https://img.shields.io/github/release-date/jesmak/map-feed-card?style=for-the-badge
[releases]: https://github.com/jesmak/map-feed-card/releases
[hacs-shield]: https://img.shields.io/badge/HACS-Custom-orange.svg?style=for-the-badge
[hacs]: https://hacs.xyz/docs/faq/custom_repositories/
[license-shield]: https://img.shields.io/github/license/jesmak/map-feed-card.svg?style=for-the-badge
