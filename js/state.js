// js/state.js
// Replaces the single shared global scope from the old SPA.
// Each page now has its own JS module scope, so any value that used to be
// a top-level `let` in the old <script> tag and was read by more than one
// function now lives here instead, as a small mutable store.
//
// IMPORTANT: because pages no longer share memory, every admin page must
// call refreshData() (from js/data.js) itself on load rather than assuming
// `allData` / `masterPlayers` were already populated by another view.

export const state = {
    allData: [],
    masterPlayers: [],
    currentSessionId: null,
    isAdmin: localStorage.getItem('isAdmin') === 'true',
    adminName: localStorage.getItem('adminName'),
};

// Venue list — previously a const declared mid-file in the SPA (after
// setupVenueDropdown/copyToWhatsApp, but safe due to hoisting). Kept as
// static data here; edit this list to add/remove venues.
export const VENUES = [
    {
        id: "v1",
        name: "Oasis Academy",
        address: "King William St,Media City,M50 3UQ",
        mapUrl: "https://maps.app.goo.gl/2E132EdtgRi1aExw6"
    },
    {
        id: "v2",
        name: "Eccles Leisure Centre",
        address: "Barton Ln, Eccles M30 0DD",
        mapUrl: "https://maps.app.goo.gl/tRYWpChRaL5ij2L67"
    }
];
