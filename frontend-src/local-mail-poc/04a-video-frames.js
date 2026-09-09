var customSongFrameReader = (function () {
  var busy = false;
  var FRAME_WIDTH = 320;
  var FRAME_HEIGHT = 180;
  var MAX_FRAME_COUNT = 3;
  var MEDIA_TIME_TOLERANCE = 0.15;
  var LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

  function makeError(name, message) {
    var error;
    try {
      error = new DOMException(message, name);
    } catch (ignored) {
      error = new Error(message);
      error.name = name;
    }
    return error;
  }

  function currentTime() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function abortError(signal) {
    return signal && signal.reason ? signal.reason : makeError("AbortError", "Frame capture was cancelled");
  }

  function isLoopbackHostname(hostname) {
    var host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (LOOPBACK_HOSTS.indexOf(host) !== -1) return true;
    var parts = host.split(".");
    if (parts.length !== 4 || parts.some(function (part) { return !/^\d+$/.test(part); })) return false;
    var first = Number(parts[0]);
    return first === 127 && parts.every(function (part) {
      var value = Number(part);
      return value >= 0 && value <= 255;
    });
  }

  function validateMediaUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("A custom-song media URL is required");
    }
    var parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new TypeError("Invalid custom-song media URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("Custom-song media URL must use http or https");
    }
    if (parsed.username || parsed.password || !isLoopbackHostname(parsed.hostname)) {
      throw new TypeError("Custom-song media URL must be a credential-free loopback URL");
    }
    if (parsed.search || parsed.hash
      || !/^\/custom-song-media\/[a-f0-9]{48}\/[^/]+$/i.test(parsed.pathname)) {
      throw new TypeError("Invalid custom-song media path");
    }
    return parsed.href;
  }

  function readyForPixels(video) {
    return Boolean(video && Number(video.readyState) >= 2 && !video.seeking);
  }

  function near(value, target) {
    return Number.isFinite(Number(value)) && Math.abs(Number(value) - target) <= MEDIA_TIME_TOLERANCE;
  }

  function scheduleMicrotask(callback) {
    if (typeof queueMicrotask === "function") queueMicrotask(callback);
    else Promise.resolve().then(callback);
  }

  function waitWithAbort(value, signal) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      function cleanup() {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      }
      function finish(callback, result) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(result);
      }
      function onAbort() {
        finish(reject, abortError(signal));
      }
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      Promise.resolve(value).then(function (result) {
        finish(resolve, result);
      }, function (error) {
        finish(reject, error);
      });
    });
  }

  function mediaError(video) {
    var code = video && video.error && video.error.code;
    return makeError("MediaError", "Unable to load custom-song media" + (code == null ? "" : " (" + code + ")"));
  }

  function waitForLoaded(video, url, signal) {
    return new Promise(function (resolve, reject) {
      var settled = false;

      function cleanup() {
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
      }
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function onLoaded() {
        finish(resolve, undefined);
      }
      function onError() {
        finish(reject, mediaError(video));
      }
      function onAbort() {
        finish(reject, abortError(signal));
      }

      video.addEventListener("loadeddata", onLoaded);
      video.addEventListener("error", onError);
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      try {
        video.src = url;
        video.load();
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function waitForSeek(video, target, signal) {
    var requestFrame = typeof video.requestVideoFrameCallback === "function";
    if (!requestFrame) {
      return new Promise(function (resolve, reject) {
        var settled = false;

        function cleanup() {
          video.removeEventListener("seeked", onSeeked);
          video.removeEventListener("error", onError);
          if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
        }
        function finish(callback, value) {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        }
        function onSeeked() {
          if (!near(video.currentTime, target)) {
            finish(reject, makeError("FrameTimeError", "The video did not seek to the requested time"));
            return;
          }
          if (!readyForPixels(video)) {
            finish(reject, makeError("FrameStateError", "The video is not ready after seeking"));
            return;
          }
          finish(resolve, { time: Number(video.currentTime), verified: false });
        }
        function onError() {
          finish(reject, mediaError(video));
        }
        function onAbort() {
          finish(reject, abortError(signal));
        }

        video.addEventListener("seeked", onSeeked);
        video.addEventListener("error", onError);
        if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
        if (signal && signal.aborted) {
          onAbort();
          return;
        }
        try {
          video.currentTime = target;
        } catch (error) {
          finish(reject, error);
        }
      });
    }

    return new Promise(function (resolve, reject) {
      var settled = false;
      var seeked = false;
      var frameId = null;
      var proof = null;

      function cancelFrame() {
        if (frameId !== null && typeof video.cancelVideoFrameCallback === "function") {
          try { video.cancelVideoFrameCallback(frameId); } catch (ignored) { /* cleanup is best effort */ }
        }
        frameId = null;
      }
      function cleanup() {
        cancelFrame();
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
      }
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }
      function maybeFinish() {
        if (!seeked || !proof || !near(video.currentTime, target) || !readyForPixels(video)) return;
        finish(resolve, proof);
      }
      function requestNextFrame() {
        if (settled) return;
        try {
          var requestedId = video.requestVideoFrameCallback(function (_now, metadata) {
            frameId = null;
            if (settled) return;
            var mediaTime = Number(metadata && metadata.mediaTime);
            if (near(mediaTime, target)) {
              proof = { time: mediaTime, verified: true };
              maybeFinish();
              return;
            }
            scheduleMicrotask(requestNextFrame);
          });
          if (!settled) frameId = requestedId == null ? null : requestedId;
        } catch (error) {
          finish(reject, error);
        }
      }
      function onSeeked() {
        if (!near(video.currentTime, target)) {
          finish(reject, makeError("FrameTimeError", "The video did not seek to the requested time"));
          return;
        }
        seeked = true;
        maybeFinish();
      }
      function onError() {
        finish(reject, mediaError(video));
      }
      function onAbort() {
        finish(reject, abortError(signal));
      }

      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      try {
        requestNextFrame();
        video.currentTime = target;
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function frameTimes(duration) {
    var times = [0];
    if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) return times;
    [Math.min(2, Number(duration) / 3), Math.min(4, 2 * Number(duration) / 3)].forEach(function (value) {
      if (Number.isFinite(value) && value !== times[times.length - 1]) times.push(value);
    });
    return times.slice(0, MAX_FRAME_COUNT);
  }

  function removeOwned(node) {
    if (!node) return;
    try {
      if (node.parentNode && typeof node.parentNode.removeChild === "function") node.parentNode.removeChild(node);
      else if (typeof node.remove === "function") node.remove();
    } catch (ignored) { /* cleanup is best effort */ }
  }

  async function captureOwned(options) {
    var url = validateMediaUrl(options.url);
    var onFrame = options.onFrame;
    if (onFrame != null && typeof onFrame !== "function") throw new TypeError("onFrame must be a function");
    onFrame = onFrame || function () { return false; };
    var timeoutMs = options.timeoutMs === undefined ? 12000 : Number(options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs must be a non-negative number");
    var externalSignal = options.signal || null;
    var controller = new AbortController();
    var signal = controller.signal;
    var timeoutTimer = null;
    var video = null;
    var canvas = null;
    var context = null;
    var body = null;

    function forwardExternalAbort() {
      if (!signal.aborted) controller.abort(abortError(externalSignal));
    }
    if (externalSignal && externalSignal.aborted) forwardExternalAbort();
    else if (externalSignal && typeof externalSignal.addEventListener === "function") {
      externalSignal.addEventListener("abort", forwardExternalAbort, { once: true });
    }
    timeoutTimer = setTimeout(function () {
      if (!signal.aborted) controller.abort(makeError("TimeoutError", "Frame capture timed out"));
    }, timeoutMs);

    try {
      if (signal.aborted) throw abortError(signal);
      if (typeof document === "undefined" || !document || typeof document.createElement !== "function") {
        throw makeError("CanvasError", "A document is required for frame capture");
      }
      video = document.createElement("video");
      canvas = document.createElement("canvas");
      if (!video || !canvas || typeof canvas.getContext !== "function") {
        throw makeError("CanvasError", "Canvas is unavailable");
      }
      video.setAttribute("data-linli-custom-song-frame-reader", "owned");
      canvas.setAttribute("data-linli-custom-song-frame-reader", "owned");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:320px;height:180px;opacity:0;pointer-events:none;";
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
      canvas.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:320px;height:180px;pointer-events:none;";
      context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || typeof context.drawImage !== "function" || typeof context.getImageData !== "function"
        || typeof canvas.toDataURL !== "function") {
        throw makeError("CanvasError", "A readable 2D canvas is unavailable");
      }
      body = document.body;
      if (!body || typeof body.appendChild !== "function") throw makeError("CanvasError", "A document body is required");
      body.appendChild(video);
      body.appendChild(canvas);

      await waitForLoaded(video, url, signal);
      if (signal.aborted) throw abortError(signal);
      if (!readyForPixels(video)) throw makeError("FrameStateError", "The video is not ready after loading");

      var times = frameTimes(video.duration);
      var frameCount = 0;
      for (var index = 0; index < times.length; index += 1) {
        var target = times[index];
        var proof;
        if (index === 0) {
          proof = {
            time: Number(video.currentTime),
            verified: near(video.currentTime, 0) && readyForPixels(video)
          };
        } else {
          proof = await waitWithAbort(waitForSeek(video, target, signal), signal);
        }
        if (signal.aborted) throw abortError(signal);
        if (!readyForPixels(video)) throw makeError("FrameStateError", "The video is not ready for capture");
        context.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
        var imageData = context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
        var thumbnail = options.thumbnail === false ? null : canvas.toDataURL("image/jpeg", 0.72);
        var payload = {
          imageData: imageData,
          time: proof.time,
          target: target,
          verified: proof.verified,
          thumbnail: thumbnail,
          sourceWidth: Number(video.videoWidth) || 0,
          sourceHeight: Number(video.videoHeight) || 0
        };
        var stop = await waitWithAbort(Promise.resolve().then(function () {
          if (signal.aborted) throw abortError(signal);
          return onFrame(payload);
        }), signal);
        frameCount += 1;
        imageData = null;
        thumbnail = null;
        payload = null;
        if (stop === true) break;
      }
      return { frameCount: frameCount };
    } finally {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (externalSignal && typeof externalSignal.removeEventListener === "function") {
        externalSignal.removeEventListener("abort", forwardExternalAbort);
      }
      if (video) {
        try { video.pause(); } catch (ignoredPause) { /* cleanup is best effort */ }
        try { video.removeAttribute("src"); } catch (ignoredAttribute) { /* cleanup is best effort */ }
        try { video.load(); } catch (ignoredLoad) { /* cleanup is best effort */ }
      }
      if (canvas) {
        try { canvas.width = 0; canvas.height = 0; } catch (ignoredCanvas) { /* cleanup is best effort */ }
      }
      removeOwned(video);
      removeOwned(canvas);
      context = null;
      body = null;
      canvas = null;
      video = null;
    }
  }

  function capture(options) {
    options = options || {};
    if (busy) return Promise.reject(makeError("BusyError", "A frame capture is already running"));
    busy = true;
    var task;
    try {
      task = captureOwned(options);
    } catch (error) {
      task = Promise.reject(error);
    }
    return task.finally(function () {
      busy = false;
    });
  }

  return { capture: capture, isBusy: function () { return busy; } };
})();
