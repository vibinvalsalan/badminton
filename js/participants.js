// js/participants.js
// Functions for managing players within a session (mark paid, remove,
// promote from waitlist). Used by both the admin session views and the
// player-facing session detail page — behaviour branches on state.isAdmin
// exactly as it did in the original SPA, it's just no longer assumed that
// admin-only call sites are the only ones that can reach these functions.

import { _supabase } from './supabase-client.js';
import { state } from './state.js';
import { logAction } from './audit.js';

export function renderPlayerRow(p, s) {
    return `
        <div class="group flex justify-between items-center p-3 rounded-xl hover:bg-gray-50 transition-colors border border-transparent">
            <span class="font-semibold text-gray-700">${p.player_name}</span>
            <div class="flex items-center gap-4">
                ${p.payment_status === 'Paid' ? `
                    <button onclick="handlePayment('${p.id}', '${p.payment_status}')"
                        class="flex items-center gap-1 text-[10px] px-3 py-1.5 rounded-lg font-black bg-green-100 text-green-700 border border-green-200 uppercase">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
                        Paid
                    </button>
                ` : `
                    <button onclick="handlePayment('${p.id}', '${p.payment_status}')"
                        class="text-[10px] px-3 py-1.5 rounded-lg font-black bg-blue-600 text-white shadow-sm uppercase tracking-tighter">
                        Mark Paid
                    </button>
                `}
                <button onclick="handleRemoval('${p.id}', '${s.id}', '${p.player_name}')"
                    class="text-gray-300 hover:text-red-500 transition-all p-2 ml-2 rounded-full hover:bg-red-50">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
        </div>`;
}

export async function handlePayment(id, currentStatus, onComplete) {
    const newStatus = currentStatus === 'Paid' ? 'Unpaid' : 'Paid';

    const session = state.allData.find(s => s.registrations.some(r => r.id == id));
    const reg = session.registrations.find(r => r.id == id);

    const { error } = await _supabase.from('registrations')
        .update({ payment_status: newStatus })
        .eq('id', id);

    if (!error) {
        const action = newStatus === 'Paid' ? 'PLAYER_PAID' : 'PLAYER_UNPAID';
        const actionVerb = state.isAdmin ? `${state.adminName} updated ${reg.player_name} as` : `${reg.player_name} marked as`;
        const detailMsg = `${actionVerb} ${newStatus} for session on ${session.date}`;

        await logAction(action, detailMsg, reg.player_name, session.id, reg.player_id);
        if (onComplete) await onComplete();
    } else {
        Swal.fire('Error', 'Could not update payment status', 'error');
    }
}

export async function handleRemoval(regId, sid, name, onComplete) {
    const result = await Swal.fire({
        title: 'Remove Player?',
        html: `Are you sure you want to remove <b>${name}</b>?<br><small class="text-gray-500">This will free up their spot for someone else.</small>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Yes, remove them',
        cancelButtonText: 'Keep on list',
        reverseButtons: true,
        customClass: {
            popup: 'rounded-3xl',
            confirmButton: 'rounded-xl px-6 py-3 text-sm font-bold uppercase',
            cancelButton: 'rounded-xl px-6 py-3 text-sm font-bold uppercase'
        }
    });

    if (result.isConfirmed) {
        const session = state.allData.find(s => s.id === sid);
        const performer = state.isAdmin ? state.adminName : "User";
        // NOTE: original code referenced `session.time`, which does not exist
        // on the session object (it's start_time/end_time). Preserved as-is
        // from the source SPA; session.time will render as `undefined`.
        const logDetails = session
            ? `${performer} removed ${name} from session on ${session.date} (${session.time})`
            : `${performer} removed ${name} from session ID: ${sid}`;

        const { error } = await _supabase.from('registrations').delete().eq('id', regId);

        if (!error) {
            await logAction('PLAYER_REMOVED', logDetails, name, sid);
            if (onComplete) await onComplete();
            Swal.fire({
                toast: true, position: 'top', icon: 'success',
                title: 'Player removed successfully', showConfirmButton: false, timer: 1500
            });
        } else {
            Swal.fire('Error', 'Could not remove player. Please try again.', 'error');
        }
    }
}

export async function promoteFromWaitlist(regId, sid, name, onComplete) {
    if (!state.isAdmin) {
        Swal.fire('Access Denied', 'Only admins can promote players.', 'error');
        return;
    }

    const session = state.allData.find(s => s.id === sid);
    const spotsLeft = session.capacity - session.players.length;

    if (spotsLeft <= 0) {
        Swal.fire({
            title: 'No Slots Available',
            text: `The session is full. You must remove someone from the confirmed list first.`,
            icon: 'error',
            confirmButtonColor: '#2563eb',
            customClass: { popup: 'rounded-3xl' }
        });
        return;
    }

    const { error } = await _supabase
        .from('registrations')
        .update({ status: 'Confirmed' })
        .eq('id', regId);

    if (!error) {
        await logAction('PLAYER_PROMOTED', `${state.adminName} promoted ${name} to confirmed list`, name, sid);
        Swal.fire({
            toast: true, position: 'top', icon: 'success',
            title: `${name} promoted!`, showConfirmButton: false, timer: 2000
        });
        if (onComplete) await onComplete();
    }
}
