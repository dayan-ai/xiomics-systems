/*!
 * Applies the central booking URL from assets/js/site-config.js to every <a data-booking-link>,
 * and makes sure each one opens in a new tab safely. No network requests, no dependencies.
 * Without JavaScript the buttons still work: their href is the dedicated Topmate discovery-call service page.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (root && root.document) {
    api.apply(root.document, root.XIOMICS_SITE);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Only https Topmate pages (letters, digits, _ - / in the path) are accepted.
  var SAFE_BOOKING_URL = /^https:\/\/topmate\.io\/[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*\/?$/;

  function isSafeBookingUrl(url) {
    return typeof url === 'string' && SAFE_BOOKING_URL.test(url);
  }

  /** @returns {number} how many links received the configured URL */
  function apply(doc, config) {
    var url = config && config.bookingUrl;
    var useConfigured = isSafeBookingUrl(url);
    var links = doc.querySelectorAll('a[data-booking-link]');
    var updated = 0;
    for (var i = 0; i < links.length; i += 1) {
      if (useConfigured) {
        links[i].setAttribute('href', url);
        updated += 1;
      }
      links[i].setAttribute('target', '_blank');
      links[i].setAttribute('rel', 'noopener noreferrer');
    }
    return updated;
  }

  return { isSafeBookingUrl: isSafeBookingUrl, apply: apply };
});
