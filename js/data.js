// js/data.js
import { _supabase } from './supabase-client.js';
import { state } from './state.js';

// Fetches sessions (+ their registrations) and the master player list,
// and populates state.allData / state.masterPlayers.
// Every page that needs this data now calls it independently on load,
// since pages no longer share a JS global scope the way SPA views did.
//
// The two queries are independent, so they run at the same time instead of
// one after the other (saves a full network round trip on every page load
// and after every action).
//
// Options:
//   fromDate: 'YYYY-MM-DD'. Only load sessions on or after this date. Player
//             pages only ever show upcoming sessions, so they pass today's
//             date and skip downloading the whole history. Admin pages that
//             need history call loadData() with no options.
export async function loadData({ fromDate = null } = {}) {
    let sessionsQuery = _supabase
        .from('sessions')
        .select('*, registrations(*)')
        .eq('is_deleted', false)
        .order('created_at', { foreignTable: 'registrations', ascending: true });

    if (fromDate) sessionsQuery = sessionsQuery.gte('date', fromDate);

    const [{ data: sData, error }, { data: pData }] = await Promise.all([
        sessionsQuery,
        _supabase.from('players').select('*').order('name')
    ]);

    if (error) {
        console.error("Fetch error:", error);
        return;
    }

    state.masterPlayers = pData || [];

    state.allData = (sData || []).map(s => {
        const regs = s.registrations || [];
        return {
            ...s,
            players: regs.filter(r => r.status === 'Confirmed'),
            waitlist: regs.filter(r => r.status === 'Waitlist')
        };
    });
}
