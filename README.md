# Province Map Editor

A lightweight, dependency-free web app for turning a colored province map plus an existing
`provinces.json` into a complete province record set: color detection, automatic record
generation, ID assignment, and neighbor calculation all happen as soon as both files are loaded.

The **Countries** tab adds country management on top of the same map and province data:
`countries.json` records, owned/controlled province assignments, and ownership/control map views.

Plain HTML, CSS and vanilla JavaScript. No build step, no framework, no network access.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Application shell and UI |
| `style.css` | Styles |
| `js/analyzer.js` | Pixel analysis (color histogram, connected components, 4-directional neighbors) |
| `js/countries.js` | Countries tab: country model, editor, assignments, country map views, import/export |
| `js/app.js` | State, province JSON model, map interaction, popup editing, layers, import/export |

## Running locally

**Option 1 — open the file directly**

Open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari). Everything works from
`file://`; if the browser blocks Web Workers on `file://`, the app automatically falls back to
analyzing on the main thread.

**Option 2 — local HTTP server (recommended for large maps)**

```bash
cd map_editor
python3 -m http.server 8000
# then open http://localhost:8000/
```

or

```bash
npx serve .
```

## Workflow

1. **Upload Map** — PNG, JPG, JPEG or SVG.
2. **Import JSON** — your existing province file (or a JSON with no records to start from scratch).
3. As soon as **both** are loaded the map is scanned automatically:
   - every unique opaque color is detected (transparent pixels are skipped),
   - connected regions are found per color,
   - a record is generated for every detected color (lowercase hex key, no `#`),
   - imported records are matched by color and keep their ID, name, type and extra metadata,
   - new records get the next free integer ID, an empty name and type `land`,
   - neighbors are calculated from 4-directional pixel adjacency for every record.
4. Click any province (or any row in the sidebar) to highlight it in white and edit its name/type.
5. **Export JSON** downloads `provinces.json` in the original schema.

**Analyze Map** rescans the current map at any time — it never deletes records, it only adds
missing ones and recalculates neighbors. **Reset Selection** clears the highlight. **Options**
holds the analysis settings.

The order of import does not matter: the app waits until both a map and a JSON model exist.

## Analysis options

| Option | Default | Meaning |
| --- | --- | --- |
| Color tolerance | `0` | `0` = exact color matching. Higher values merge near-identical colors (useful for anti-aliased maps). Every merge is reported in the summary. |
| Minimum region size | `1` | Colors covering fewer pixels are ignored. `1` records every detected color. Raise it to drop anti-aliased edge colors. |
| Ignored colors | color of the `id: 0` record, if present | Comma-separated hex codes treated as background/borders. They are excluded from provinces and from neighbor detection. |

## JSON format

```json
{
    "000000": { "id": 0, "name": "UNKNOWN", "type": "land", "neighbors": [] },
    "99e550": { "id": 1, "name": "province1", "type": "land", "neighbors": [2, 3, 5] }
}
```

Exported files use 4-space indentation, and every `neighbors` array is kept on a single line so
diffs stay readable:

```json
{
    "136262": {
        "id": 281,
        "name": "",
        "type": "land",
        "neighbors": [118, 155, 273, 331, 370]
    }
}
```

Rules enforced by the app:

- keys are lowercase 6-digit hex without `#`;
- IDs are unique integers, imported IDs are never reused, and `id: 0` is preserved;
- `name` is a string, `type` is `land` or `sea`, `neighbors` are unique integer IDs sorted ascending;
- a province is never its own neighbor and relationships are symmetric;
- extra properties on imported records are preserved untouched; new records get only the four
  standard properties.

## Deleting provinces

Every row in the sidebar has a small trash button (visible on hover or keyboard focus). Clicking it
asks **“Are you sure you want to delete this province?”** with **Cancel** and **Delete**.

Deleting a province:

- removes its record from the internal JSON model and from the sidebar immediately;
- removes its ID from every remaining province's `neighbors` array and leaves all other
  relationships untouched;
- keeps the map image and its colors exactly as they are — nothing is erased from the bitmap;
- never reuses the deleted ID and never renumbers the remaining provinces.

The color is then *unregistered*: clicking it on the map still highlights it and opens the popup
marked “not registered”, with an empty name field. Enter a name (and optional type) and press
**Done** to register it again — it receives a new unique ID and its neighbors are recalculated
symmetrically from the map. Deleted provinces never appear in the exported JSON.

**Analyze Map** respects explicit deletions: colors you removed stay unregistered until you add
them back. Importing a JSON file or loading a new map starts from a fresh dataset, so the normal
“a record for every detected color” behavior applies again.


## Countries tab

Use the **Provinces / Countries** switch in the toolbar. Both tabs share the same loaded map,
zoom/pan position, province records and country records; switching never reloads files or discards
unsaved edits (an unfinished province edit stays in the popup while you browse countries).

### countries.json format

```json
{
    "USA": {
        "name": "United States of America",
        "id": 1,
        "color": "5b6ee1",
        "owned_provinces": [1],
        "controlled_provinces": [1]
    }
}
```

- the key is the unique country code (letters, digits, `-`, `_`);
- `name`, `id`, `color` (lowercase hex without `#`), `owned_provinces`, `controlled_provinces`;
- province arrays hold **province IDs**, never colors, are duplicate-free and sorted;
- country IDs and province IDs are independent numbering systems.

### Managing countries

- **Create Country** — popup with code, name, color picker + hex field + live preview. New records
  get `highest country ID + 1`; deleted IDs are never reused in the session.
- **Edit** — change code (must stay unique), name, color or assignments. The country ID is preserved
  and renaming the code only moves the JSON key.
- **Delete** — confirmation shows name and code. Only the country and its assignments are removed;
  provinces and the map are untouched.
- **Import Countries / Export Countries** — separate from province JSON. Import validates the
  structure, preserves codes/IDs/names/colors/assignments, reports duplicate IDs, invalid colors and
  province references that do not exist. Export always downloads `countries.json` in the format
  above (assignment arrays inline, 4-space indentation).
- Unsaved changes are flagged in the sidebar footer; exporting clears the flag.

### Assigning provinces

Select a country, then enable **Owned mode** or **Controlled mode** and click provinces on the map.
Clicking an assigned province removes the assignment. Ownership and control are independent — a
province can be owned by one country and controlled by another. Province data is never modified.

Each editor section lists the assigned provinces by name (resolved through `provinces.json`), with a
remove button; clicking a province highlights it on the map. References to provinces that no longer
exist are shown as warnings and preserved on export.

### Map views

**Ownership** view uses `owned_provinces`, **Control** view uses `controlled_provinces`, and
**Province** view shows the original province colors. Assigned provinces are painted with the country
color (blended with the province color and outlined so province borders stay visible); unassigned
provinces keep their original color.

When two countries claim the same province in the same dimension, nothing is overwritten: the map
keeps the province's original color, a warning lists both countries, and the country panel offers an
explicit **Keep …** choice per conflict.

## Behavior details

- **Neighbors** use 4-directional pixel adjacency only. Diagonal corner contact does not count.
- **Disconnected colors** stay a single JSON record; their neighbors are combined and the app
  warns about it (in the summary and in the province popup).
- **Unmatched records** (colors present in the JSON but not in the map) are preserved and reported.
- **Highlighting** is an overlay on the displayed map; it is never used for detection and is
  restored when the popup closes or **Done** is clicked.
- **SVG maps** are rendered as real SVG (each shape can be clicked) and rasterized once for
  color/neighbor detection. Rasterized edge blends are snapped to the fill/stroke colors declared
  in the file, so anti-aliasing never creates phantom provinces.
- Analysis runs in a Web Worker when available and the results are cached; opening a popup or
  clicking around never rescans the map.

## Keyboard and mouse

- Click a province — highlight + edit popup (Provinces) or assign/highlight (Countries)
- Hover a sidebar row and click the trash button — delete that province (see above)
- Drag — pan, mouse wheel — zoom, **Fit** — reset the view
- `Enter` in the name field — save, `Esc` — close the popup / cancel deletion / leave an assignment mode
- Drag and drop a map or JSON file onto the workspace to load it

## Verified behavior

Automated browser tests cover the full workflow:

1. every unique map color receives a record automatically;
2. imported IDs, names and types are preserved;
3. new colors get sequential IDs and empty names;
4. neighbors are computed before anything is clicked;
5–6. clicking saved/new provinces shows the right popup and a white highlight;
7. editing keeps the ID and neighbors;
8. export matches the required structure exactly;
9. re-importing an exported file preserves every record and relationship;
10. diagonal-only contact is not a neighbor;
11. land and sea both participate in neighbor detection;
12. disconnected duplicate-color regions warn and share one record.

Country tab checks cover: switching tabs without losing province/country data, zoom or unsaved
edits; importing and re-importing `countries.json`; next-ID generation and no reuse after deletion;
color edits repainting the map; owned/controlled assignment by clicking provinces; ownership and
control held by different countries; ownership/control/province views; preserved IDs on edit;
deleting a country leaving provinces intact; exact export structure; conflicting assignments
warning with both country names and explicit resolution; and missing province references.
