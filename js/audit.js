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

export async function toggleSessionLogs(sid) {
    const container = document.getElementById(`session-log-container-${sid}`);
    const chevron = document.getElementById(`log-chevron-${sid}`);

    if (!container.classList.contains('hidden')) {
        container.classList.add('hidden');
        chevron.innerText = "+ Show";
        return;
    }

    container.classList.remove('hidden');
    chevron.innerText = "- Hide";

    const { data, error } = await _supabase
        .from('audit_logs')
        .select('*')
        .eq('session_info', sid)
        .order('created_at', { ascending: false });

    if (error) {
        container.innerHTML = `<p class="text-red-400 text-[10px]">Error loading logs.</p>`;
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = `<p class="text-center text-gray-400 text-[10px] py-4 uppercase font-bold">No activity recorded yet</p>`;
        return;
    }

    container.innerHTML = data.map(log => `
        <div class="bg-gray-50 p-2.5 rounded-xl text-[10px] border border-gray-100">
            <div class="flex justify-between mb-1">
                <span class="font-black text-blue-500 uppercase">${log.action.replace(/_/g, ' ')}</span>
                <span class="text-gray-300">${new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <p class="text-gray-600 leading-tight">${log.details}</p>
        </div>
    `).join('');
}
