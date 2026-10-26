// js/audit.js
import { _supabase } from './supabase-client.js';

import { todayStr, esc } from './utils.js';

// session_info is a UUID column; only pass it through if it looks like one.
function buildLogRow(action, details, playerName = null, sessionId = null, playerId = null) {
    return {
        action: action,
        details: details,
        player_name: playerName,
        player_id: playerId,
        session_info: (sessionId && sessionId.length === 36) ? sessionId : null
    };
}

export async function logAction(action, details, playerName = null, sessionId = null, playerId = null) {
    try {
        const { error } = await _supabase.from('audit_logs').insert([buildLogRow(action, details, playerName, sessionId, playerId)]);
        if (error) throw error;
    } catch (err) {
        console.error("Audit Log failed:", err.message);
    }
}

// Writes many audit entries in ONE request instead of one request each.
// entries: [{ action, details, playerName, sessionId, playerId }]
export async function logActions(entries) {
    if (!entries || entries.length === 0) return;
    try {
        const rows = entries.map(e => buildLogRow(e.action, e.details, e.playerName ?? null, e.sessionId ?? null, e.playerId ?? null));
        const { error } = await _supabase.from('audit_logs').insert(rows);
        if (error) throw error;
    } catch (err) {
        console.error("Audit Log (batch) failed:", err.message);
    }
}

// Returns a persistent visitor ID stored in localStorage, creating one on
// first visit. Unlike sessionStorage (cleared when a tab closes), this
// survives across browser restarts and days, which is what makes it
// possible to tell a returning visitor apart from a brand-new one.
// Caveat: this identifies a browser profile, not a person — switching
// devices/browsers or clearing site data creates a new ID.
function getOrCreateVisitorId() {
    let id = localStorage.getItem('visitorId');
    if (!id) {
        id = 'V-' + Math.random().toString(36).substr(2, 9).toUpperCase();
        localStorage.setItem('visitorId', id);
    }
    return id;
}

function detectDeviceType() {
    const ua = navigator.userAgent;
    if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
    if (ua.includes("Android")) return "Android";
    if (ua.includes("Chrome")) return "Chrome (Desktop)";
    if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari (Desktop)";
    if (ua.includes("Firefox")) return "Firefox (Desktop)";
    return "Unknown";
}

export async function logVisit() {
    const visitorId = getOrCreateVisitorId();
    const deviceType = detectDeviceType();
    const today = todayStr(); // local YYYY-MM-DD (toISOString is UTC and goes a day behind in BST)

    // Log at most once per calendar day per visitor, so leaving a tab open
    // doesn't inflate counts but returning tomorrow does register as a visit.
    const lastLoggedDate = localStorage.getItem('lastVisitLoggedDate');
    if (lastLoggedDate === today) return;

    const details = `Visitor: ${visitorId} | ${deviceType} | ${screen.width}x${screen.height}`;

    try {
        const { error } = await _supabase.from('audit_logs').insert([{
            action: 'UNIQUE_ACCESS',
            details: details,
            player_name: 'Visitor',
            player_id: null,
            session_info: null,
            visitor_id: visitorId,
            device_type: deviceType
        }]);
        if (error) throw error;
        localStorage.setItem('lastVisitLoggedDate', today);
    } catch (err) {
        console.error("Visit log failed:", err.message);
    }
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
                <span class="font-black text-blue-500 uppercase">${esc(log.action.replace(/_/g, ' '))}</span>
                <span class="text-gray-300">${new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <p class="text-gray-600 leading-tight">${esc(log.details)}</p>
        </div>
    `).join('');
}
