// js/auth-guard.js
// Call requireAdmin() at the very top of every admin-*.html page's module
// script, before rendering anything. If the visitor isn't logged in, this
// redirects them to admin-login.html?redirect=<this page>, which (on
// successful password entry) sends them straight back here.
//
// This is a client-side convenience gate only — it relies on a localStorage
// flag, not a real server-verified session, exactly like the original SPA.
// It stops casual navigation, not a determined attacker. (See note in
// admin-login.html about the underlying password-check design.)

import { state } from './state.js';

export function requireAdmin() {
    state.isAdmin = localStorage.getItem('isAdmin') === 'true';
    state.adminName = localStorage.getItem('adminName');

    if (!state.isAdmin || !state.adminName) {
        const here = window.location.pathname + window.location.search;
        window.location.href = `admin-login.html?redirect=${encodeURIComponent(here)}`;
        return false;
    }
    return true;
}

export function logoutAdmin() {
    localStorage.removeItem('isAdmin');
    localStorage.removeItem('adminName');
    window.location.href = 'admin-login.html';
}
