// Automatic-write policy is deliberately separate from the interactive hint policy.
// Scalars are produced by the local frontend. These are heuristic gates, not probabilities or official proof.
export const VISION_ALGORITHM = 'city-window-roi1-v1';
export const VISION_POLICY = 'three-proven-frames-v1';
export const VISION_PERIODS = Object.freeze(['TOD12', 'TOD1730', 'TOD20']);
const unknown = reason => ({ tod: null, reason });

export function normalizeVisionFeature(value) {
  if (!value || value.version !== VISION_ALGORITHM || !Number.isFinite(value.aspect) || value.aspect < .1 || value.aspect > 10 ||
    !Array.isArray(value.regions) || value.regions.length !== 3) return null;
  const regions = [];
  for (const region of value.regions) {
    if (!region || !Array.isArray(region.rgb) || region.rgb.length !== 3 || region.rgb.some(n => !Number.isFinite(n) || n < 0 || n > 255) ||
      !['lum', 'warmth', 'contrast', 'edgeRate', 'black', 'white'].every(key => Number.isFinite(region[key]))) return null;
    const [r, g, b] = region.rgb, lum = .2126 * r + .7152 * g + .0722 * b, warmth = (r - b) / (r + g + b + 1);
    if (Math.abs(lum - region.lum) > 0.01 || Math.abs(warmth - region.warmth) > 0.0001 || region.contrast < 0 || region.contrast > 255 ||
      ['edgeRate', 'black', 'white'].some(key => region[key] < 0 || region[key] > 1)) return null;
    regions.push({ rgb: [...region.rgb], lum, warmth, contrast: region.contrast, edgeRate: region.edgeRate, black: region.black, white: region.white });
  }
  return { version: VISION_ALGORITHM, aspect: value.aspect, regions };
}

function sky(region) {
  const [r, g, b] = region.rgb, y = region.lum, w = region.warmth;
  if (y >= 185 && y <= 250 && w >= -.13 && w <= .01 && b - r >= 8 && g - r >= 4) return 'TOD12';
  if (y >= 155 && y <= 245 && w >= .012 && w <= .17 && r - g >= 6 && g - b >= -8) return 'TOD1730';
  if (y >= 18 && y <= 88 && w >= -.65 && w <= -.10 && b - g >= 5 && g - r >= 7) return 'TOD20';
  return null;
}

export function classifyVisionFeature(value) {
  const feature = normalizeVisionFeature(value);
  if (!feature) return unknown('invalid-features');
  if (Math.abs(feature.aspect - 16 / 9) > .04) return unknown('unfamiliar-scene');
  const [a, b, city] = feature.regions;
  if (feature.regions.every(region => region.black > .85 || region.lum < 12)) return unknown('black-frame');
  if (feature.regions.some(region => region.white > .65 || region.black > .65)) return unknown('obscured-frame');
  const one = sky(a), two = sky(b);
  if (one && two && one !== two) return unknown('region-conflict');
  if (!one || one !== two || Math.abs(a.lum - b.lum) > 28 || Math.abs(a.warmth - b.warmth) > .065) return unknown('unfamiliar-scene');
  if (a.contrast > 80 || b.contrast > 80 || city.contrast < 6 || city.edgeRate < .004 || city.edgeRate > .65) return unknown('unfamiliar-structure');
  const top = (a.lum + b.lum) / 2, warm = (a.warmth + b.warmth) / 2;
  const matches = one === 'TOD12' ? city.lum >= 130 && city.lum <= 242 && city.warmth >= -.15 && city.warmth <= .035 && top - city.lum >= 5 && top - city.lum <= 100
    : one === 'TOD1730' ? city.lum >= 115 && city.lum <= 225 && city.warmth >= .065 && city.warmth <= .30 && city.warmth - warm >= .02 && top - city.lum >= 5 && top - city.lum <= 100
    : city.lum >= 15 && city.lum <= 95 && city.warmth >= -.60 && city.warmth <= -.05 && top - city.lum >= -12 && top - city.lum <= 45;
  return matches ? { tod: one, reason: 'scene-match' } : unknown('region-conflict');
}

export function evaluateVisionFrames(input) {
  if (!input || input.algorithm !== VISION_ALGORITHM || input.policy !== VISION_POLICY || !Array.isArray(input.frames) || input.frames.length !== 3)
    return { ...unknown('three-frames-required'), cacheable: false, frames: [] };
  const frames = [];
  for (const frame of input.frames) {
    const feature = normalizeVisionFeature(frame?.feature);
    if (!frame || frame.verified !== true || !Number.isFinite(frame.time) || !Number.isFinite(frame.target) || frame.time < 0 || frame.time > 86400 ||
      frame.target < 0 || Math.abs(frame.time - frame.target) > .15 || !feature)
      return { ...unknown('unverified-frame'), cacheable: false, frames: [] };
    const classified = classifyVisionFeature(feature);
    frames.push({ time: frame.time, target: frame.target, verified: true, feature, ...classified });
  }
  if (new Set(frames.map(frame => Math.round(frame.time * 1000))).size !== 3 || frames.some((frame, index) => index && frame.time <= frames[index - 1].time))
    return { ...unknown('distinct-frames-required'), cacheable: false, frames: [] };
  const known = frames.filter(frame => frame.tod), periods = new Set(known.map(frame => frame.tod));
  let reason = 'three-frame-agreement', tod = null;
  if (periods.size > 1 || frames.some(frame => frame.reason === 'region-conflict')) reason = 'frame-conflict';
  else if (frames.some(frame => !frame.tod && frame.reason !== 'black-frame')) reason = 'unfamiliar-scene';
  else if (known.length < 2 || periods.size !== 1) reason = 'unclear-frames';
  else tod = known[0].tod;
  return { tod, reason, cacheable: true, frames };
}
