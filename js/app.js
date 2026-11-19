/*!
 * Province Map Editor — UI, JSON model and province editing.
 */
(function () {
  'use strict';

  var HEX_RE = /^[0-9a-f]{6}$/;
  var ROW_LIMIT = 400;
  var EXPORT_INDENT = '    ';
  var ALPHA_THRESHOLD = 16;
  var SVG_MAX_RASTER_DIM = 4000;
  var MAX_TOASTS = 4;
  var SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'text', 'tspan', 'use', 'textpath']);
  var HIDDEN_SVG_CONTAINERS = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'filter']);

  var state = {
    map: null,
    records: new Map(),
    analysis: null,
    selected: null,
    settings: {
      tolerance: 0,
      minRegionPixels: 1,
      ignoreColors: []
    },
    ignoreTouched: false,
    nextId: 1,
    jsonName: '',
    filter: 'all',
    search: '',
    view: { scale: 1, x: 0, y: 0 },
    baseScale: 1,
    autoFit: true,
    busy: false,
    warnings: [],
    lastSummary: null,
    overlayImageData: null,
    countryImageData: null,
    highlightHex: null,
    tab: 'provinces',
    popupHadSaved: false,
    pointer: null,
    colorProbeCtx: null,
    /** Colors explicitly unregistered by the user; re-analysis leaves them out. */
    deletedColors: new Set(),
    pendingDelete: null
  };

  var el = {};

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------

  function byId(id) { return document.getElementById(id); }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function toHex(r, g, b) {
    return ((1 << 24) + ((r & 255) << 16) + ((g & 255) << 8) + (b & 255)).toString(16).slice(1);
  }

  function formatNumber(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function isLabeled(record) {
    return !!(record && typeof record.name === 'string' && record.name.trim());
  }

  function plural(count, one, many) {
    return count + ' ' + (count === 1 ? one : (many || one + 's'));
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { setTimeout(resolve, 0); });
    });
  }

  function recordsById() {
    var map = new Map();
    state.records.forEach(function (rec) { map.set(rec.id, rec); });
    return map;
  }

  function truncateList(items, limit) {
    if (items.length <= limit) return items.join(', ');
    return items.slice(0, limit).join(', ') + ' and ' + (items.length - limit) + ' more';
  }

  // ---------------------------------------------------------------------------
  // Colors (used for SVG fills)
  // ---------------------------------------------------------------------------

  function normalizeCssColor(value) {
    if (!value) return null;
    var raw = String(value).trim();
    var lower = raw.toLowerCase();
    if (!lower || lower === 'none' || lower === 'transparent' || lower === 'inherit' ||
        lower === 'currentcolor' || lower.indexOf('url(') === 0) return null;

    if (!state.colorProbeCtx) {
      state.colorProbeCtx = document.createElement('canvas').getContext('2d');
    }
    var ctx = state.colorProbeCtx;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = raw;
    var normalized = String(ctx.fillStyle);

    if (normalized.charAt(0) === '#' && HEX_RE.test(normalized.slice(1).toLowerCase())) {
      return normalized.slice(1).toLowerCase();
    }
    var match = normalized.match(/^rgba?\(([^)]+)\)$/i);
    if (match) {
      var parts = match[1].split(/[\s,\/]+/).map(Number);
      if (parts.length >= 4 && parts[3] === 0) return null;
      if (!isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) return null;
      return toHex(parts[0], parts[1], parts[2]);
    }
    return null;
  }

  function parseIgnoreList(text) {
    var colors = [];
    var invalid = [];
    var seen = new Set();
    String(text || '').split(/[\s,;]+/).forEach(function (token) {
      var value = token.trim().toLowerCase().replace(/^#/, '');
      if (!value) return;
      if (!HEX_RE.test(value)) { invalid.push(token); return; }
      if (!seen.has(value)) { seen.add(value); colors.push(value); }
    });
    return { colors: colors, invalid: invalid };
  }

  // ---------------------------------------------------------------------------
  // Map loading
  // ---------------------------------------------------------------------------

  function loadImageElement(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('The image could not be decoded.')); };
      img.src = src;
    });
  }

  function loadRasterMap(file) {
    var url = URL.createObjectURL(file);
    return loadImageElement(url).then(function (img) {
      var width = img.naturalWidth || img.width;
      var height = img.naturalHeight || img.height;
      if (!width || !height) throw new Error('The image has no readable dimensions.');

      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.className = 'map-canvas';
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
      ctx.drawImage(img, 0, 0);

      var imageData;
      try {
        imageData = ctx.getImageData(0, 0, width, height);
      } catch (err) {
        throw new Error('The image could not be read (the canvas is too large or tainted).');
      }

      var countryCanvas = document.createElement('canvas');
      countryCanvas.width = width;
      countryCanvas.height = height;
      countryCanvas.className = 'map-layer map-country';
      var countryCtx = countryCanvas.getContext('2d');

      var overlay = document.createElement('canvas');
      overlay.width = width;
      overlay.height = height;
      overlay.className = 'map-layer map-overlay';
      var overlayCtx = overlay.getContext('2d');

      return {
        kind: 'raster',
        name: file.name,
        width: width,
        height: height,
        imageData: imageData,
        canvas: canvas,
        ctx: ctx,
        countryCanvas: countryCanvas,
        countryCtx: countryCtx,
        overlay: overlay,
        overlayCtx: overlayCtx
      };
    }).then(function (map) {
      URL.revokeObjectURL(url);
      return map;
    }, function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  function svgIntrinsicSize(svg) {
    var widthAttr = svg.getAttribute('width');
    var heightAttr = svg.getAttribute('height');
    var width = widthAttr && widthAttr.indexOf('%') === -1 ? parseFloat(widthAttr) : NaN;
    var height = heightAttr && heightAttr.indexOf('%') === -1 ? parseFloat(heightAttr) : NaN;
    var viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    var hasViewBox = viewBox.length === 4 && viewBox.every(function (n) { return isFinite(n); }) &&
      viewBox[2] > 0 && viewBox[3] > 0;

    if (!isFinite(width) || width <= 0) width = hasViewBox ? viewBox[2] : 1000;
    if (!isFinite(height) || height <= 0) height = hasViewBox ? viewBox[3] : 1000;
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  function isInsideHiddenContainer(node, root) {
    var parent = node.parentElement;
    while (parent && parent !== root) {
      if (parent.tagName && HIDDEN_SVG_CONTAINERS.has(parent.tagName.toLowerCase())) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  function indexSvgColors(root) {
    var fillByEl = new Map();
    var elsByColor = new Map();
    var snapHexes = new Set();
    var nodes = root.querySelectorAll('*');

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType !== 1) continue;
      var tag = node.tagName.toLowerCase();
      if (HIDDEN_SVG_CONTAINERS.has(tag)) continue;
      if (isInsideHiddenContainer(node, root)) continue;
      if (tag === 'title' || tag === 'desc' || tag === 'style' || tag === 'metadata') continue;

      var style = window.getComputedStyle(node);
      if (!style) continue;

      if (SHAPE_TAGS.has(tag)) {
        var fill = normalizeCssColor(style.fill);
        if (fill) {
          fillByEl.set(node, fill);
          snapHexes.add(fill);
          var list = elsByColor.get(fill);
          if (list) list.push(node);
          else elsByColor.set(fill, [node]);
        }
      }

      var stroke = normalizeCssColor(style.stroke);
      var strokeWidth = parseFloat(style.strokeWidth);
      if (stroke && isFinite(strokeWidth) && strokeWidth > 0) snapHexes.add(stroke);
    }

    return { fillByEl: fillByEl, elsByColor: elsByColor, snapHexes: snapHexes };
  }

  function rasterizeSvg(svgText, targetWidth, targetHeight) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          var ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
          resolve(ctx.getImageData(0, 0, targetWidth, targetHeight));
        } catch (err) {
          reject(new Error('The SVG could not be rasterized for analysis.'));
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('The SVG could not be rasterized for analysis.'));
      };
      img.src = url;
    });
  }

  function loadSvgMap(file) {
    return file.text().then(function (text) {
      var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (doc.querySelector('parsererror')) throw new Error('The SVG file could not be parsed.');
      var source = doc.documentElement;
      if (!source || source.tagName.toLowerCase() !== 'svg') throw new Error('The file is not an SVG document.');

      var size = svgIntrinsicSize(source);
      source.setAttribute('width', String(size.width));
      source.setAttribute('height', String(size.height));
      if (!source.getAttribute('viewBox')) {
        source.setAttribute('viewBox', '0 0 ' + size.width + ' ' + size.height);
      }
      var serialized = new XMLSerializer().serializeToString(source);

      var svg = document.importNode(source, true);
      el.stage.textContent = '';
      el.stage.appendChild(svg);

      var indexed = indexSvgColors(svg);
      var scale = Math.min(1, SVG_MAX_RASTER_DIM / Math.max(size.width, size.height));
      var rasterWidth = Math.max(1, Math.round(size.width * scale));
      var rasterHeight = Math.max(1, Math.round(size.height * scale));

      return rasterizeSvg(serialized, rasterWidth, rasterHeight).then(function (imageData) {
        var snapColors = [];
        indexed.snapHexes.forEach(function (hex) {
          var value = window.MapAnalyzer.hexToInt(hex);
          if (value !== null) snapColors.push(value);
        });
        return {
          kind: 'svg',
          name: file.name,
          width: size.width,
          height: size.height,
          svg: svg,
          imageData: imageData,
          rasterWidth: rasterWidth,
          rasterHeight: rasterHeight,
          fillByEl: indexed.fillByEl,
          elsByColor: indexed.elsByColor,
          snapColors: snapColors
        };
      });
    });
  }

  function handleMapFile(file) {
    var lower = file.name.toLowerCase();
    var isSvg = /\.svg$/.test(lower) || file.type === 'image/svg+xml';
    var isRaster = /\.(png|jpe?g)$/.test(lower) || /^image\/(png|jpeg)$/.test(file.type);

    if (!isSvg && !isRaster) {
      toast('Unsupported image file. Use PNG, JPG, JPEG or SVG.', 'error');
      return;
    }
    if (state.busy) { toast('Please wait for the current operation to finish.', 'warn'); return; }

    closePopup();
    toggleBusy(true, 'Loading map…');

    var loader = isSvg ? loadSvgMap(file) : loadRasterMap(file);
    loader.then(function (map) {
      state.map = map;
      state.analysis = null;
      state.warnings = [];
      state.lastSummary = null;
      state.overlayImageData = null;
      state.deletedColors = new Set();
      mountMap();
      updateChips();
      renderStatus();
      renderList();

      if (state.records.size) {
        return analyzeMap({ reason: 'map' });
      }
      toast('Map loaded. Import a JSON file to generate province records, or run Analyze Map.', 'info');
      return null;
    }).catch(function (err) {
      console.warn('[Province Map Editor] map load failed:', err);
      mountMap();
      updateChips();
      renderStatus();
      renderList();
      toast(err && err.message ? err.message : 'The map could not be loaded.', 'error');
    }).then(function () {
      toggleBusy(false);
    });
  }

  function mountMap() {
    var map = state.map;
    el.stage.textContent = '';
    if (!map) {
      el.stage.removeAttribute('style');
      el.emptyState.classList.remove('hidden');
      return;
    }
    el.emptyState.classList.add('hidden');
    el.stage.style.width = map.width + 'px';
    el.stage.style.height = map.height + 'px';
    if (map.kind === 'raster') {
      el.stage.appendChild(map.canvas);
      el.stage.appendChild(map.countryCanvas);
      el.stage.appendChild(map.overlay);
    } else {
      el.stage.appendChild(map.svg);
    }
    renderCountryLayer();
    applySvgAppearance();
    if (rootCountryTab()) rootCountryTab().onMapLoaded();
    fitView();
  }

  // ---------------------------------------------------------------------------
  // View transform
  // ---------------------------------------------------------------------------

  function applyView() {
    var view = state.view;
    el.stage.style.transform = 'translate3d(' + view.x + 'px, ' + view.y + 'px, 0) scale(' + view.scale + ')';
    el.zoomReadout.textContent = Math.round(view.scale * 100) + '%';
    if (state.map && state.map.kind === 'raster') {
      state.map.canvas.style.imageRendering = view.scale >= 1.5 ? 'pixelated' : 'auto';
    }
  }

  function setView(next) {
    if (!state.map) return;
    var minScale = Math.max(0.01, state.baseScale * 0.05);
    var maxScale = Math.max(2, state.baseScale * 64);
    state.view.scale = clamp(next.scale, minScale, maxScale);
    state.view.x = next.x;
    state.view.y = next.y;
    applyView();
  }

  /** Width covered by the country editor panel, so Fit keeps the map visible. */
  function panelInset() {
    if (state.tab !== 'countries') return 0;
    var panel = document.getElementById('countryPanel');
    if (!panel || panel.classList.contains('hidden')) return 0;
    return panel.offsetWidth + 32;
  }

  function fitView() {
    var map = state.map;
    if (!map) return;
    var rect = el.viewport.getBoundingClientRect();
    var inset = Math.min(panelInset(), Math.max(0, rect.width - 200));
    var availableWidth = Math.max(80, rect.width - inset - 64);
    var availableHeight = Math.max(80, rect.height - 64);
    var scale = Math.min(availableWidth / map.width, availableHeight / map.height);
    state.baseScale = clamp(scale, 0.01, 16);
    state.autoFit = true;
    setView({
      scale: state.baseScale,
      x: (rect.width - inset - map.width * state.baseScale) / 2,
      y: (rect.height - map.height * state.baseScale) / 2
    });
  }

  function zoomAt(clientX, clientY, factor) {
    if (!state.map) return;
    var rect = el.viewport.getBoundingClientRect();
    var cx = clientX - rect.left;
    var cy = clientY - rect.top;
    var view = state.view;
    var imageX = (cx - view.x) / view.scale;
    var imageY = (cy - view.y) / view.scale;
    var scale = view.scale * factor;
    state.autoFit = false;
    setView({ scale: scale, x: cx - imageX * scale, y: cy - imageY * scale });
  }

  function ensureVisible(colorHex) {
    if (!state.map || !state.analysis) return;
    var index = state.analysis.hexToIndex.get(colorHex);
    if (index === undefined) return;
    var info = state.analysis.colors[index];
    if (!info || !info.bbox) return;

    var rect = el.viewport.getBoundingClientRect();
    var view = state.view;
    var x0 = view.x + info.bbox.x * view.scale;
    var y0 = view.y + info.bbox.y * view.scale;
    var x1 = x0 + info.bbox.width * view.scale;
    var y1 = y0 + info.bbox.height * view.scale;
    var visible = x1 >= 0 && y1 >= 0 && x0 <= rect.width && y0 <= rect.height;
    if (visible) return;

    state.autoFit = false;
    setView({
      scale: view.scale,
      x: rect.width / 2 - (info.bbox.x + info.bbox.width / 2) * view.scale,
      y: rect.height / 2 - (info.bbox.y + info.bbox.height / 2) * view.scale
    });
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  function runAnalyzer(payload) {
    var worker = null;
    try {
      worker = window.MapAnalyzer.createAnalysisWorker();
    } catch (err) {
      worker = null;
    }

    if (!worker) {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(window.MapAnalyzer.analyzePixels(payload)); }, 20);
      });
    }

    return new Promise(function (resolve, reject) {
      var finished = false;
      function cleanup() {
        if (finished) return;
        finished = true;
        try { worker.terminate(); } catch (err) { /* ignore */ }
        try { URL.revokeObjectURL(worker.__objectUrl); } catch (err) { /* ignore */ }
      }
      worker.onmessage = function (event) {
        var data = event.data || {};
        if (data.ok) { cleanup(); resolve(data.result); }
        else { cleanup(); reject(new Error(data.error || 'Map analysis failed.')); }
      };
      worker.onerror = function (event) {
        cleanup();
        reject(new Error((event && event.message) || 'Map analysis failed.'));
      };
      worker.postMessage(payload, [payload.data.buffer]);
    });
  }

  function analyzeMap(options) {
    options = options || {};
    if (!state.map) {
      toast('Upload a map first.', 'error');
      return Promise.resolve(null);
    }
    if (state.busy) return Promise.resolve(null);

    state.busy = true;
    clearToasts();
    toggleBusy(true, 'Analyzing map…');

    var map = state.map;
    return nextFrame().then(function () {
      var ignoreColors = [];
      state.settings.ignoreColors.forEach(function (hex) {
        var value = window.MapAnalyzer.hexToInt(hex);
        if (value !== null) ignoreColors.push(value);
      });

      var payload = {
        width: map.width,
        height: map.height,
        data: new Uint8ClampedArray(map.imageData.data),
        alphaThreshold: ALPHA_THRESHOLD,
        tolerance: state.settings.tolerance,
        minRegionPixels: state.settings.minRegionPixels,
        ignoreColors: ignoreColors,
        snapColors: map.kind === 'svg' ? map.snapColors : null
      };

      return runAnalyzer(payload).then(function (result) {
        result.hexToIndex = new Map();
        result.colors.forEach(function (info, index) { result.hexToIndex.set(info.hex, index); });
        state.analysis = result;
        var summary = applyAnalysis(result, options);
        if (state.selected && !state.records.has(state.selected)) closePopup();
        renderAll();
        refreshMapLayers();
        notifyCountries();
        if (options.showSummary !== false) showSummary(summary);
        return summary;
      });
    }).catch(function (err) {
      console.error(err);
      toast('Map analysis failed: ' + ((err && err.message) || err), 'error');
      return null;
    }).then(function (value) {
      state.busy = false;
      toggleBusy(false);
      return value;
    });
  }

  function applyAnalysis(result, options) {
    var detected = new Set();
    var matched = 0;
    var created = 0;

    // Every detected color gets a record — no clicking required, unless the
    // user explicitly unregistered that color.
    result.colors.forEach(function (info) {
      detected.add(info.hex);
      if (state.records.has(info.hex)) {
        matched++;
        return;
      }
      if (state.deletedColors.has(info.hex)) return;
      state.records.set(info.hex, {
        id: null,
        name: '',
        type: 'land',
        neighbors: [],
        extra: {},
        pending: true
      });
      created++;
    });

    var maxExistingId = 0;
    state.records.forEach(function (record) {
      if (!record.pending && Number.isInteger(record.id) && record.id >= maxExistingId) {
        maxExistingId = record.id;
      }
    });
    if (state.nextId <= maxExistingId) state.nextId = maxExistingId + 1;

    state.records.forEach(function (record) {
      if (record.pending) {
        record.id = state.nextId++;
        delete record.pending;
      }
    });

    // Neighbors are recalculated for every detected color.
    result.colors.forEach(function (info) {
      var record = state.records.get(info.hex);
      if (!record) return;
      var ids = new Set();
      info.neighbors.forEach(function (neighborIndex) {
        var neighborInfo = result.colors[neighborIndex];
        if (!neighborInfo) return;
        var neighbor = state.records.get(neighborInfo.hex);
        if (!neighbor) return;
        if (neighbor.id === record.id) return;
        ids.add(neighbor.id);
      });
      record.neighbors = Array.from(ids).sort(function (a, b) { return a - b; });
    });

    var ignored = new Set(state.settings.ignoreColors);
    var missing = [];
    state.records.forEach(function (record, color) {
      if (!detected.has(color) && !ignored.has(color)) missing.push(color);
    });

    var disconnected = result.colors.filter(function (info) { return info.components > 1; });
    var warnings = [];

    if (!result.colors.length) {
      warnings.push({ kind: 'warn', text: 'No province colors were detected in this map. Check the image, the ignore list, or the minimum region size.' });
    }
    if (missing.length) {
      warnings.push({
        kind: 'warn',
        text: plural(missing.length, 'JSON record was', 'JSON records were') + ' not found in this map and preserved: ' +
          truncateList(missing.map(function (hex) {
            var record = state.records.get(hex);
            return record && isLabeled(record) ? record.name + ' (' + hex + ')' : hex;
          }), 12)
      });
    }
    if (disconnected.length) {
      warnings.push({
        kind: 'warn',
        text: plural(disconnected.length, 'color occurs', 'colors occur') + ' in multiple disconnected regions: ' +
          truncateList(disconnected.map(function (info) { return info.hex + ' (' + info.components + ' regions)'; }), 12) +
          '. They share one record and their neighbors are combined.'
      });
    }
    if (result.stats.tolerance > 0 && result.stats.mergedColors) {
      warnings.push({
        kind: 'info',
        text: 'Color tolerance ' + result.stats.tolerance + ' merged ' + plural(result.stats.mergedColors, 'similar color') +
          ' into dominant colors (' + formatNumber(result.stats.mergedPixels) + ' px affected).'
      });
    }
    if (result.stats.minRegionPixels > 1 && result.stats.smallColors) {
      warnings.push({
        kind: 'info',
        text: plural(result.stats.smallColors, 'color was', 'colors were') + ' ignored for being smaller than ' +
          result.stats.minRegionPixels + ' px (' + formatNumber(result.stats.smallColorPixels) + ' px total).'
      });
    }
    if (result.stats.tinyColors) {
      warnings.push({
        kind: 'info',
        text: plural(result.stats.tinyColors, 'color covers', 'colors cover') + ' fewer than 16 px (' +
          formatNumber(result.stats.tinyPixels) + ' px total) — likely anti-aliased edges. Raise “Minimum region size” in Options to exclude them.'
      });
    }
    if (result.stats.snapped) {
      warnings.push({
        kind: 'info',
        text: 'SVG mode: rasterized edge colors were snapped to the ' + plural(result.colors.length, 'fill color') + ' defined in the file.'
      });
    }

    var labeled = 0;
    state.records.forEach(function (record) { if (isLabeled(record)) labeled++; });

    var summary = {
      reason: options.reason || 'manual',
      detected: result.colors.length,
      records: state.records.size,
      matched: matched,
      created: created,
      labeled: labeled,
      unlabeled: state.records.size - labeled,
      neighbors: countNeighborPairs(),
      disconnected: disconnected.length,
      missing: missing,
      warnings: warnings,
      stats: result.stats
    };

    state.warnings = warnings;
    state.lastSummary = summary;
    return summary;
  }

  function countNeighborPairs() {
    var byId = recordsById();
    var pairs = new Set();
    state.records.forEach(function (record) {
      record.neighbors.forEach(function (id) {
        if (id === record.id || !byId.has(id)) return;
        pairs.add(Math.min(record.id, id) + ':' + Math.max(record.id, id));
      });
    });
    return pairs.size;
  }

  // ---------------------------------------------------------------------------
  // Selection & highlight
  // ---------------------------------------------------------------------------

  function rootCountryTab() {
    return window.CountryTab || null;
  }

  /** Highlights a province in white; the country layer stays underneath. */
  function setHighlight(colorHex) {
    var map = state.map;
    if (!map) return;
    state.highlightHex = colorHex;

    if (map.kind === 'svg') {
      applySvgAppearance();
      return;
    }

    var analysis = state.analysis;
    var repIndex = analysis ? analysis.hexToIndex.get(colorHex) : undefined;
    if (repIndex === undefined) {
      map.overlayCtx.clearRect(0, 0, map.width, map.height);
      return;
    }

    var width = analysis.width;
    var height = analysis.height;
    if (!state.overlayImageData ||
        state.overlayImageData.width !== width ||
        state.overlayImageData.height !== height) {
      state.overlayImageData = map.overlayCtx.createImageData(width, height);
    }
    var image = state.overlayImageData;
    var pixels = image.data;
    pixels.fill(0);
    var labels = analysis.labels;
    var compColor = analysis.compColor;
    var total = width * height;
    for (var i = 0; i < total; i++) {
      var label = labels[i];
      if (label && compColor[label] === repIndex) {
        var offset = i * 4;
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = 255;
      }
    }
    map.overlayCtx.putImageData(image, 0, 0);
  }

  function clearHighlight() {
    var map = state.map;
    state.highlightHex = null;
    if (!map) return;
    if (map.kind === 'raster') {
      if (state.overlayImageData) {
        map.overlayCtx.clearRect(0, 0, map.width, map.height);
      }
      return;
    }
    applySvgAppearance();
  }

  /**
   * SVG fills are derived from state (original fill -> country color -> white
   * highlight), so switching tabs or views never leaves stale colors behind.
   */
  function applySvgAppearance() {
    var map = state.map;
    if (!map || map.kind !== 'svg') return;
    var tab = rootCountryTab();
    var countryFills = state.tab === 'countries' && tab ? tab.getProvinceHexColorMap() : null;
    if (!map.strokeRestore) map.strokeRestore = new Map();

    map.fillByEl.forEach(function (originalHex, node) {
      var fill = originalHex;
      if (countryFills && countryFills.has(originalHex)) fill = countryFills.get(originalHex);
      if (state.highlightHex === originalHex) fill = 'ffffff';
      node.style.fill = '#' + fill;

      if (countryFills) {
        // Outline every province so borders survive when neighbours share a country color.
        if (!map.strokeRestore.has(node)) {
          map.strokeRestore.set(node, {
            stroke: node.style.stroke,
            width: node.style.strokeWidth,
            effect: node.style.vectorEffect
          });
        }
        node.style.stroke = 'rgba(10, 13, 18, 0.55)';
        node.style.strokeWidth = '0.6';
        node.style.vectorEffect = 'non-scaling-stroke';
      } else if (map.strokeRestore.has(node)) {
        var previous = map.strokeRestore.get(node);
        node.style.stroke = previous.stroke;
        node.style.strokeWidth = previous.width;
        node.style.vectorEffect = previous.effect;
        map.strokeRestore.delete(node);
      }
    });
  }

  /** Draws the country-colored province layer (ownership/control views). */
  function renderCountryLayer() {
    var map = state.map;
    if (!map || map.kind !== 'raster' || !map.countryCtx) return;

    var ctx = map.countryCtx;
    ctx.clearRect(0, 0, map.width, map.height);

    var tab = rootCountryTab();
    var analysis = state.analysis;
    var fills = state.tab === 'countries' && tab ? tab.getProvinceHexColorMap() : null;
    if (!analysis || !fills || !fills.size) return;

    var repFills = new Map();
    analysis.colors.forEach(function (info, index) {
      var countryHex = fills.get(info.hex);
      if (!countryHex) return;
      var value = window.MapAnalyzer.hexToInt(countryHex);
      if (value !== null) repFills.set(index, value);
    });
    if (!repFills.size) return;

    var width = analysis.width;
    var height = analysis.height;
    if (!state.countryImageData ||
        state.countryImageData.width !== width ||
        state.countryImageData.height !== height) {
      state.countryImageData = ctx.createImageData(width, height);
    }

    var image = state.countryImageData;
    var pixels = image.data;
    pixels.fill(0);
    var labels = analysis.labels;
    var compColor = analysis.compColor;

    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (!label) continue;
      var repIndex = compColor[label];
      var countryColor = repFills.get(repIndex);
      if (countryColor === undefined) continue;

      // Blend with the province color so neighbouring provinces of the same
      // country remain distinguishable, then outlines are darkened below.
      var provinceColor = analysis.colors[repIndex].color;
      var offset = i * 4;
      pixels[offset] = Math.round(((countryColor >> 16) & 255) * 0.86 + ((provinceColor >> 16) & 255) * 0.14);
      pixels[offset + 1] = Math.round(((countryColor >> 8) & 255) * 0.86 + ((provinceColor >> 8) & 255) * 0.14);
      pixels[offset + 2] = Math.round((countryColor & 255) * 0.86 + (provinceColor & 255) * 0.14);
      pixels[offset + 3] = 255;
    }

    var boundary = analysis.boundaryMask || (analysis.boundaryMask = buildBoundaryMask(analysis));
    for (var b = 0; b < boundary.length; b++) {
      if (!boundary[b]) continue;
      var p = b * 4;
      if (!pixels[p + 3]) continue;
      pixels[p] = Math.round(pixels[p] * 0.42);
      pixels[p + 1] = Math.round(pixels[p + 1] * 0.42);
      pixels[p + 2] = Math.round(pixels[p + 2] * 0.42);
    }

    ctx.putImageData(image, 0, 0);
  }

  function buildBoundaryMask(analysis) {
    var width = analysis.width;
    var height = analysis.height;
    var labels = analysis.labels;
    var mask = new Uint8Array(width * height);
    for (var y = 0; y < height; y++) {
      var row = y * width;
      for (var x = 0; x < width; x++) {
        var i = row + x;
        var label = labels[i];
        if (x + 1 < width && labels[i + 1] !== label) mask[i] = 1;
        if (y + 1 < height && labels[i + width] !== label) mask[i] = 1;
      }
    }
    return mask;
  }

  function refreshMapLayers() {
    renderCountryLayer();
    applySvgAppearance();
  }

  function selectProvince(colorHex) {
    var record = state.records.get(colorHex);
    if (!record) {
      var info = null;
      if (state.analysis) {
        var index = state.analysis.hexToIndex.get(colorHex);
        if (index !== undefined) info = state.analysis.colors[index];
      }
      if (!info) {
        toast('#' + colorHex + ' has no province record yet.', 'warn');
        return;
      }
    }
    if (state.selected === colorHex && !el.popup.classList.contains('hidden')) return;

    clearHighlight();
    state.selected = colorHex;
    setHighlight(colorHex);
    renderListSelection();
    openPopup(colorHex);
    ensureVisible(colorHex);
  }

  function closePopup() {
    el.popup.classList.add('hidden');
    state.selected = null;
    state.popupHadSaved = false;
    clearHighlight();
    renderListSelection();
  }

  function openPopup(colorHex) {
    var record = state.records.get(colorHex);
    var info = null;
    if (state.analysis) {
      var index = state.analysis.hexToIndex.get(colorHex);
      if (index !== undefined) info = state.analysis.colors[index];
    }
    if (!record && !info) return;

    el.popupSwatch.style.background = '#' + colorHex;
    el.popupColor.value = colorHex;
    el.popupName.value = record ? (record.name || '') : '';
    el.popupType.value = record && record.type === 'sea' ? 'sea' : 'land';

    var meta = [record ? 'id ' + record.id : 'not registered'];
    if (info) meta.push(plural(info.components, 'region'));
    if (record) {
      meta.push(plural(record.neighbors.length, 'neighbor'));
      el.popupNeighbors.textContent = neighborSummary(record);
    } else {
      var detectedNeighbors = neighborIdsFor(colorHex).length;
      el.popupNeighbors.textContent = detectedNeighbors
        ? 'Not registered — the map shows borders with ' + plural(detectedNeighbors, 'province') +
          '. Enter a name to register it and recalculate neighbors.'
        : 'Not registered — enter a name to register this province.';
    }
    el.popupSub.textContent = meta.join(' · ');

    var disconnected = !!info && info.components > 1;
    el.popupDisconnected.textContent = disconnected
      ? 'This color appears in ' + info.components + ' disconnected regions. All of them are highlighted and share this record.'
      : '';
    el.popupDisconnected.classList.toggle('hidden', !disconnected);

    state.popupHadSaved = !!record && isLabeled(record);
    el.popupWarning.textContent = record
      ? 'This province already has saved information.'
      : 'This province is not registered. Add a name and press Done to register it.';
    el.popupWarning.classList.toggle('hidden', !!record && !state.popupHadSaved);

    el.popupError.textContent = '';
    el.popupError.classList.add('hidden');

    el.popup.classList.remove('hidden');
    el.popupName.focus();
    if (el.popupName.value) el.popupName.setSelectionRange(el.popupName.value.length, el.popupName.value.length);
  }

  function neighborSummary(record) {
    if (!record.neighbors.length) return 'Neighbors: none';
    var byId = recordsById();
    var names = record.neighbors.slice(0, 6).map(function (id) {
      var other = byId.get(id);
      if (!other) return '#' + id;
      return (isLabeled(other) ? other.name : 'unnamed') + ' (#' + id + ')';
    });
    var text = 'Neighbors (' + record.neighbors.length + '): ' + names.join(', ');
    if (record.neighbors.length > 6) text += ', +' + (record.neighbors.length - 6) + ' more';
    return text;
  }

  /**
   * Neighbor record IDs for a map color, based on the cached analysis.
   * Unregistered colors are skipped so deleted IDs never come back.
   */
  function neighborIdsFor(colorHex) {
    var analysis = state.analysis;
    if (!analysis) return [];
    var index = analysis.hexToIndex.get(colorHex);
    if (index === undefined) return [];

    var ids = new Set();
    analysis.colors[index].neighbors.forEach(function (neighborIndex) {
      var other = analysis.colors[neighborIndex];
      if (!other || state.deletedColors.has(other.hex)) return;
      var otherRecord = state.records.get(other.hex);
      if (!otherRecord) return;
      ids.add(otherRecord.id);
    });
    return Array.from(ids).sort(function (a, b) { return a - b; });
  }

  function sortIds(ids) {
    return ids.sort(function (a, b) { return a - b; });
  }

  /** Registers a color removed earlier (or newly detected) with a fresh ID. */
  function registerProvince(colorHex, name, type) {
    state.deletedColors.delete(colorHex);
    var record = {
      id: state.nextId++,
      name: name,
      type: type,
      neighbors: [],
      extra: {}
    };
    state.records.set(colorHex, record);

    record.neighbors = neighborIdsFor(colorHex);
    var byId = recordsById();
    record.neighbors.forEach(function (neighborId) {
      var other = byId.get(neighborId);
      if (!other || neighborId === record.id) return;
      if (other.neighbors.indexOf(record.id) === -1) {
        other.neighbors = sortIds(other.neighbors.concat(record.id));
      }
    });
    return record;
  }

  function showPopupError(message) {
    el.popupError.textContent = message;
    el.popupError.classList.remove('hidden');
  }

  function commitPopup() {
    var colorHex = state.selected;
    if (!colorHex) { closePopup(); return; }

    var name = el.popupName.value.trim();
    if (!name) {
      showPopupError('Province name cannot be empty.');
      el.popupName.focus();
      return;
    }
    var type = el.popupType.value === 'sea' ? 'sea' : 'land';

    var record = state.records.get(colorHex);
    if (!record) {
      record = registerProvince(colorHex, name, type);
      renderAll();
      notifyCountries();
      closePopup();
      toast('Registered “' + name + '” with new id ' + record.id + '.', 'success');
      return;
    }

    record.name = name;
    record.type = type;

    renderList();
    renderStatus();
    updateChips();
    notifyCountries();
    closePopup();
    toast('Saved “' + name + '” (id ' + record.id + ').', 'success');
  }

  // ---------------------------------------------------------------------------
  // Deleting provinces
  // ---------------------------------------------------------------------------

  function requestDelete(colorHex) {
    var record = state.records.get(colorHex);
    if (!record) return;

    state.pendingDelete = colorHex;
    var detail = (isLabeled(record) ? record.name : 'Unnamed') + ' · ' + colorHex + ' · id ' + record.id;
    if (record.neighbors.length) {
      detail += ' · ' + plural(record.neighbors.length, 'neighbor') + ' will be unlinked';
    }
    el.deleteDetail.textContent = detail;
    el.deleteConfirm.disabled = false;
    openModal(el.deleteModal);
  }

  function cancelDelete() {
    state.pendingDelete = null;
    closeModal(el.deleteModal);
  }

  function confirmDelete() {
    var colorHex = state.pendingDelete;
    state.pendingDelete = null;
    closeModal(el.deleteModal);
    if (colorHex) deleteProvince(colorHex);
  }

  /**
   * Unregisters a province: drops its record, removes its ID from every other
   * neighbor list, and keeps the map image untouched so the color can be added
   * back later with a new ID.
   */
  function deleteProvince(colorHex) {
    var record = state.records.get(colorHex);
    if (!record) return null;

    var removedId = record.id;
    var removedName = isLabeled(record) ? record.name : colorHex;

    state.records.delete(colorHex);
    state.deletedColors.add(colorHex);

    state.records.forEach(function (other) {
      if (!other.neighbors.length) return;
      var filtered = other.neighbors.filter(function (id) { return id !== removedId; });
      if (filtered.length !== other.neighbors.length) other.neighbors = filtered;
    });

    if (state.selected === colorHex) closePopup();

    renderAll();
    notifyCountries();
    toast('Deleted “' + removedName + '” (id ' + removedId + ').', 'info');
    return removedId;
  }

  // ---------------------------------------------------------------------------
  // Map interaction
  // ---------------------------------------------------------------------------

  function findSvgFillElement(node) {
    var root = state.map && state.map.svg;
    var current = node;
    while (current && current !== root) {
      if (state.map.fillByEl.has(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function handleMapClick(clientX, clientY, target) {
    if (!state.map) return;
    if (!state.analysis) {
      toast('Analyze the map before selecting provinces.', 'info');
      return;
    }

    var colorHex = null;

    if (state.map.kind === 'raster') {
      var rect = state.map.canvas.getBoundingClientRect();
      if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) {
        toast('No province at this location.', 'warn');
        return;
      }
      var x = clamp(Math.floor((clientX - rect.left) / rect.width * state.map.width), 0, state.map.width - 1);
      var y = clamp(Math.floor((clientY - rect.top) / rect.height * state.map.height), 0, state.map.height - 1);
      var label = state.analysis.labels[y * state.map.width + x];
      if (!label) {
        toast('No province at this location (transparent or ignored pixel).', 'warn');
        return;
      }
      var info = state.analysis.colors[state.analysis.compColor[label]];
      if (!info) {
        toast('No province at this location.', 'warn');
        return;
      }
      colorHex = info.hex;
    } else {
      var node = findSvgFillElement(target);
      if (!node) {
        toast('No province at this location.', 'warn');
        return;
      }
      colorHex = state.map.fillByEl.get(node) || null;
      if (!colorHex) {
        toast('No province at this location.', 'warn');
        return;
      }
    }

    if (state.tab === 'countries' && rootCountryTab()) {
      rootCountryTab().handleProvinceClick(colorHex);
      return;
    }
    selectProvince(colorHex);
  }

  function handlePointerDown(event) {
    if (!state.map || event.button !== 0) return;
    if (event.target.closest('.popup, .country-panel, .country-view-modes, .zoom-controls, .busy, .empty-state')) return;
    state.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: state.view.x,
      viewY: state.view.y,
      moved: false,
      target: event.target
    };
    el.viewport.classList.add('is-grabbing');
    try { el.viewport.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
  }

  function handlePointerMove(event) {
    var pointer = state.pointer;
    if (!pointer || event.pointerId !== pointer.id) return;
    var dx = event.clientX - pointer.startX;
    var dy = event.clientY - pointer.startY;
    if (!pointer.moved && Math.sqrt(dx * dx + dy * dy) > 3) {
      pointer.moved = true;
      state.autoFit = false;
    }
    if (pointer.moved) {
      setView({ scale: state.view.scale, x: pointer.viewX + dx, y: pointer.viewY + dy });
    }
  }

  function handlePointerUp(event) {
    var pointer = state.pointer;
    if (!pointer || event.pointerId !== pointer.id) return;
    state.pointer = null;
    el.viewport.classList.remove('is-grabbing');
    try { el.viewport.releasePointerCapture(event.pointerId); } catch (err) { /* ignore */ }
    if (!pointer.moved) handleMapClick(event.clientX, event.clientY, pointer.target);
  }

  // ---------------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------------

  function renderList() {
    var list = el.provinceList;
    var scrollTop = list.scrollTop;
    list.textContent = '';

    if (!state.records.size) {
      var hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = state.map
        ? 'Import a JSON file to match existing records, or run Analyze Map to build records from the map.'
        : 'Upload a map and import a JSON file to generate province records automatically.';
      list.appendChild(hint);
      return;
    }

    var detected = state.analysis ? new Set(state.analysis.colors.map(function (info) { return info.hex; })) : null;
    var query = state.search.trim().toLowerCase();
    var rows = [];

    state.records.forEach(function (record, color) {
      var labeled = isLabeled(record);
      if (state.filter === 'labeled' && !labeled) return;
      if (state.filter === 'unlabeled' && labeled) return;
      if (state.filter === 'missing' && (!detected || detected.has(color))) return;
      if (query) {
        var haystack = (record.name || '') + ' ' + color + ' #' + color + ' id ' + record.id;
        if (haystack.toLowerCase().indexOf(query) === -1) return;
      }
      rows.push({ color: color, record: record, inMap: detected ? detected.has(color) : true });
    });

    rows.sort(function (a, b) { return a.record.id - b.record.id; });

    if (!rows.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = state.filter === 'missing' && !state.analysis
        ? 'Analyze the map to see which records are missing from it.'
        : 'No provinces match this filter.';
      list.appendChild(empty);
      return;
    }

    var fragment = document.createDocumentFragment();
    rows.slice(0, ROW_LIMIT).forEach(function (row) { fragment.appendChild(buildRow(row)); });
    list.appendChild(fragment);

    if (rows.length > ROW_LIMIT) {
      var more = document.createElement('p');
      more.className = 'empty-hint';
      more.textContent = 'Showing ' + ROW_LIMIT + ' of ' + rows.length + ' provinces — narrow the search to see the rest.';
      list.appendChild(more);
    }
    list.scrollTop = scrollTop;
  }

  function buildRow(row) {
    var record = row.record;
    var rowEl = document.createElement('div');
    rowEl.className = 'province-row';
    rowEl.dataset.color = row.color;
    rowEl.setAttribute('role', 'button');
    rowEl.tabIndex = 0;
    rowEl.setAttribute('aria-label', (isLabeled(record) ? record.name : 'Unnamed') + ', color ' + row.color + ', id ' + record.id);
    if (row.color === state.selected) rowEl.classList.add('is-active');

    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = '#' + row.color;

    var main = document.createElement('span');
    main.className = 'row-main';
    var name = document.createElement('span');
    name.className = 'row-name' + (isLabeled(record) ? '' : ' is-empty');
    name.textContent = isLabeled(record) ? record.name : 'Unnamed';
    var sub = document.createElement('span');
    sub.className = 'row-sub';
    sub.textContent = row.color + ' · id ' + record.id;
    main.appendChild(name);
    main.appendChild(sub);

    var badges = document.createElement('span');
    badges.className = 'row-badges';
    if (record.type === 'sea') {
      var sea = document.createElement('span');
      sea.className = 'pill pill-sea';
      sea.textContent = 'sea';
      badges.appendChild(sea);
    }
    if (record.neighbors.length) {
      var count = document.createElement('span');
      count.className = 'row-count';
      count.textContent = '↔' + record.neighbors.length;
      count.title = plural(record.neighbors.length, 'neighbor');
      badges.appendChild(count);
    }
    if (!row.inMap) {
      var warn = document.createElement('span');
      warn.className = 'pill pill-warn';
      warn.textContent = 'not in map';
      warn.title = 'This record was imported but its color was not detected in the current map.';
      badges.appendChild(warn);
    }

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-delete';
    remove.dataset.color = row.color;
    remove.title = 'Delete province';
    remove.setAttribute('aria-label', 'Delete ' + (isLabeled(record) ? record.name : 'unnamed province'));
    remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="M3 4.5h10M6.5 4.5V3.2a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.3"/>' +
      '<path d="M4.4 4.5l.55 8a1 1 0 0 0 1 .95h4.1a1 1 0 0 0 1-.95l.55-8"/>' +
      '<path d="M6.8 7v4M9.2 7v4"/></svg>';

    rowEl.appendChild(swatch);
    rowEl.appendChild(main);
    rowEl.appendChild(badges);
    rowEl.appendChild(remove);
    return rowEl;
  }

  function renderListSelection() {
    var rows = el.provinceList.querySelectorAll('.province-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('is-active', rows[i].dataset.color === state.selected);
    }
  }

  function renderStatus() {
    var detected = state.analysis ? state.analysis.colors.length : 0;
    var labeled = 0;
    state.records.forEach(function (record) { if (isLabeled(record)) labeled++; });
    var total = state.records.size;

    el.statDetected.textContent = formatNumber(detected);
    el.statRecords.textContent = formatNumber(total);
    el.statLabeled.textContent = formatNumber(labeled);
    el.statUnlabeled.textContent = formatNumber(total - labeled);
    el.statNeighbors.textContent = formatNumber(countNeighborPairs());

    var issues = state.warnings.length;
    el.statWarnings.classList.toggle('hidden', !issues);
    el.statWarnings.textContent = issues + (issues === 1 ? ' warning' : ' warnings');
  }

  function updateChips() {
    var map = state.map;
    el.mapChip.textContent = map ? map.name + ' · ' + map.width + '×' + map.height : 'No map';
    el.mapChip.title = map ? map.name + ' (' + map.kind.toUpperCase() + ')' : 'No map loaded';
    el.mapChip.classList.toggle('file-chip-empty', !map);

    var total = state.records.size;
    el.jsonChip.textContent = total
      ? (state.jsonName ? state.jsonName + ' · ' : '') + plural(total, 'record')
      : 'No JSON';
    el.jsonChip.title = total ? formatNumber(total) + ' province records loaded' : 'No JSON loaded';
    el.jsonChip.classList.toggle('file-chip-empty', !total);
  }

  function renderAll() {
    updateChips();
    renderStatus();
    renderList();
  }

  // ---------------------------------------------------------------------------
  // JSON import / export
  // ---------------------------------------------------------------------------

  function parseProvinceJson(text, fileName) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Invalid JSON in ' + fileName + ': ' + err.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid JSON structure: expected an object keyed by HEX province colors.');
    }

    var records = new Map();
    var warnings = [];

    Object.keys(data).forEach(function (rawKey) {
      var raw = data[rawKey];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push('Record "' + rawKey + '" is not an object and was skipped.');
        return;
      }

      var color = String(rawKey).trim().toLowerCase().replace(/^#/, '');
      if (!HEX_RE.test(color)) {
        warnings.push('Key "' + rawKey + '" is not a valid 6-digit HEX color. It is preserved but cannot match map colors.');
      }
      if (records.has(color)) {
        warnings.push('Duplicate color key "' + color + '" ignored (the first record was kept).');
        return;
      }

      var record = { id: null, name: '', type: 'land', neighbors: [], extra: {} };

      if (typeof raw.name === 'string') {
        record.name = raw.name;
      } else if (raw.name != null) {
        record.name = String(raw.name);
        warnings.push('Record "' + rawKey + '": name is not a string and was converted.');
      } else {
        warnings.push('Record "' + rawKey + '": missing name — set to an empty name.');
      }

      var type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
      if (type === 'land' || type === 'sea') {
        record.type = type;
      } else {
        if (raw.type != null) warnings.push('Record "' + rawKey + '": invalid type "' + raw.type + '" — set to "land".');
        record.type = 'land';
      }

      if (Number.isInteger(raw.id) && raw.id >= 0) {
        record.id = raw.id;
      } else if (raw.id != null) {
        warnings.push('Record "' + rawKey + '": invalid id "' + raw.id + '" — a new ID will be assigned.');
      } else {
        warnings.push('Record "' + rawKey + '": missing id — a new ID will be assigned.');
      }

      if (Array.isArray(raw.neighbors)) {
        var seen = new Set();
        var neighbors = [];
        raw.neighbors.forEach(function (value) {
          var number = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
          if (!Number.isInteger(number)) {
            warnings.push('Record "' + rawKey + '": neighbor "' + value + '" is not an integer ID — dropped.');
            return;
          }
          if (!seen.has(number)) { seen.add(number); neighbors.push(number); }
        });
        neighbors.sort(function (a, b) { return a - b; });
        record.neighbors = neighbors;
      } else if (raw.neighbors != null) {
        warnings.push('Record "' + rawKey + '": neighbors is not an array — reset to [].');
      }

      Object.keys(raw).forEach(function (key) {
        if (key === 'id' || key === 'name' || key === 'type' || key === 'neighbors') return;
        record.extra[key] = raw[key];
      });

      records.set(color, record);
    });

    var maxId = 0;
    var usedIds = new Set();
    records.forEach(function (record) {
      if (record.id === null) return;
      if (usedIds.has(record.id)) {
        warnings.push('Duplicate ID ' + record.id + ' — a new ID will be assigned.');
        record.id = null;
        return;
      }
      usedIds.add(record.id);
      if (record.id > maxId) maxId = record.id;
    });

    var nextId = maxId + 1;
    records.forEach(function (record) {
      if (record.id === null) record.id = nextId++;
    });

    var allIds = new Set();
    records.forEach(function (record) { allIds.add(record.id); });
    records.forEach(function (record) {
      var cleaned = [];
      record.neighbors.forEach(function (neighborId) {
        if (neighborId === record.id) {
          warnings.push('Record id ' + record.id + ': removed a self-reference from neighbors.');
          return;
        }
        if (!allIds.has(neighborId)) {
          warnings.push('Record id ' + record.id + ': neighbor ' + neighborId + ' does not exist — dropped.');
          return;
        }
        cleaned.push(neighborId);
      });
      cleaned.sort(function (a, b) { return a - b; });
      record.neighbors = cleaned;
    });

    if (!records.size) warnings.push('The JSON file contains no province records.');

    return { records: records, nextId: nextId, warnings: warnings };
  }

  function handleJsonFile(file) {
    if (state.busy) { toast('Please wait for the current operation to finish.', 'warn'); return; }
    toggleBusy(true, 'Importing JSON…');

    file.text().then(function (text) {
      var parsed = parseProvinceJson(text, file.name);

      state.records = parsed.records;
      state.nextId = parsed.nextId;
      state.jsonName = file.name;
      state.analysis = null;
      state.warnings = [];
      state.lastSummary = null;
      state.overlayImageData = null;
      state.deletedColors = new Set();
      closePopup();

      if (!state.ignoreTouched) {
        var unknownColor = null;
        state.records.forEach(function (record, color) {
          if (unknownColor === null && record.id === 0) unknownColor = color;
        });
        if (unknownColor !== null) {
          state.settings.ignoreColors = [unknownColor];
          el.optIgnore.value = unknownColor;
        }
      }

      renderAll();
      refreshMapLayers();
      notifyCountries();

      if (parsed.warnings.length) {
        showNotice('JSON imported with warnings', [
          plural(state.records.size, 'record') + ' loaded from ' + file.name + '.'
        ], parsed.warnings.map(function (text) { return { kind: 'warn', text: text }; }));
      } else {
        toast('Imported ' + plural(state.records.size, 'province record') + ' from ' + file.name + '.', 'success');
      }

      if (state.map) {
        return analyzeMap({ reason: 'import' });
      }
      toast('JSON imported. Upload a map to detect colors and neighbors.', 'info');
      return null;
    }).catch(function (err) {
      console.warn('[Province Map Editor] JSON import failed:', err);
      toast((err && err.message) || 'The JSON file could not be imported.', 'error');
    }).then(function () {
      toggleBusy(false);
    });
  }

  function buildExportObject() {
    var output = {};
    var entries = Array.from(state.records.entries()).sort(function (a, b) {
      if (a[1].id !== b[1].id) return a[1].id - b[1].id;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    entries.forEach(function (entry) {
      var color = entry[0];
      var record = entry[1];
      var value = {
        id: record.id,
        name: record.name,
        type: record.type,
        neighbors: record.neighbors.slice()
      };
      Object.keys(record.extra).forEach(function (key) {
        if (!(key in value)) value[key] = record.extra[key];
      });
      output[color] = value;
    });
    return output;
  }

  /**
   * Serializes the export model with 4-space indentation, except `neighbors`
   * arrays which stay inline (`[1, 2, 3]`).
   */
  function serializeProvinceJson(object) {
    var keys = Object.keys(object);
    if (!keys.length) return '{}';

    var recordIndent = EXPORT_INDENT;
    var propertyIndent = EXPORT_INDENT + EXPORT_INDENT;

    var blocks = keys.map(function (color) {
      var record = object[color];
      var lines = Object.keys(record).map(function (key) {
        return propertyIndent + JSON.stringify(key) + ': ' + formatExportValue(key, record[key], propertyIndent);
      });
      return recordIndent + JSON.stringify(color) + ': {\n' + lines.join(',\n') + '\n' + recordIndent + '}';
    });

    return '{\n' + blocks.join(',\n') + '\n}';
  }

  function formatExportValue(key, value, indent) {
    var isNeighborArray = key === 'neighbors' && Array.isArray(value) &&
      value.every(function (item) { return Number.isInteger(item); });
    if (isNeighborArray) return '[' + value.join(', ') + ']';

    // Extra imported properties keep their own formatting, re-indented.
    return JSON.stringify(value, null, EXPORT_INDENT).replace(/\n/g, '\n' + indent);
  }

  function validateForExport() {
    var problems = [];
    var unlabeled = 0;
    var ids = new Map();
    state.records.forEach(function (record, color) {
      if (!isLabeled(record)) unlabeled++;
      if (ids.has(record.id)) problems.push('Duplicate ID ' + record.id + ' (' + ids.get(record.id) + ' and ' + color + ').');
      else ids.set(record.id, color);
    });
    if (unlabeled) problems.push(plural(unlabeled, 'province has', 'provinces have') + ' no name yet.');
    return problems;
  }

  function exportJson() {
    if (!state.records.size) {
      toast('Nothing to export yet — import a JSON file or analyze a map first.', 'error');
      return;
    }
    var problems = validateForExport();
    var text = serializeProvinceJson(buildExportObject()) + '\n';
    download(text, 'provinces.json');
    if (problems.length) {
      toast('Exported ' + plural(state.records.size, 'record') + ' with a warning: ' + problems[0], 'warn');
    } else {
      toast('Exported ' + plural(state.records.size, 'province record') + '.', 'success');
    }
  }

  function download(text, fileName) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Modals, toasts, busy state
  // ---------------------------------------------------------------------------

  function openModal(node) {
    node.classList.remove('hidden');
    var focusable = node.querySelector('.btn-primary, .btn, input, select');
    if (focusable) focusable.focus();
  }

  function closeModal(node) {
    node.classList.add('hidden');
  }

  function showSummary(summary) {
    var stats = [
      ['Detected colors', summary.detected],
      ['Generated records', summary.records],
      ['Existing records matched', summary.matched],
      ['New records created', summary.created],
      ['Labeled provinces', summary.labeled],
      ['Unlabeled provinces', summary.unlabeled],
      ['Neighbor relationships', summary.neighbors],
      ['Disconnected duplicate-color regions', summary.disconnected]
    ];
    el.summaryTitle.textContent = summary.reason === 'map'
      ? 'Map Analysis Complete'
      : summary.reason === 'import'
        ? 'JSON Matched to Map'
        : 'Map Analysis Complete';
    renderNoticeBody(stats, summary.warnings);
    openModal(el.summaryModal);
  }

  function showNotice(title, lines, warnings) {
    var stats = lines.map(function (line) { return ['', line]; });
    var filtered = stats.filter(function (row) { return row[1] !== ''; });
    el.summaryTitle.textContent = title;
    renderNoticeBody(filtered, warnings || []);
    openModal(el.summaryModal);
  }

  function renderNoticeBody(stats, warnings) {
    el.summaryStats.textContent = '';
    stats.forEach(function (row) {
      if (row[0]) {
        var dt = document.createElement('dt');
        dt.textContent = row[0];
        el.summaryStats.appendChild(dt);
      }
      var dd = document.createElement('dd');
      dd.textContent = row[0] ? formatNumber(row[1]) : row[1];
      if (!row[0]) dd.className = 'summary-line';
      el.summaryStats.appendChild(dd);
    });

    el.summaryWarnings.textContent = '';
    (warnings || []).forEach(function (warning) {
      var item = document.createElement('p');
      item.className = 'warning warning-' + (warning.kind || 'info');
      item.textContent = warning.text;
      el.summaryWarnings.appendChild(item);
    });
  }

  function clearToasts() {
    el.toasts.textContent = '';
  }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast' + (kind ? ' toast-' + kind : '');
    node.textContent = message;
    el.toasts.appendChild(node);
    while (el.toasts.children.length > MAX_TOASTS) el.toasts.removeChild(el.toasts.firstChild);
    var timeout = kind === 'error' ? 7000 : 4200;
    setTimeout(function () {
      node.classList.add('is-leaving');
      setTimeout(function () { node.remove(); }, 220);
    }, timeout);
  }

  function toggleBusy(show, text) {
    el.busy.classList.toggle('hidden', !show);
    if (text) el.busyText.textContent = text;
    [
      'btnUploadMap', 'btnImportJson', 'btnAnalyze', 'btnExport', 'btnReset',
      'btnOptions', 'btnEmptyUpload', 'btnEmptyImport'
    ].forEach(function (id) { el[id].disabled = show; });
  }

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------

  function openOptions() {
    el.optTolerance.value = String(state.settings.tolerance);
    el.optMinRegion.value = String(state.settings.minRegionPixels);
    el.optIgnore.value = state.settings.ignoreColors.join(', ');
    openModal(el.optionsModal);
  }

  function applyOptions() {
    var tolerance = clamp(Math.round(Number(el.optTolerance.value) || 0), 0, 150);
    var minRegion = clamp(Math.round(Number(el.optMinRegion.value) || 1), 1, 1000000);
    var ignore = parseIgnoreList(el.optIgnore.value);

    if (ignore.invalid.length) {
      toast('Ignored colors: "' + ignore.invalid.join('", "') + '" are not valid 6-digit HEX codes.', 'error');
      return;
    }

    state.settings.tolerance = tolerance;
    state.settings.minRegionPixels = minRegion;
    state.settings.ignoreColors = ignore.colors;
    state.ignoreTouched = true;
    closeModal(el.optionsModal);

    if (state.map) analyzeMap({ reason: 'options' });
    else toast('Options saved. Upload a map to analyze.', 'success');
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function notifyCountries() {
    var tab = rootCountryTab();
    if (tab) tab.onProvincesChanged();
  }

  function setTab(tab) {
    tab = tab === 'countries' ? 'countries' : 'provinces';
    if (state.tab === tab) return;

    state.tab = tab;
    var countries = tab === 'countries';

    el.tabProvinces.classList.toggle('is-active', !countries);
    el.tabCountries.classList.toggle('is-active', countries);
    el.tabProvinces.setAttribute('aria-selected', String(!countries));
    el.tabCountries.setAttribute('aria-selected', String(countries));
    el.provinceSidebar.classList.toggle('hidden', countries);
    el.countrySidebar.classList.toggle('hidden', !countries);
    el.countryViewModes.classList.toggle('hidden', !countries);
    el.viewport.classList.remove('is-assigning');

    // Country-tab highlights are transient and never survive a tab switch.
    clearHighlight();

    if (countries) {
      // Keep the province selection and any unsaved popup values, just hide them.
      el.popup.classList.add('hidden');
    } else if (state.selected && state.records.has(state.selected)) {
      el.popup.classList.remove('hidden');
      setHighlight(state.selected);
    }

    var countryTab = rootCountryTab();
    if (countryTab) countryTab.onTabChanged(tab);
    refreshMapLayers();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function cacheElements() {
    [
      'btnUploadMap', 'btnImportJson', 'btnAnalyze', 'btnReset', 'btnExport', 'btnOptions',
      'btnEmptyUpload', 'btnEmptyImport', 'mapInput', 'jsonInput', 'mapChip', 'jsonChip',
      'viewport', 'stage', 'emptyState', 'provinceList', 'searchInput', 'filterRow',
      'tabProvinces', 'tabCountries', 'provinceSidebar', 'countrySidebar', 'countryViewModes',
      'popup', 'popupSwatch', 'popupColor', 'popupName', 'popupType', 'popupSub',
      'popupNeighbors', 'popupDisconnected', 'popupWarning', 'popupError', 'popupClose',
      'popupDone', 'busy', 'busyText', 'zoomReadout', 'btnZoomIn', 'btnZoomOut', 'btnFit',
      'statDetected', 'statRecords', 'statLabeled', 'statUnlabeled', 'statNeighbors',
      'statWarnings', 'summaryModal', 'summaryTitle', 'summaryStats', 'summaryWarnings',
      'summaryClose', 'optionsModal', 'optTolerance', 'optMinRegion', 'optIgnore',
      'optCancel', 'optApply', 'toasts', 'deleteModal', 'deleteDetail', 'deleteCancel',
      'deleteConfirm'
    ].forEach(function (id) { el[id] = byId(id); });
  }

  function wireEvents() {
    el.tabProvinces.addEventListener('click', function () { setTab('provinces'); });
    el.tabCountries.addEventListener('click', function () { setTab('countries'); });

    el.btnUploadMap.addEventListener('click', function () { el.mapInput.click(); });
    el.btnEmptyUpload.addEventListener('click', function () { el.mapInput.click(); });
    el.btnImportJson.addEventListener('click', function () { el.jsonInput.click(); });
    el.btnEmptyImport.addEventListener('click', function () { el.jsonInput.click(); });

    el.mapInput.addEventListener('change', function () {
      var file = el.mapInput.files && el.mapInput.files[0];
      el.mapInput.value = '';
      if (file) handleMapFile(file);
    });
    el.jsonInput.addEventListener('change', function () {
      var file = el.jsonInput.files && el.jsonInput.files[0];
      el.jsonInput.value = '';
      if (file) handleJsonFile(file);
    });

    el.btnAnalyze.addEventListener('click', function () { analyzeMap({ reason: 'manual' }); });
    el.btnExport.addEventListener('click', exportJson);
    el.btnReset.addEventListener('click', function () {
      if (!state.selected) {
        toast('Nothing is selected.', 'info');
        return;
      }
      closePopup();
      toast('Selection cleared.', 'info');
    });
    el.btnOptions.addEventListener('click', openOptions);
    el.statWarnings.addEventListener('click', function () {
      if (state.lastSummary) showSummary(state.lastSummary);
    });

    el.popupClose.addEventListener('click', closePopup);
    el.popupDone.addEventListener('click', commitPopup);
    el.popupName.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); commitPopup(); }
    });
    el.popupName.addEventListener('input', function () {
      el.popupError.classList.add('hidden');
    });

    el.searchInput.addEventListener('input', function () {
      state.search = el.searchInput.value;
      renderList();
    });

    el.filterRow.addEventListener('click', function (event) {
      var button = event.target.closest('.chip');
      if (!button) return;
      state.filter = button.dataset.filter || 'all';
      Array.prototype.forEach.call(el.filterRow.querySelectorAll('.chip'), function (chip) {
        chip.classList.toggle('is-active', chip === button);
      });
      renderList();
    });

    el.provinceList.addEventListener('click', function (event) {
      var remove = event.target.closest('.row-delete');
      if (remove) {
        requestDelete(remove.dataset.color);
        return;
      }
      var row = event.target.closest('.province-row');
      if (!row) return;
      selectProvince(row.dataset.color);
    });

    el.provinceList.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('.row-delete')) return;
      var row = event.target.closest('.province-row');
      if (!row) return;
      event.preventDefault();
      selectProvince(row.dataset.color);
    });

    el.deleteCancel.addEventListener('click', cancelDelete);
    el.deleteConfirm.addEventListener('click', confirmDelete);
    el.deleteModal.addEventListener('click', function (event) {
      if (event.target === el.deleteModal) cancelDelete();
    });

    el.viewport.addEventListener('pointerdown', handlePointerDown);
    el.viewport.addEventListener('pointermove', handlePointerMove);
    el.viewport.addEventListener('pointerup', handlePointerUp);
    el.viewport.addEventListener('pointercancel', function (event) {
      if (state.pointer && state.pointer.id === event.pointerId) {
        state.pointer = null;
        el.viewport.classList.remove('is-grabbing');
      }
    });

    el.viewport.addEventListener('wheel', function (event) {
      if (!state.map) return;
      event.preventDefault();
      var factor = Math.pow(1.0015, -event.deltaY);
      zoomAt(event.clientX, event.clientY, factor);
    }, { passive: false });

    el.btnZoomIn.addEventListener('click', function () {
      var rect = el.viewport.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.3);
    });
    el.btnZoomOut.addEventListener('click', function () {
      var rect = el.viewport.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.3);
    });
    el.btnFit.addEventListener('click', fitView);

    el.summaryClose.addEventListener('click', function () { closeModal(el.summaryModal); });
    el.summaryModal.addEventListener('click', function (event) {
      if (event.target === el.summaryModal) closeModal(el.summaryModal);
    });
    el.optCancel.addEventListener('click', function () { closeModal(el.optionsModal); });
    el.optApply.addEventListener('click', applyOptions);
    el.optionsModal.addEventListener('click', function (event) {
      if (event.target === el.optionsModal) closeModal(el.optionsModal);
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      el.viewport.addEventListener(type, function (event) {
        event.preventDefault();
        el.viewport.classList.add('is-dropping');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      el.viewport.addEventListener(type, function () {
        el.viewport.classList.remove('is-dropping');
      });
    });
    el.viewport.addEventListener('drop', function (event) {
      event.preventDefault();
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      if (/\.json$/i.test(file.name) || file.type === 'application/json') handleJsonFile(file);
      else handleMapFile(file);
    });

    window.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!el.popup.classList.contains('hidden')) { closePopup(); return; }
      if (!el.deleteModal.classList.contains('hidden')) { cancelDelete(); return; }
      var countryTab = rootCountryTab();
      if (countryTab && countryTab.handleEscape()) return;
      if (!el.summaryModal.classList.contains('hidden')) { closeModal(el.summaryModal); return; }
      if (!el.optionsModal.classList.contains('hidden')) { closeModal(el.optionsModal); }
    });

    window.addEventListener('resize', function () {
      if (state.map && state.autoFit) fitView();
    });
  }

  function init() {
    cacheElements();
    wireEvents();
    renderAll();
    applyView();

    if (rootCountryTab()) {
      rootCountryTab().init({
        state: state,
        toast: toast,
        plural: plural,
        formatNumber: formatNumber,
        isLabeled: isLabeled,
        showNotice: showNotice,
        download: download,
        openModal: openModal,
        closeModal: closeModal,
        refreshMap: refreshMapLayers,
        refitIfAuto: function () { if (state.autoFit) fitView(); },
        clearHighlight: clearHighlight,
        highlightProvince: function (colorHex) {
          if (!state.records.has(colorHex)) return;
          setHighlight(colorHex);
          ensureVisible(colorHex);
        }
      });
    }

    // Test/debug hook: read state and drive the app from automated checks.
    window.ProvinceMapEditor = {
      state: state,
      analyze: function () { return analyzeMap({ reason: 'manual' }); },
      select: selectProvince,
      records: buildExportObject,
      exportText: function () { return serializeProvinceJson(buildExportObject()) + '\n'; },
      commit: commitPopup,
      close: closePopup,
      requestDelete: requestDelete,
      deleteProvince: deleteProvince,
      confirmDelete: confirmDelete,
      register: registerProvince,
      setTab: setTab,
      countryTab: rootCountryTab,
      setOptions: function (options) {
        if (!options) return;
        if (typeof options.tolerance === 'number') state.settings.tolerance = options.tolerance;
        if (typeof options.minRegionPixels === 'number') state.settings.minRegionPixels = options.minRegionPixels;
        if (Array.isArray(options.ignoreColors)) state.settings.ignoreColors = options.ignoreColors.slice();
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
