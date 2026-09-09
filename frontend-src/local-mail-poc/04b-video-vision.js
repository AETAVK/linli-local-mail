// Local-only, conservative hints for the known city-window performance scene.
// These rules are rejection gates, not calibrated confidence probabilities.
var customSongVision = (function () {
  var VERSION = VISION_ALGORITHM;
  var ROIS = [[0.44, 0.04, 0.62, 0.14], [0.72, 0.03, 0.91, 0.13], [0.43, 0.20, 0.63, 0.40]];
  var PERIODS = ["TOD12", "TOD1730", "TOD20"];
  function quantile(hist, count, ratio) {
    var target = Math.floor((count - 1) * ratio), sum = 0;
    for (var index = 0; index < 256; index++) {
      sum += hist[index];
      if (sum > target) return index;
    }
    return 0;
  }
  function features(image, sourceWidth, sourceHeight) {
    var width = image && image.width, height = image && image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 36 ||
      width > 640 || height > 360 || !image.data || image.data.length !== width * height * 4) return null;
    var pixels = image.data;
    var regions = ROIS.map(function (roi) {
      var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      var count = 0, edges = 0, comparisons = 0, black = 0, white = 0;
      var x1 = Math.floor(roi[0] * width), x2 = Math.floor(roi[2] * width);
      var y1 = Math.floor(roi[1] * height), y2 = Math.floor(roi[3] * height);
      for (var y = y1; y < y2; y++) {
        var previous = null;
        for (var x = x1; x < x2; x++) {
          var p = (y * width + x) * 4;
          var r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
          var lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
          hist[0][r]++; hist[1][g]++; hist[2][b]++; hist[3][lum]++; count++;
          if (lum < 12) black++;
          if (r > 249 && g > 249 && b > 249) white++;
          if (previous !== null) { comparisons++; if (Math.abs(lum - previous) >= 8) edges++; }
          previous = lum;
        }
      }
      var rgb = hist.slice(0, 3).map(function (h) { return quantile(h, count, 0.5); });
      return { rgb: rgb, lum: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
        warmth: (rgb[0] - rgb[2]) / (rgb[0] + rgb[1] + rgb[2] + 1),
        contrast: quantile(hist[3], count, 0.9) - quantile(hist[3], count, 0.1),
        edgeRate: comparisons ? edges / comparisons : 0, black: black / count, white: white / count };
    });
    return { version: VERSION, aspect: Number(sourceWidth || width) / Number(sourceHeight || height), regions: regions };
  }
  function classify(feature) {
    // Injected from the same pure module that the Node write guard imports.
    return classifyVisionFeature(feature);
  }
  function summarize(frames) {
    var selected = (frames || []).slice(0, 3);
    var known = selected.filter(function (f) { return PERIODS.indexOf(f.tod) >= 0; });
    var periods = new Set(known.map(function (f) { return f.tod; }));
    if (periods.size > 1 || selected.some(function (f) { return f.reason === "region-conflict"; })) return { tod: null, stable: false, reason: "frame-conflict", frames: selected.length };
    // A short black/transition frame may be skipped only when two different,
    // proven frames agree. Other unfamiliar scene evidence remains a veto.
    if (selected.some(function (f) { return !f.tod && ["black-frame", "obscured-frame"].indexOf(f.reason) < 0; })) return { tod: null, stable: false, reason: "unfamiliar-scene", frames: selected.length };
    var proven = known.filter(function (f) { return f.verified === true && Number.isFinite(f.time); });
    var distinct = new Set(proven.map(function (f) { return Math.round(f.time * 1000); }));
    return { tod: known.length ? known[0].tod : null, stable: distinct.size >= 2,
      reason: distinct.size >= 2 ? "two-frames-agree" : known.length ? "single-frame-hint" : "unclear-frame", frames: selected.length };
  }
  function defaultTarget(file) { return Boolean(file && file.evidence !== "manual" && (file.evidence !== "original" || file.conflict)); }
  function canApply(file, result) {
    return Boolean(file && file.fileRevision && result && result.stable && PERIODS.indexOf(result.tod) >= 0 &&
      file.evidence !== "original" && file.evidence !== "manual");
  }
  function crossCheck(results) {
    var warnings = {};
    Object.keys(results || {}).forEach(function (key) {
      var result = results[key];
      if (!result || !result.tod) return;
      if (Object.keys(results).some(function (other) { return other !== key && results[other] && results[other].tod === result.tod; })) warnings[key] = "duplicate-period";
    });
    return warnings;
  }
  function createCache(limit) {
    var maximum = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 128)) : 64;
    var entries = new Map();
    function key(file) { return file && /^v1:[a-f0-9]{64}$/.test(file.fileRevision || "") ? VERSION + ":" + file.fileRevision : null; }
    return {
      get: function (file) { var k = key(file), value = entries.get(k); if (!value) return null; entries.delete(k); entries.set(k, value); return JSON.parse(JSON.stringify(value)); },
      set: function (file, frames) {
        var k = key(file); if (!k) return;
        // Only scalar result/feature records are cached, never pixels, URLs or thumbnails.
        var value = (frames || []).slice(0, 3).map(function (f) { return { tod: f.tod, reason: f.reason, verified: f.verified === true, time: f.time }; });
        entries.delete(k); entries.set(k, value);
        while (entries.size > maximum) entries.delete(entries.keys().next().value);
      },
      clear: function () { entries.clear(); },
      size: function () { return entries.size; },
      version: VERSION,
    };
  }
  return { version: VERSION, regions: ROIS, features: features, classify: classify, summarize: summarize,
    defaultTarget: defaultTarget, canApply: canApply, crossCheck: crossCheck, createCache: createCache };
})();
