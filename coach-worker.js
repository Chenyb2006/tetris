/* Static worker entry; bundled builds preload both dependencies in a Blob. */
(function (scope) {
  'use strict';
  if (!scope.PixelEngine) scope.importScripts('engine.js');
  if (!scope.PixelCoachCore) scope.importScripts('coach.js');
  scope.onmessage = function (event) {
    const request = event.data || {};
    try {
      const result = scope.PixelCoachCore.analyze(request.view, request.options || {});
      scope.postMessage({id: request.id, result});
    } catch (error) {
      scope.postMessage({id: request.id, error: error && error.message ? error.message : String(error)});
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
