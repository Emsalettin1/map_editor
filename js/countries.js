/*!
 * Countries tab: countries.json model, editor UI, province assignment and
 * country-colored map visualization.
 *
 * Province data is owned by app.js; this module only references province IDs.
 */
(function (root) {
  'use strict';

  var HEX_RE = /^[0-9a-f]{6}$/;
  var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
  var NEUTRAL_COLOR = '5c6470';
  var OWNED = 'owned_provinces';
  var CONTROLLED = 'controlled_provinces';

  var host = null;
  var state = null;
  var el = {};
  var pendingDeleteCode = null;

  var FIELD_IDS = [
    'tabProvinces', 'tabCountries',
    'provinceSidebar', 'countrySidebar', 'countryList', 'countrySearch', 'countrySummary',
    'countryDirty', 'countryViewModes', 'countryPanel', 'btnCreateCountry',
    'btnImportCountries', 'btnExportCountries', 'countriesInput',
    'cpSwatch', 'cpName', 'cpMeta', 'cpClose', 'cpRead', 'cpForm', 'cpCode', 'cpId', 'cpColor',
    'cpOwnedCount', 'cpControlledCount', 'cpOwnedHeading', 'cpControlledHeading',
    'cpOwnedList', 'cpControlledList', 'cpEdit', 'cpDelete',
    'cpCodeInput', 'cpNameInput', 'cpColorPicker', 'cpColorInput', 'cpColorPreview',
    'cpFormError', 'cpCancel', 'cpSave', 'cpAssign', 'cpModeOwned', 'cpModeControlled',
    'cpModeHint', 'cpConflicts',
    'countryModal', 'countryNextId', 'countryCodeInput', 'countryNameInput',
    'countryColorPicker', 'countryColorInput', 'countryColorPreview', 'countryFormError',
    'countryCreateCancel', 'countryCreateConfirm',
    'countryDeleteModal', 'countryDeleteDetail', 'countryDeleteCancel', 'countryDeleteConfirm'
  ];

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function normalizeHex(value) {
    var raw = String(value == null ? '' : value).trim().toLowerCase().replace(/^#/, '');
    return HEX_RE.test(raw) ? raw : null;
  }

  function numeric(a, b) { return a - b; }

  function looksLikeCountryCode(code) {
    return CODE_RE.test(String(code || '').trim());
  }

  /** Codes are unique case-insensitively; `ignore` is the current key when editing. */
  function codeTaken(code, ignore) {
    var lower = String(code).toLowerCase();
    var taken = false;
    state.countries.forEach(function (country, key) {
      if (key === ignore) return;
      if (key.toLowerCase() === lower) taken = true;
    });
    return taken;
  }

  function countryName(code) {
    var country = state.countries.get(code);
    if (!country) return code;
    return country.name ? country.name + ' (' + code + ')' : code;
  }

  /** Province id -> { record, hex } for the currently loaded province data. */
  function provinceIndex() {
    var byId = new Map();
    state.records.forEach(function (record, hex) { byId.set(record.id, { record: record, hex: hex }); });
    return byId;
  }

  function provinceLabel(info, id) {
    if (!info) return 'Province #' + id;
    return host.isLabeled(info.record) ? info.record.name : 'Unnamed province';
  }

  function markDirty() {
    state.countryDirty = true;
    el.countryDirty.classList.remove('hidden');
    renderSummary();
  }

  // ---------------------------------------------------------------------------
  // Country data queries
  // ---------------------------------------------------------------------------

  function collectAssignments(kind) {
    var map = new Map();
    state.countries.forEach(function (country, code) {
      country[kind].forEach(function (provinceId) {
        var list = map.get(provinceId);
        if (!list) map.set(provinceId, [code]);
        else if (list.indexOf(code) === -1) list.push(code);
      });
    });
    return map;
  }

  function collectConflicts() {
    var conflicts = [];
    [OWNED, CONTROLLED].forEach(function (kind) {
      collectAssignments(kind).forEach(function (codes, provinceId) {
        if (codes.length > 1) {
          conflicts.push({ kind: kind, provinceId: provinceId, codes: codes.slice().sort() });
        }
      });
    });
    conflicts.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === OWNED ? -1 : 1;
      return a.provinceId - b.provinceId;
    });
    return conflicts;
  }

  function colorByProvinceId(kind) {
    var result = new Map();
    collectAssignments(kind).forEach(function (codes, provinceId) {
      if (codes.length !== 1) return; // conflicts keep the original province color
      var country = state.countries.get(codes[0]);
      if (country) result.set(provinceId, country.color);
    });
    return result;
  }

  /** Province hex -> country hex for the active view, or null when not visualizing. */
  function getProvinceHexColorMap() {
    if (!state.countries.size) return null;
    if (state.countryView === 'province') return null;
    var kind = state.countryView === 'control' ? CONTROLLED : OWNED;
    var byProvinceId = colorByProvinceId(kind);
    if (!byProvinceId.size) return null;

    var fills = new Map();
    state.records.forEach(function (record, hex) {
      var color = byProvinceId.get(record.id);
      if (color) fills.set(hex, color);
    });
    return fills.size ? fills : null;
  }

  function countryAssignment(code, provinceId, kind) {
    var country = state.countries.get(code);
    if (!country) return null;
    return country[kind].indexOf(provinceId) !== -1;
  }

  function countriesWithProvince(provinceId, kind) {
    var codes = [];
    state.countries.forEach(function (country, code) {
      if (country[kind].indexOf(provinceId) !== -1) codes.push(code);
    });
    return codes.sort();
  }

  // ---------------------------------------------------------------------------
  // Rendering: sidebar list, summary
  // ---------------------------------------------------------------------------

  function sortCountries() {
    var rows = [];
    state.countries.forEach(function (country, code) { rows.push({ code: code, country: country }); });
    rows.sort(function (a, b) { return a.country.id - b.country.id; });
    return rows;
  }

  function renderList() {
    var list = el.countryList;
    var scrollTop = list.scrollTop;
    list.textContent = '';

    if (!state.countries.size) {
      var hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = 'No countries yet. Use Create Country or import a countries.json file.';
      list.appendChild(hint);
      return;
    }

    var query = (state.countrySearch || '').trim().toLowerCase();
    var rows = sortCountries().filter(function (row) {
      if (!query) return true;
      var haystack = row.code + ' ' + row.country.name + ' id ' + row.country.id;
      return haystack.toLowerCase().indexOf(query) !== -1;
    });

    if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = 'No countries match this search.';
      list.appendChild(empty);
      return;
    }

    var fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      var country = row.country;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'country-row';
      button.dataset.code = row.code;
      if (row.code === state.countrySelected) button.classList.add('is-active');

      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = '#' + country.color;

      var main = document.createElement('span');
      main.className = 'row-main';
      var code = document.createElement('span');
      code.className = 'country-code';
      code.textContent = row.code;
      var name = document.createElement('span');
      name.className = 'row-sub country-name';
      name.textContent = country.name || 'Unnamed country';
      main.appendChild(code);
      main.appendChild(name);

      var badges = document.createElement('span');
      badges.className = 'row-badges';
      var owned = document.createElement('span');
      owned.className = 'row-count';
      owned.textContent = 'own ' + country.owned_provinces.length;
      owned.title = host.plural(country.owned_provinces.length, 'owned province');
      var controlled = document.createElement('span');
      controlled.className = 'row-count';
      controlled.textContent = 'ctl ' + country.controlled_provinces.length;
      controlled.title = host.plural(country.controlled_provinces.length, 'controlled province');
      var id = document.createElement('span');
      id.className = 'pill';
      id.textContent = 'id ' + country.id;
      badges.appendChild(owned);
      badges.appendChild(controlled);
      badges.appendChild(id);

      button.appendChild(swatch);
      button.appendChild(main);
      button.appendChild(badges);
      fragment.appendChild(button);
    });

    list.appendChild(fragment);
    list.scrollTop = scrollTop;
  }

  function renderSummary() {
    var count = state.countries.size;
    if (!count) {
      el.countrySummary.textContent = 'No countries';
    } else {
      var owned = 0;
      var controlled = 0;
      state.countries.forEach(function (country) {
        owned += country.owned_provinces.length;
        controlled += country.controlled_provinces.length;
      });
      var parts = [host.plural(count, 'country', 'countries'), owned + ' owned', controlled + ' controlled'];
      var conflicts = collectConflicts().length;
      if (conflicts) parts.push(host.plural(conflicts, 'conflict'));
      el.countrySummary.textContent = parts.join(' · ');
    }
    el.countryDirty.classList.toggle('hidden', !state.countryDirty);
  }

  // ---------------------------------------------------------------------------
  // Rendering: country editor panel
  // ---------------------------------------------------------------------------

  function renderPanel() {
    var code = state.countrySelected;
    var country = code && state.countries.get(code);
    if (state.tab !== 'countries' || !country) {
      el.countryPanel.classList.add('hidden');
      document.body.classList.remove('country-panel-open');
      return;
    }
    el.countryPanel.classList.remove('hidden');
    document.body.classList.add('country-panel-open');

    var byId = provinceIndex();
    el.cpSwatch.style.background = '#' + country.color;
    el.cpName.textContent = country.name || 'Unnamed country';
    el.cpMeta.textContent = code + ' · id ' + country.id;
    el.cpCode.textContent = code;
    el.cpId.textContent = country.id;
    el.cpColor.textContent = '#' + country.color;
    el.cpOwnedCount.textContent = String(country.owned_provinces.length);
    el.cpControlledCount.textContent = String(country.controlled_provinces.length);
    el.cpOwnedHeading.textContent = host.plural(country.owned_provinces.length, 'province');
    el.cpControlledHeading.textContent = host.plural(country.controlled_provinces.length, 'province');

    renderProvinceList(el.cpOwnedList, country.owned_provinces, byId, OWNED);
    renderProvinceList(el.cpControlledList, country.controlled_provinces, byId, CONTROLLED);

    el.cpModeOwned.classList.toggle('is-active', state.countryMode === OWNED);
    el.cpModeControlled.classList.toggle('is-active', state.countryMode === CONTROLLED);
    el.cpModeHint.textContent = state.countryMode === 'none'
      ? 'Pick a mode, then click provinces on the map to add or remove them. A province can be owned by one country and controlled by another.'
      : 'Click provinces on the map to ' + (state.countryMode === OWNED ? 'add or remove ownership' : 'add or remove control') +
        '. Press Esc or the mode button again to stop.';

    renderConflicts(byId);
  }

  function renderProvinceList(list, ids, byId, kind) {
    list.textContent = '';
    if (!ids.length) {
      var empty = document.createElement('li');
      empty.className = 'cp-empty';
      empty.textContent = kind === OWNED ? 'No owned provinces.' : 'No controlled provinces.';
      list.appendChild(empty);
      return;
    }

    ids.forEach(function (id) {
      var info = byId.get(id);
      var item = document.createElement('li');
      item.className = 'cp-province-row' + (info ? '' : ' is-missing');

      var main = document.createElement('button');
      main.type = 'button';
      main.className = 'cp-province-main';
      main.dataset.id = String(id);
      main.dataset.kind = kind;

      var label = document.createElement('span');
      label.className = 'cp-province-name';
      label.textContent = provinceLabel(info, id);

      var sub = document.createElement('span');
      sub.className = 'cp-province-sub';
      sub.textContent = info
        ? info.hex + ' · id ' + id
        : 'Missing from province data — export will keep the reference';
      main.title = info ? 'Highlight this province on the map' : 'This province no longer exists';

      main.appendChild(label);
      main.appendChild(sub);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cp-unassign';
      remove.dataset.id = String(id);
      remove.dataset.kind = kind;
      remove.title = 'Remove assignment';
      remove.setAttribute('aria-label', 'Remove province ' + id);
      remove.textContent = '✕';

      item.appendChild(main);
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  function renderConflicts(byId) {
    var conflicts = collectConflicts();
    el.cpConflicts.textContent = '';
    if (!conflicts.length) {
      el.cpConflicts.classList.add('hidden');
      return;
    }

    el.cpConflicts.classList.remove('hidden');
    var title = document.createElement('p');
    title.className = 'cp-conflict-title';
    title.textContent = host.plural(conflicts.length, 'assignment conflict');
    el.cpConflicts.appendChild(title);

    conflicts.forEach(function (conflict) {
      var info = byId.get(conflict.provinceId);
      var row = document.createElement('div');
      row.className = 'cp-conflict';

      var text = document.createElement('p');
      text.className = 'cp-conflict-text';
      text.textContent = (info ? provinceLabel(info, conflict.provinceId) + ' (#' + conflict.provinceId + ')' : 'Province #' + conflict.provinceId) +
        ' is ' + (conflict.kind === OWNED ? 'owned' : 'controlled') + ' by ' +
        conflict.codes.map(countryName).join(' and ') + '.';
      row.appendChild(text);

      var actions = document.createElement('div');
      actions.className = 'cp-conflict-actions';
      conflict.codes.forEach(function (code) {
        var keep = document.createElement('button');
        keep.type = 'button';
        keep.className = 'chip';
        keep.dataset.keep = code;
        keep.dataset.kind = conflict.kind;
        keep.dataset.id = String(conflict.provinceId);
        keep.textContent = 'Keep ' + code;
        keep.title = 'Remove this province from the other countries';
        actions.appendChild(keep);
      });
      row.appendChild(actions);
      el.cpConflicts.appendChild(row);
    });
  }

  function render() {
    renderList();
    renderSummary();
    renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Selection & assignment
  // ---------------------------------------------------------------------------

  function selectCountry(code) {
    if (!state.countries.has(code)) return;
    if (state.countrySelected !== code) host.clearHighlight();
    var wasHidden = !state.countrySelected;
    state.countrySelected = code;
    exitEditMode();
    render();
    host.refreshMap();
    // The editor panel covers part of the map; re-fit once if the user has not zoomed.
    if (wasHidden) host.refitIfAuto();
  }

  function setMode(mode) {
    var next = state.countryMode === mode ? 'none' : mode;
    state.countryMode = next;
    el.viewport.classList.toggle('is-assigning', next !== 'none');
    renderPanel();
  }

  function setView(view) {
    if (view !== 'ownership' && view !== 'control' && view !== 'province') view = 'ownership';
    state.countryView = view;
    Array.prototype.forEach.call(el.countryViewModes.querySelectorAll('.chip'), function (chip) {
      chip.classList.toggle('is-active', chip.dataset.view === view);
    });
    host.refreshMap();
  }

  function toggleAssignment(code, kind, provinceId) {
    var country = state.countries.get(code);
    if (!country) return;
    var ids = country[kind];
    var index = ids.indexOf(provinceId);
    var added = index === -1;

    if (added) {
      ids.push(provinceId);
      ids.sort(numeric);
    } else {
      ids.splice(index, 1);
    }

    markDirty();
    render();
    host.refreshMap();

    var info = provinceIndex().get(provinceId);
    var label = provinceLabel(info, provinceId);
    if (!added) {
      host.toast('Removed ' + label + ' from ' + code + ' ' + (kind === OWNED ? 'ownership' : 'control') + '.', 'info');
      return;
    }

    var others = countriesWithProvince(provinceId, kind).filter(function (other) { return other !== code; });
    if (others.length) {
      host.toast(
        'Conflict: ' + label + ' is also ' + (kind === OWNED ? 'owned' : 'controlled') + ' by ' +
        others.map(countryName).join(', ') + '. Nothing was overwritten — resolve it in the country panel.',
        'warn'
      );
    } else {
      host.toast('Assigned ' + label + ' to ' + countryName(code) + ' (' + (kind === OWNED ? 'owned' : 'controlled') + ').', 'success');
    }
  }

  /** Called by app.js when a province is clicked while the Countries tab is active. */
  function handleProvinceClick(hex) {
    var record = state.records.get(hex);
    if (!record) {
      host.toast('This province is not registered. Add it on the Provinces tab first.', 'warn');
      return;
    }

    var code = state.countrySelected;
    var country = code && state.countries.get(code);

    if (!country) {
      host.toast('Select a country in the list to assign provinces.', 'info');
      host.highlightProvince(hex);
      return;
    }

    if (state.countryMode === 'none') {
      host.highlightProvince(hex);
      var owners = countriesWithProvince(record.id, OWNED);
      var controllers = countriesWithProvince(record.id, CONTROLLED);
      var parts = [
        (host.isLabeled(record) ? record.name : 'Unnamed province') + ' (#' + record.id + ')',
        'owner: ' + (owners.length ? owners.join(', ') : 'none'),
        'controller: ' + (controllers.length ? controllers.join(', ') : 'none')
      ];
      host.toast(parts.join(' · '), 'info');
      return;
    }

    toggleAssignment(code, state.countryMode, record.id);
  }

  function removeAssignment(code, kind, provinceId) {
    var country = state.countries.get(code);
    if (!country) return;
    var index = country[kind].indexOf(provinceId);
    if (index === -1) return;
    country[kind].splice(index, 1);
    markDirty();
    render();
    host.refreshMap();
  }

  // ---------------------------------------------------------------------------
  // Create / edit / delete
  // ---------------------------------------------------------------------------

  function showFormError(node, message) {
    node.textContent = message;
    node.classList.remove('hidden');
  }

  function clearFormError(node) {
    node.textContent = '';
    node.classList.add('hidden');
  }

  function syncColorPreview(picker, input, preview) {
    var color = normalizeHex(input.value);
    if (color) {
      picker.value = '#' + color;
      preview.style.background = '#' + color;
    }
  }

  function openCreate() {
    clearFormError(el.countryFormError);
    el.countryCodeInput.value = '';
    el.countryNameInput.value = '';
    el.countryColorInput.value = '4f9cf9';
    el.countryColorPicker.value = '#4f9cf9';
    el.countryColorPreview.style.background = '#4f9cf9';
    el.countryNextId.textContent = String(state.countryNextId);
    host.openModal(el.countryModal);
    el.countryCodeInput.focus();
  }

  function closeCreate() {
    host.closeModal(el.countryModal);
  }

  function confirmCreate() {
    var code = String(el.countryCodeInput.value || '').trim();
    var name = String(el.countryNameInput.value || '').trim();
    var color = normalizeHex(el.countryColorInput.value);

    if (!code) { showFormError(el.countryFormError, 'Country code cannot be empty.'); el.countryCodeInput.focus(); return; }
    if (!looksLikeCountryCode(code)) {
      showFormError(el.countryFormError, 'Use 1–16 letters, digits, “-” or “_” (no spaces).');
      el.countryCodeInput.focus();
      return;
    }
    if (codeTaken(code)) {
      showFormError(el.countryFormError, 'Country code "' + code.toUpperCase() + '" already exists.');
      el.countryCodeInput.focus();
      return;
    }
    if (!name) { showFormError(el.countryFormError, 'Country name cannot be empty.'); el.countryNameInput.focus(); return; }
    if (!color) {
      showFormError(el.countryFormError, 'Enter a valid 6-digit HEX color, for example 5b6ee1.');
      el.countryColorInput.focus();
      return;
    }

    var country = {
      id: state.countryNextId++,
      name: name,
      color: color,
      owned_provinces: [],
      controlled_provinces: [],
      extra: {}
    };
    state.countries.set(code, country);
    state.countrySelected = code;
    markDirty();
    closeCreate();
    render();
    host.refreshMap();
    host.toast('Created ' + countryName(code) + ' with id ' + country.id + '.', 'success');
  }

  function exitEditMode() {
    el.cpForm.classList.add('hidden');
    el.cpRead.classList.remove('hidden');
    el.cpAssign.classList.remove('hidden');
    clearFormError(el.cpFormError);
  }

  function beginEdit() {
    var country = state.countrySelected ? state.countries.get(state.countrySelected) : null;
    if (!country) return;
    el.cpCodeInput.value = state.countrySelected;
    el.cpNameInput.value = country.name;
    el.cpColorInput.value = country.color;
    el.cpColorPicker.value = '#' + country.color;
    el.cpColorPreview.style.background = '#' + country.color;
    clearFormError(el.cpFormError);
    el.cpForm.classList.remove('hidden');
    el.cpRead.classList.add('hidden');
    el.cpAssign.classList.add('hidden');
    el.cpCodeInput.focus();
  }

  function saveEdit() {
    var code = state.countrySelected;
    var country = code ? state.countries.get(code) : null;
    if (!country) { exitEditMode(); return; }

    var nextCode = String(el.cpCodeInput.value || '').trim();
    var name = String(el.cpNameInput.value || '').trim();
    var color = normalizeHex(el.cpColorInput.value);

    if (!nextCode) { showFormError(el.cpFormError, 'Country code cannot be empty.'); return; }
    if (!looksLikeCountryCode(nextCode)) {
      showFormError(el.cpFormError, 'Use 1–16 letters, digits, “-” or “_” (no spaces).');
      return;
    }
    if (nextCode !== code && codeTaken(nextCode, code)) {
      showFormError(el.cpFormError, 'Country code "' + nextCode.toUpperCase() + '" already exists.');
      return;
    }
    if (!name) { showFormError(el.cpFormError, 'Country name cannot be empty.'); return; }
    if (!color) { showFormError(el.cpFormError, 'Enter a valid 6-digit HEX color, for example 5b6ee1.'); return; }

    if (nextCode !== code) {
      var entries = Array.from(state.countries.entries()).map(function (entry) {
        return entry[0] === code ? [nextCode, entry[1]] : entry;
      });
      state.countries = new Map(entries);
      state.countrySelected = nextCode;
    }

    country.name = name;
    country.color = color;

    markDirty();
    exitEditMode();
    render();
    host.refreshMap();
    host.toast('Saved ' + countryName(state.countrySelected) + ' (id ' + country.id + ' preserved).', 'success');
  }

  function requestDelete() {
    var code = state.countrySelected;
    var country = code ? state.countries.get(code) : null;
    if (!country) return;
    pendingDeleteCode = code;
    el.countryDeleteDetail.textContent = (country.name || 'Unnamed country') + ' · ' + code + ' · id ' + country.id +
      ' · ' + host.plural(country.owned_provinces.length + country.controlled_provinces.length, 'assignment');
    host.openModal(el.countryDeleteModal);
  }

  function cancelDelete() {
    pendingDeleteCode = null;
    host.closeModal(el.countryDeleteModal);
  }

  function confirmDelete() {
    var code = pendingDeleteCode;
    pendingDeleteCode = null;
    host.closeModal(el.countryDeleteModal);
    if (!code) return;

    var country = state.countries.get(code);
    if (!country) return;
    var label = countryName(code);
    var id = country.id;

    state.countries.delete(code);
    if (state.countrySelected === code) state.countrySelected = null;
    state.countryMode = 'none';
    el.viewport.classList.remove('is-assigning');
    host.clearHighlight();

    markDirty();
    render();
    host.refreshMap();
    host.toast('Deleted ' + label + ' (id ' + id + '). Provinces were not changed.', 'info');
  }

  // ---------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------

  function parseIdArray(value, code, field, warnings) {
    if (value == null) {
      warnings.push('Country "' + code + '": ' + field + ' is missing — set to [].');
      return [];
    }
    if (!Array.isArray(value)) {
      warnings.push('Country "' + code + '": ' + field + ' is not an array — set to [].');
      return [];
    }
    var out = [];
    var seen = new Set();
    value.forEach(function (entry) {
      var number = typeof entry === 'number'
        ? entry
        : (typeof entry === 'string' && /^\d+$/.test(entry.trim()) ? Number(entry.trim()) : NaN);
      if (!Number.isInteger(number) || number < 0) {
        warnings.push('Country "' + code + '": ' + field + ' entry "' + entry + '" is not an integer ID — dropped.');
        return;
      }
      if (seen.has(number)) {
        warnings.push('Country "' + code + '": duplicate entry ' + number + ' in ' + field + ' — kept once.');
        return;
      }
      seen.add(number);
      out.push(number);
    });
    out.sort(numeric);
    return out;
  }

  function parseCountriesJson(text, fileName) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON in ' + fileName + ': ' + err.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid countries.json structure: expected an object keyed by country code.');
    }

    var countries = new Map();
    var warnings = [];
    var seenCodes = new Set();
    var usedIds = new Set();

    Object.keys(data).forEach(function (rawCode) {
      var raw = data[rawCode];
      var code = String(rawCode).trim();

      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push('Country "' + rawCode + '" is not an object — skipped.');
        return;
      }
      if (!looksLikeCountryCode(code)) {
        warnings.push('Country code "' + rawCode + '" is not valid — skipped.');
        return;
      }
      if (seenCodes.has(code.toLowerCase())) {
        warnings.push('Duplicate country code "' + code + '" — the first record was kept.');
        return;
      }
      seenCodes.add(code.toLowerCase());

      var name = typeof raw.name === 'string' ? raw.name : '';
      if (typeof raw.name !== 'string') warnings.push('Country "' + code + '": name is missing or not a string.');
      if (!name.trim()) warnings.push('Country "' + code + '" has an empty name.');

      var color = normalizeHex(raw.color);
      if (!color) {
        warnings.push('Country "' + code + '": invalid color "' + raw.color + '" — using neutral #' + NEUTRAL_COLOR + '.');
        color = NEUTRAL_COLOR;
      }

      var id = Number.isInteger(raw.id) && raw.id >= 0 ? raw.id : null;
      if (id === null) {
        warnings.push('Country "' + code + '": missing or invalid id — a new ID will be assigned.');
      } else if (usedIds.has(id)) {
        warnings.push('Country "' + code + '": duplicate ID ' + id + ' — a new ID will be assigned.');
        id = null;
      }
      if (id !== null) usedIds.add(id);

      var extra = {};
      Object.keys(raw).forEach(function (key) {
        if (key === 'name' || key === 'id' || key === 'color' || key === 'owned_provinces' || key === 'controlled_provinces') return;
        extra[key] = raw[key];
      });

      countries.set(code, {
        id: id,
        name: name,
        color: color,
        owned_provinces: parseIdArray(raw.owned_provinces, code, OWNED, warnings),
        controlled_provinces: parseIdArray(raw.controlled_provinces, code, CONTROLLED, warnings),
        extra: extra
      });
    });

    var maxId = 0;
    countries.forEach(function (country) {
      if (Number.isInteger(country.id) && country.id > maxId) maxId = country.id;
    });
    var nextId = maxId + 1;
    countries.forEach(function (country) {
      if (country.id === null) country.id = nextId++;
    });

    return { countries: countries, nextId: nextId, warnings: warnings };
  }

  function validateProvinceRefs(countries) {
    var known = new Set();
    state.records.forEach(function (record) { known.add(record.id); });
    var missing = [];
    countries.forEach(function (country, code) {
      [OWNED, CONTROLLED].forEach(function (kind) {
        country[kind].forEach(function (id) {
          if (!known.has(id)) missing.push(code + ' → #' + id);
        });
      });
    });
    return { missing: missing, hasProvinces: known.size > 0 };
  }

  function importText(text, fileName) {
    var parsed = parseCountriesJson(text, fileName);
    var refs = validateProvinceRefs(parsed.countries);

    state.countries = parsed.countries;
    state.countryNextId = parsed.nextId;
    state.countrySelected = null;
    state.countryMode = 'none';
    el.viewport.classList.remove('is-assigning');
    state.countryDirty = true;

    var warnings = parsed.warnings.slice();
    if (!refs.hasProvinces && (parsed.countries.size)) {
      warnings.push('No province data is loaded yet, so country assignments cannot be validated.');
    } else if (refs.missing.length) {
      warnings.push(host.plural(refs.missing.length, 'province reference is', 'province references are') +
        ' missing from the loaded province data: ' + refs.missing.slice(0, 12).join(', ') +
        (refs.missing.length > 12 ? ' and ' + (refs.missing.length - 12) + ' more' : '') + '.');
    }

    render();
    host.refreshMap();

    if (warnings.length) {
      host.showNotice('Countries imported with warnings', [
        host.plural(state.countries.size, 'country', 'countries') + ' loaded from ' + fileName + '.'
      ], warnings.map(function (text) { return { kind: 'warn', text: text }; }));
    } else {
      host.toast('Imported ' + host.plural(state.countries.size, 'country', 'countries') + ' from ' + fileName + '.', 'success');
    }
  }

  function importFile(file) {
    file.text().then(function (text) {
      importText(text, file.name);
    }).catch(function (err) {
      console.warn('[Country tab] import failed:', err);
      host.toast((err && err.message) || 'The countries file could not be imported.', 'error');
    });
  }

  function exportText() {
    var blocks = [];
    state.countries.forEach(function (country, code) {
      var props = [
        '        "name": ' + JSON.stringify(country.name),
        '        "id": ' + country.id,
        '        "color": ' + JSON.stringify(country.color),
        '        "owned_provinces": [' + country.owned_provinces.join(', ') + ']',
        '        "controlled_provinces": [' + country.controlled_provinces.join(', ') + ']'
      ];
      Object.keys(country.extra).forEach(function (key) {
        props.push('        ' + JSON.stringify(key) + ': ' + JSON.stringify(country.extra[key], null, 4).replace(/\n/g, '\n        '));
      });
      blocks.push('    ' + JSON.stringify(code) + ': {\n' + props.join(',\n') + '\n    }');
    });
    return blocks.length ? '{\n' + blocks.join(',\n') + '\n}' : '{}';
  }

  function exportJson() {
    if (!state.countries.size) {
      host.toast('No countries to export yet.', 'error');
      return;
    }
    host.download(exportText() + '\n', 'countries.json');
    state.countryDirty = false;
    renderSummary();
    host.toast('Exported ' + host.plural(state.countries.size, 'country', 'countries') + '.', 'success');
  }

  // ---------------------------------------------------------------------------
  // Host callbacks
  // ---------------------------------------------------------------------------

  function onTabChanged(tab) {
    if (tab !== 'countries') {
      state.countryMode = 'none';
      el.viewport.classList.remove('is-assigning');
      document.body.classList.remove('country-panel-open');
      exitEditMode();
    }
    render();
  }

  function onMapLoaded() {
    render();
    host.refreshMap();
  }

  function onProvincesChanged() {
    render();
    host.refreshMap();
  }

  function handleEscape() {
    if (!el.countryModal.classList.contains('hidden')) { closeCreate(); return true; }
    if (!el.countryDeleteModal.classList.contains('hidden')) { cancelDelete(); return true; }
    if (state.tab !== 'countries') return false;
    if (!el.cpForm.classList.contains('hidden')) { exitEditMode(); return true; }
    if (state.countryMode !== 'none') { setMode('none'); return true; }
    if (state.countrySelected) {
      state.countrySelected = null;
      host.clearHighlight();
      render();
      host.refreshMap();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function cache() {
    FIELD_IDS.forEach(function (id) { el[id] = document.getElementById(id); });
    el.viewport = document.getElementById('viewport');
  }

  function wire() {
    el.btnCreateCountry.addEventListener('click', openCreate);
    el.countryCreateCancel.addEventListener('click', closeCreate);
    el.countryCreateConfirm.addEventListener('click', confirmCreate);
    el.countryModal.addEventListener('click', function (event) {
      if (event.target === el.countryModal) closeCreate();
    });

    el.btnImportCountries.addEventListener('click', function () { el.countriesInput.click(); });
    el.btnExportCountries.addEventListener('click', exportJson);
    el.countriesInput.addEventListener('change', function () {
      var file = el.countriesInput.files && el.countriesInput.files[0];
      el.countriesInput.value = '';
      if (file) importFile(file);
    });

    el.countrySearch.addEventListener('input', function () {
      state.countrySearch = el.countrySearch.value;
      renderList();
    });

    el.countryList.addEventListener('click', function (event) {
      var row = event.target.closest('.country-row');
      if (!row) return;
      selectCountry(row.dataset.code);
    });

    el.cpClose.addEventListener('click', function () {
      state.countrySelected = null;
      host.clearHighlight();
      exitEditMode();
      render();
      host.refreshMap();
    });

    el.cpEdit.addEventListener('click', beginEdit);
    el.cpCancel.addEventListener('click', exitEditMode);
    el.cpForm.addEventListener('submit', function (event) {
      event.preventDefault();
      saveEdit();
    });
    el.cpDelete.addEventListener('click', requestDelete);
    el.countryDeleteCancel.addEventListener('click', cancelDelete);
    el.countryDeleteConfirm.addEventListener('click', confirmDelete);
    el.countryDeleteModal.addEventListener('click', function (event) {
      if (event.target === el.countryDeleteModal) cancelDelete();
    });

    el.cpCodeInput.addEventListener('input', function () { clearFormError(el.cpFormError); });
    el.cpNameInput.addEventListener('input', function () { clearFormError(el.cpFormError); });
    el.cpColorInput.addEventListener('input', function () {
      clearFormError(el.cpFormError);
      syncColorPreview(el.cpColorPicker, el.cpColorInput, el.cpColorPreview);
    });
    el.cpColorPicker.addEventListener('input', function () {
      el.cpColorInput.value = el.cpColorPicker.value.slice(1);
      el.cpColorPreview.style.background = el.cpColorPicker.value;
      clearFormError(el.cpFormError);
    });

    el.countryCodeInput.addEventListener('input', function () { clearFormError(el.countryFormError); });
    el.countryNameInput.addEventListener('input', function () { clearFormError(el.countryFormError); });
    el.countryColorInput.addEventListener('input', function () {
      clearFormError(el.countryFormError);
      syncColorPreview(el.countryColorPicker, el.countryColorInput, el.countryColorPreview);
    });
    el.countryColorPicker.addEventListener('input', function () {
      el.countryColorInput.value = el.countryColorPicker.value.slice(1);
      el.countryColorPreview.style.background = el.countryColorPicker.value;
      clearFormError(el.countryFormError);
    });

    el.cpModeOwned.addEventListener('click', function () { setMode(OWNED); });
    el.cpModeControlled.addEventListener('click', function () { setMode(CONTROLLED); });

    el.countryViewModes.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) return;
      setView(chip.dataset.view);
    });

    [el.cpOwnedList, el.cpControlledList].forEach(function (list) {
      list.addEventListener('click', function (event) {
        var remove = event.target.closest('.cp-unassign');
        if (remove) {
          if (!state.countrySelected) return;
          removeAssignment(state.countrySelected, remove.dataset.kind, Number(remove.dataset.id));
          return;
        }
        var main = event.target.closest('.cp-province-main');
        if (!main) return;
        var id = Number(main.dataset.id);
        var info = provinceIndex().get(id);
        if (!info) {
          host.toast('Province #' + id + ' is not in the loaded province data.', 'warn');
          return;
        }
        host.highlightProvince(info.hex);
      });
    });

    el.cpConflicts.addEventListener('click', function (event) {
      var keep = event.target.closest('[data-keep]');
      if (!keep) return;
      var code = keep.dataset.keep;
      var kind = keep.dataset.kind;
      var provinceId = Number(keep.dataset.id);
      var removed = 0;
      state.countries.forEach(function (country, otherCode) {
        if (otherCode === code) return;
        var index = country[kind].indexOf(provinceId);
        if (index === -1) return;
        country[kind].splice(index, 1);
        removed++;
      });
      if (!removed) return;
      markDirty();
      render();
      host.refreshMap();
      host.toast('Resolved: ' + provinceId + ' kept for ' + code + '.', 'success');
    });
  }

  function init(hostApi) {
    host = hostApi;
    state = hostApi.state;
    states();

    cache();
    wire();
    setView(state.countryView);
    render();
  }

  function states() {
    if (!state.countries) state.countries = new Map();
    if (!Number.isInteger(state.countryNextId)) state.countryNextId = 1;
    if (state.countrySelected === undefined) state.countrySelected = null;
    if (!state.countryMode) state.countryMode = 'none';
    if (!state.countryView) state.countryView = 'ownership';
    if (state.countryDirty === undefined) state.countryDirty = false;
    if (typeof state.countrySearch !== 'string') state.countrySearch = '';
  }

  root.CountryTab = {
    init: init,
    render: render,
    exportText: exportText,
    exportJson: exportJson,
    importText: importText,
    getProvinceHexColorMap: getProvinceHexColorMap,
    handleProvinceClick: handleProvinceClick,
    handleEscape: handleEscape,
    onTabChanged: onTabChanged,
    onMapLoaded: onMapLoaded,
    onProvincesChanged: onProvincesChanged,
    collectConflicts: collectConflicts,
    selectCountry: selectCountry
  };
})(window);
