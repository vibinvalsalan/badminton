// js/data.js
import { _supabase } from './supabase-client.js';
import { state } from './state.js';

// Fetches sessions (+ their registrations) and the master player list,
// and populates state.allData / state.masterPlayers.
// Every page that needs this data now calls it independently on load,
// since pages no longer share a JS global scope the way SPA views did.
export async function loadData() {
    const { data: sData, error } = await _supabase
        .from('sessions')
        .select('*, registrations(*)')
        .eq('is_deleted', false)
        .order('created_at', { foreignTable: 'registrations', ascending: true });

    if (error) {
        console.error("Fetch error:", error);
        return;
    }

    const { data: pData } = await _supabase.from('players').select('*').order('name');
    state.masterPlayers = pData || [];

    state.allData = (sData || []).map(s => ({
        ...s,
        players: (s.registrations || []).filter(r => r.status === 'Confirmed'),
        waitlist: (s.registrations || []).filter(r => r.status === 'Waitlist')
    }));
}
