/*!
 * Province Map Analyzer
 * Pure, dependency-free raster analysis shared by the main thread and a Web Worker.
 *
 * analyzePixels() must stay self-contained (no outside references) because its
 * source is serialized into a Blob worker.
 */
(function (root) {
  'use strict';

  function analyzePixels(payload) {
    'use strict';

    var width = Math.max(1, payload.width | 0);
    var height = Math.max(1, payload.height | 0);
    var data = payload.data;
    if (!data || data.length < width * height * 4) throw new Error('Invalid pixel buffer.');

    var alphaThreshold = payload.alphaThreshold == null ? 16 : payload.alphaThreshold;
    var tolerance = Math.max(0, payload.tolerance || 0);
    var minRegionPixels = Math.max(1, payload.minRegionPixels || 1);
    var ignoreColors = payload.ignoreColors || [];
    var snapColors = payload.snapColors && payload.snapColors.length ? payload.snapColors : null;
    var pixelCount = width * height;

    var stats = {
      width: width,
      height: height,
      pixelCount: pixelCount,
      opaquePixels: 0,
      ignoredPixels: 0,
      ignoredColors: 0,
      smallColors: 0,
      smallColorPixels: 0,
      mergedColors: 0,
      mergedPixels: 0,
      snappedColors: 0,
      tinyColors: 0,
      tinyPixels: 0,
      components: 0,
      disconnectedColors: 0,
      tolerance: tolerance,
      minRegionPixels: minRegionPixels,
      snapped: !!snapColors
    };

    function hexOf(c) {
      return ('000000' + c.toString(16)).slice(-6);
    }

    function dist2(a, b) {
      var dr = ((a >> 16) & 255) - ((b >> 16) & 255);
      var dg = ((a >> 8) & 255) - ((b >> 8) & 255);
      var db = (a & 255) - (b & 255);
      return dr * dr + dg * dg + db * db;
    }

    // 1. Histogram of opaque colors ---------------------------------------
    var counts = new Map();
    for (var i = 0, p = 0; i < pixelCount; i++, p += 4) {
      if (data[p + 3] < alphaThreshold) continue;
      var key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
      stats.opaquePixels++;
    }

    for (var g = 0; g < ignoreColors.length; g++) {
      var ignoredCount = counts.get(ignoreColors[g]);
      if (ignoredCount) {
        counts.delete(ignoreColors[g]);
        stats.ignoredPixels += ignoredCount;
        stats.ignoredColors++;
      }
    }

    var entries = [];
    counts.forEach(function (n, c) { entries.push([c, n]); });
    entries.sort(function (a, b) { return b[1] - a[1] || a[0] - b[0]; });

    // 2. Build color representatives --------------------------------------
    var reps = [];
    var colorToRep = new Map();

    if (snapColors) {
      // SVG mode: every rasterized pixel is snapped to its nearest source
      // fill/stroke color so anti-aliased blends never become provinces.
      var snaps = [];
      var seenSnap = new Set();
      for (var s = 0; s < snapColors.length; s++) {
        if (!seenSnap.has(snapColors[s])) {
          seenSnap.add(snapColors[s]);
          snaps.push(snapColors[s]);
        }
      }
      var repBySnap = new Map();
      for (var e = 0; e < entries.length; e++) {
        var color = entries[e][0];
        var amount = entries[e][1];
        var best = null;
        var bestD = Infinity;
        for (var k = 0; k < snaps.length; k++) {
          var d = dist2(color, snaps[k]);
          if (d < bestD) { bestD = d; best = snaps[k]; }
        }
        if (best === null) continue;
        var snapRep = repBySnap.get(best);
        if (!snapRep) {
          snapRep = { color: best, count: 0, variants: 0 };
          reps.push(snapRep);
          repBySnap.set(best, snapRep);
        }
        snapRep.count += amount;
        snapRep.variants++;
        colorToRep.set(color, snapRep);
        if (bestD > 0) stats.snappedColors++;
      }
    } else {
      for (var j = 0; j < entries.length; j++) {
        var rgb = entries[j][0];
        var px = entries[j][1];

        if (tolerance === 0) {
          if (px < minRegionPixels) {
            stats.smallColors++;
            stats.smallColorPixels += px;
            continue;
          }
          var own = { color: rgb, count: px, variants: 1 };
          reps.push(own);
          colorToRep.set(rgb, own);
          continue;
        }

        var match = null;
        var matchD = tolerance * tolerance;
        for (var r = 0; r < reps.length; r++) {
          var dd = dist2(rgb, reps[r].color);
          if (dd <= matchD) { matchD = dd; match = reps[r]; }
        }
        if (match) {
          match.count += px;
          match.variants++;
          colorToRep.set(rgb, match);
          stats.mergedColors++;
          stats.mergedPixels += px;
        } else {
          var fresh = { color: rgb, count: px, variants: 1 };
          reps.push(fresh);
          colorToRep.set(rgb, fresh);
        }
      }
    }

    // Representative colors that are too small are dropped after aggregation.
    var finalReps = reps;
    if (snapColors || tolerance > 0) {
      finalReps = [];
      for (var f = 0; f < reps.length; f++) {
        if (reps[f].count < minRegionPixels) {
          stats.smallColors++;
          stats.smallColorPixels += reps[f].count;
          continue;
        }
        finalReps.push(reps[f]);
      }
    }

    for (var t = 0; t < finalReps.length; t++) {
      if (finalReps[t].count < 16) {
        stats.tinyColors++;
        stats.tinyPixels += finalReps[t].count;
      }
    }

    if (!finalReps.length) {
      return {
        width: width,
        height: height,
        colors: [],
        labels: new Int32Array(pixelCount),
        compColor: new Int32Array(1),
        compSize: new Int32Array(1),
        stats: stats
      };
    }

    var repIndexByRef = new Map();
    for (var ri = 0; ri < finalReps.length; ri++) repIndexByRef.set(finalReps[ri], ri);

    var pixelRep = new Map();
    colorToRep.forEach(function (rep, c) {
      var idx = repIndexByRef.get(rep);
      if (idx !== undefined) pixelRep.set(c, idx + 1);
    });

    // 3. Per-pixel representative index (0 = no province) ------------------
    var px2rep = new Int32Array(pixelCount);
    for (var q = 0, qp = 0; q < pixelCount; q++, qp += 4) {
      if (data[qp + 3] < alphaThreshold) continue;
      var qc = (data[qp] << 16) | (data[qp + 1] << 8) | data[qp + 2];
      var hit = pixelRep.get(qc);
      if (hit) px2rep[q] = hit;
    }

    // 4. Connected components (4-connectivity) -----------------------------
    var labels = new Int32Array(pixelCount);
    var stack = new Int32Array(pixelCount);
    var compColor = [-1];
    var compSize = [0];
    var repComponents = new Int32Array(finalReps.length);
    var repBBox = [];
    for (var b = 0; b < finalReps.length; b++) {
      repBBox.push({ x0: width, y0: height, x1: -1, y1: -1 });
    }

    var compId = 0;
    for (var start = 0; start < pixelCount; start++) {
      var startRep = px2rep[start];
      if (!startRep || labels[start]) continue;

      compId++;
      var repId = startRep - 1;
      labels[start] = compId;
      var top = 0;
      stack[top++] = start;
      var size = 0;
      var box = repBBox[repId];

      while (top) {
        var cur = stack[--top];
        size++;
        var cy = (cur / width) | 0;
        var cx = cur - cy * width;
        if (cx < box.x0) box.x0 = cx;
        if (cx > box.x1) box.x1 = cx;
        if (cy < box.y0) box.y0 = cy;
        if (cy > box.y1) box.y1 = cy;

        if (cx > 0) {
          var left = cur - 1;
          if (!labels[left] && px2rep[left] === startRep) { labels[left] = compId; stack[top++] = left; }
        }
        if (cx + 1 < width) {
          var right = cur + 1;
          if (!labels[right] && px2rep[right] === startRep) { labels[right] = compId; stack[top++] = right; }
        }
        if (cy > 0) {
          var up = cur - width;
          if (!labels[up] && px2rep[up] === startRep) { labels[up] = compId; stack[top++] = up; }
        }
        if (cy + 1 < height) {
          var down = cur + width;
          if (!labels[down] && px2rep[down] === startRep) { labels[down] = compId; stack[top++] = down; }
        }
      }

      compColor.push(repId);
      compSize.push(size);
      repComponents[repId]++;
    }

    // 5. Neighbors through 4-directional pixel adjacency --------------------
    var neighborSets = [];
    for (var n = 0; n < finalReps.length; n++) neighborSets.push(new Set());

    for (var y = 0; y < height; y++) {
      var row = y * width;
      for (var x = 0; x < width; x++) {
        var idx = row + x;
        var a = px2rep[idx];
        if (!a) continue;

        if (x + 1 < width) {
          var bRight = px2rep[idx + 1];
          if (bRight && bRight !== a) {
            neighborSets[a - 1].add(bRight - 1);
            neighborSets[bRight - 1].add(a - 1);
          }
        }
        if (y + 1 < height) {
          var bDown = px2rep[idx + width];
          if (bDown && bDown !== a) {
            neighborSets[a - 1].add(bDown - 1);
            neighborSets[bDown - 1].add(a - 1);
          }
        }
      }
    }

    var colors = [];
    for (var ci = 0; ci < finalReps.length; ci++) {
      var cbox = repBBox[ci];
      var list = Array.from(neighborSets[ci]);
      list.sort(function (m, o) { return m - o; });
      colors.push({
        hex: hexOf(finalReps[ci].color),
        color: finalReps[ci].color,
        pixels: finalReps[ci].count,
        variants: finalReps[ci].variants,
        components: repComponents[ci],
        bbox: cbox.x1 >= 0
          ? { x: cbox.x0, y: cbox.y0, width: cbox.x1 - cbox.x0 + 1, height: cbox.y1 - cbox.y0 + 1 }
          : null,
        neighbors: list
      });
    }

    stats.components = compId;
    var disconnected = 0;
    for (var dc = 0; dc < colors.length; dc++) if (colors[dc].components > 1) disconnected++;
    stats.disconnectedColors = disconnected;

    return {
      width: width,
      height: height,
      colors: colors,
      labels: labels,
      compColor: new Int32Array(compColor),
      compSize: new Int32Array(compSize),
      stats: stats
    };
  }

  function createAnalysisWorker() {
    var source = [
      "'use strict';",
      'self.onmessage = function (event) {',
      '  try {',
      '    var analyze = (' + analyzePixels.toString() + ');',
      '    var result = analyze(event.data);',
      '    self.postMessage({ ok: true, result: result }, [',
      '      result.labels.buffer, result.compColor.buffer, result.compSize.buffer',
      '    ]);',
      '  } catch (err) {',
      '    self.postMessage({ ok: false, error: String((err && err.stack) || err) });',
      '  }',
      '};'
    ].join('\n');

    var blob = new Blob([source], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    var worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    worker.__objectUrl = url;
    return worker;
  }

  function hexToInt(hex) {
    var value = String(hex).trim().toLowerCase().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/.test(value)) return null;
    return parseInt(value, 16);
  }

  function intToHex(value) {
    return ('000000' + (value >>> 0).toString(16)).slice(-6);
  }

  root.MapAnalyzer = {
    analyzePixels: analyzePixels,
    createAnalysisWorker: createAnalysisWorker,
    hexToInt: hexToInt,
    intToHex: intToHex
  };
})(typeof self !== 'undefined' ? self : window);
