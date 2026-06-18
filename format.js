// js/format.js
// Pure formatting helpers, unchanged from the original SPA logic.

export function formatDateWithDay(dateStr) {
    const dateObj = new Date(dateStr);
    if (isNaN(dateObj.getTime())) return dateStr;
    const day = String(dateObj.getDate()).padStart(2, '0');
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const year = dateObj.getFullYear();
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(dateObj);
    return `${day}-${month}-${year} (${weekday})`;
}

export function formatTime12Hour(timeStr) {
    if (!timeStr) return 'N/A';
    const [hours, minutes] = timeStr.split(':');
    let h = parseInt(hours, 10);
    if (isNaN(h)) return timeStr; // Fallback safely if string isn't clean military
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    return `${h}:${minutes} ${ampm}`;
}
