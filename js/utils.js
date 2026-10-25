// js/utils.js
// Small helpers shared by every page. Before this existed, `esc` and the
// date helpers were copy-pasted (or missing) page by page.

// Escapes text for safe use inside innerHTML, including inside quoted
// attribute values (it escapes both quote characters).
export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// YYYY-MM-DD for a Date in the visitor's LOCAL time zone.
// `date.toISOString().split('T')[0]` is UTC, so during British Summer Time it
// returns the previous day for the first hour after midnight, and for any
// local-midnight date such as "last day of the month".
export function localDateStr(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function todayStr() {
    return localDateStr(new Date());
}

export function daysAgoStr(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return localDateStr(d);
}

export function lastDayOfMonthStr(date = new Date()) {
    return localDateStr(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}
