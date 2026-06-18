// js/audit.js
import { _supabase } from './supabase-client.js';

export async function logAction(action, details, playerName = null, sessionId = null, playerId = null) {
    try {
        // session_info is a UUID column; only pass it through if it looks like one.
        const validSessionId = (sessionId && sessionId.length === 36) ? sessionId : null;

        const { error } = await _supabase.from('audit_logs').insert([{
            action: action,
            details: details,
            player_name: playerName,
            player_id: playerId,
            session_info: validSessionId
        }]);

        if (error) throw error;
    } catch (err) {
        console.error("Audit Log failed:", err.message);
    }
}

export async function logVisit() {
    let browser = "Unknown Browser";
    const ua = navigator.userAgent;

    if (ua.includes("iPhone") || ua.includes("iPad")) browser = "iOS Device";
    else if (ua.includes("Android")) browser = "Android Device";
    else if (ua.includes("Chrome")) browser = "Chrome";
    else if (ua.includes("Safari") && !ua.includes("Chrome")) browser = "Safari";
    else if (ua.includes("Firefox")) browser = "Firefox";

    if (sessionStorage.getItem('access_logged')) return;

    const accessId = 'ACC-' + Math.random().toString(36).substr(2, 9).toUpperCase();
    const specs = { screen: `${screen.width}x${screen.height}` };
    const details = `Access ID: ${accessId} | ${browser} | ${specs.screen} `;

    await logAction('UNIQUE_ACCESS', details, 'Visitor', null);
    sessionStorage.setItem('access_logged', 'true');
}
