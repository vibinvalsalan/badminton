// js/whatsapp.js
import { state, VENUES } from './state.js';
import { formatDateWithDay, formatTime12Hour } from './format.js';

export function copyToWhatsApp() {
    const s = state.allData.find(x => x.id === state.currentSessionId);
    if (!s) return;

    const pList = s.players.map((p, i) => `${i + 1}. ${p.player_name}${p.payment_status === 'Paid' ? ' *Paid*' : ''}`).join('\n');
    const wList = s.waitlist.length > 0 ? `\n\n*Waitlist:*\n${s.waitlist.map((p, i) => `W${i + 1}. ${p.player_name}`).join('\n')}` : '';
    const instruction = s.special_instruction ? `\n⚠️ *Note:* ${s.special_instruction}` : '';

    const venueInfo = VENUES.find(v => v.name === s.location);

    // NOTE: original SPA code referenced an undefined `session` variable in
    // this fallback branch (should have been `s.location`). Preserved as-is;
    // this line will throw a ReferenceError if venueInfo isn't found, i.e.
    // whenever a session's location string doesn't exactly match a VENUES
    // entry name (e.g. legacy sessions, or any free-text location).
    const locationDetails = venueInfo
        ? `${venueInfo.name}\n${venueInfo.address}`
        : session.location;

    const formattedStart = formatTime12Hour(s.start_time);
    const formattedEnd = formatTime12Hour(s.end_time);
    const displayTime = (s.start_time && s.end_time) ? `${formattedStart} - ${formattedEnd}` : 'N/A';

    let msg = `🏸 *BADMINTON*\n📅 *Date:* ${formatDateWithDay(s.date)}\n⏰ *Time:* ${displayTime}\n📍 *Loc:* ${locationDetails}\n💰 *Fee:* ${s.fee}\n🏦 *Pay to:* \n${s.payment_method || 'Contact Admin'}\n\n*Confirmed:*\n${pList || '_None_'}${wList}\n\n${instruction}`;

    msg += `\n\nClick the link below to join or drop from session:\n${window.location.origin}/session.html?session=${s.id}`;
    navigator.clipboard.writeText(msg).then(() => Swal.fire({ toast: true, position: 'top', icon: 'success', title: 'Copied to clipboard!', showConfirmButton: false, timer: 1500 }));
}
