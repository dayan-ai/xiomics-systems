/*!
 * Xiomics Systems site configuration: the ONE place to change the booking link.
 *
 * bookingUrl: the Topmate page every "Book a Free Discovery Call" button opens (in a new tab).
 *   This is the dedicated, free "AI Automation Discovery Call" service on Topmate. If that service link
 *   ever changes, replace this URL; nothing else needs editing:
 *   assets/js/booking-links.js applies it to every button marked data-booking-link.
 *   Must be an https://topmate.io/... address, otherwise the buttons keep their built-in link to the service page.
 */
window.XIOMICS_SITE = Object.freeze({
  bookingUrl: 'https://topmate.io/muhammad_dayan/2397800',
  contactEmail: 'contact@xiomics.systems',
});
