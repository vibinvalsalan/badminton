// js/participants.js
// Functions for managing players within a session (mark paid, remove,
// promote from waitlist). Used by both the admin session views and the
// player-facing session detail page — behaviour branches on state.isAdmin
// exactly as it did in the original SPA, it's just no longer assumed that
// admin-only call sites are the only ones that can reach these functions.

import { _supabase } from './supabase-client.js';
import { state } from './state.js';
import { logAction } from './audit.js';
import { formatTime12Hour, formatDateWithDay } from './format.js';

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
                <button onclick="handleRemoval('${p.id}', '${s.id}', '${p.player_name}', '${p.player_id}', '${p.payment_status}')"
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

// Finds the nearest upcoming Scheduled session (hidden sessions included --
// admins routinely bulk-add players before a session is revealed, so those
// count as valid transfer targets) that has a free confirmed spot and where
// this player isn't already confirmed or waitlisted, then registers them
// there as Paid. Used by handleRemoval when transferring a pre-paid player
// who dropped from a session. Does not fall back to waitlisting a full
// session -- it skips forward to the next one with room instead.
async function reassignPlayerToNextSession(playerId, playerName, excludeSessionId, performer) {
    if (!playerId) {
        return { success: false, reason: "no linked player record on that registration, couldn't auto-move them." };
    }

    const today = new Date().setHours(0, 0, 0, 0);

    const candidates = state.allData
        .filter(s => s.id !== excludeSessionId)
        .filter(s => s.status === 'Scheduled')
        .filter(s => new Date(s.date).setHours(0, 0, 0, 0) >= today)
        .filter(s => s.players.length < s.capacity)
        .filter(s => !s.players.some(p => p.player_id == playerId) && !s.waitlist.some(p => p.player_id == playerId))
        .sort((a, b) => new Date(a.date) - new Date(b.date) || (a.start_time || '').localeCompare(b.start_time || ''));

    const target = candidates[0];
    if (!target) {
        return { success: false, reason: 'no upcoming session with a free spot was found -- add them manually later.' };
    }

    const { error } = await _supabase.from('registrations').insert([{
        session_id: target.id,
        player_id: playerId,
        player_name: playerName,
        status: 'Confirmed',
        payment_status: 'Paid'
    }]);

    if (error) {
        return { success: false, reason: 'removed, but could not add them to the next session -- add them manually.' };
    }

    const displayTime = (target.start_time && target.end_time)
        ? `${formatTime12Hour(target.start_time)} - ${formatTime12Hour(target.end_time)}`
        : 'N/A';

    await logAction(
        'PLAYER_JOINED_SESSION',
        `${performer} moved ${playerName} to session on ${target.date} (${displayTime}) after removal from a previous session (pre-paid transfer)`,
        playerName,
        target.id,
        playerId
    );

    return { success: true, session: target };
}

export async function handleRemoval(regId, sid, name, playerId, paymentStatus, onComplete) {
    const isPaid = paymentStatus === 'Paid';

    const result = await Swal.fire({
        title: 'Remove Player?',
        html: `
            Are you sure you want to remove <b>${name}</b>?<br><small class="text-gray-500">This will free up their spot for someone else.</small>
            ${isPaid ? `
                <label class="flex items-center gap-2 mt-4 p-3 bg-blue-50 rounded-xl text-sm text-left cursor-pointer">
                    <input type="checkbox" id="reassign-checkbox" checked class="w-4 h-4 accent-blue-600 flex-shrink-0">
                    <span>They've already paid -- move them to the next available session</span>
                </label>
            ` : ''}
        `,
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
        },
        preConfirm: () => {
            const cb = document.getElementById('reassign-checkbox');
            return { reassign: isPaid && !!cb && cb.checked };
        }
    });

    if (result.isConfirmed) {
        const session = state.allData.find(s => s.id === sid);
        const performer = state.isAdmin ? state.adminName : "User";

        // Fixed: previously referenced `session.time`, which doesn't exist
        // on the session object (it's start_time/end_time), so this always
        // logged "undefined" for the time. Now built the same way every
        // other audit message in this file does.
        const displayTime = session && session.start_time && session.end_time
            ? `${formatTime12Hour(session.start_time)} - ${formatTime12Hour(session.end_time)}`
            : 'N/A';

        const logDetails = session
            ? `${performer} removed ${name} from session on ${session.date} (${displayTime})`
            : `${performer} removed ${name} from session ID: ${sid}`;

        const { error } = await _supabase.from('registrations').delete().eq('id', regId);

        if (!error) {
            await logAction('PLAYER_REMOVED', logDetails, name, sid);

            const wantsReassign = result.value && result.value.reassign;
            const reassignResult = wantsReassign
                ? await reassignPlayerToNextSession(playerId, name, sid, performer)
                : null;

            if (onComplete) await onComplete();

            if (reassignResult && reassignResult.success) {
                Swal.fire({
                    toast: true, position: 'top', icon: 'success',
                    title: `Removed & moved to ${formatDateWithDay(reassignResult.session.date)}`,
                    showConfirmButton: false, timer: 2500
                });
            } else if (reassignResult && !reassignResult.success) {
                Swal.fire({
                    toast: true, position: 'top', icon: 'warning',
                    title: `Removed. ${reassignResult.reason}`,
                    showConfirmButton: false, timer: 3500
                });
            } else {
                Swal.fire({
                    toast: true, position: 'top', icon: 'success',
                    title: 'Player removed successfully', showConfirmButton: false, timer: 1500
                });
            }
        } else {
            Swal.fire('Error', 'Could not remove player. Please try again.', 'error');
        }
    }
}

export async function joinSession(onComplete) {
    const playerId = document.getElementById('join-player-id').value;
    const player = state.masterPlayers.find(p => p.id == playerId);
    const session = state.allData.find(s => s.id === state.currentSessionId);

    if (!player || !session) return;

    const isAlreadyRegistered = session.players.some(p => p.player_id == player.id);

    if (isAlreadyRegistered) {
        Swal.fire({
            title: 'Already Registered',
            text: `${player.name} is already on the list for this session!`,
            icon: 'warning',
            confirmButtonColor: '#2563eb',
            customClass: { popup: 'rounded-3xl' }
        });
        return;
    }

    const status = session.players.length >= session.capacity ? 'Waitlist' : 'Confirmed';

    const { error } = await _supabase.from('registrations').insert([{
        session_id: session.id,
        player_id: player.id,
        player_name: player.name,
        status: status,
        payment_status: 'Unpaid'
    }]);

    const displayTime = (session.start_time && session.end_time)
        ? `${formatTime12Hour(session.start_time)} - ${formatTime12Hour(session.end_time)}`
        : 'N/A';

    if (!error) {
        const actionVerb = state.isAdmin ? `${state.adminName} added ${player.name} to` : `${player.name} joined`;
        const logMessage = `${actionVerb} session on ${session.date} (${displayTime}), Status: ${status}`;
        await logAction('PLAYER_JOINED_SESSION', logMessage, player.name, session.id);

        const isConfirmed = status === 'Confirmed';
        const modalIcon = isConfirmed ? 'success' : 'warning';
        const footerText = isConfirmed
            ? 'See you on the court!'
            : 'You are now in the waiting list , Check again to see if a spot opens up!';

        Swal.fire({
            title: isConfirmed ? 'Booking Confirmed!' : 'Added to Waitlist',
            html: `
                <div class="text-left bg-gray-50 p-4 rounded-2xl mt-2 text-sm">
                    <p class="mb-1"><strong>Player:</strong> ${player.name}</p>
                    <p class="mb-1"><strong>Session:</strong> ${displayTime}</p>
                    <p class="mb-1"><strong>Date:</strong> ${formatDateWithDay(session.date)}</p>
                    <p><strong>Venue:</strong> ${session.location}</p>
                </div>
                <p class="mt-4 text-xs text-gray-400 font-bold uppercase tracking-widest">${footerText}</p>
            `,
            icon: modalIcon,
            confirmButtonText: isConfirmed ? 'Great!' : 'Understood',
            confirmButtonColor: '#2563eb',
            customClass: {
                popup: 'rounded-3xl',
                confirmButton: 'rounded-xl px-8 py-3 uppercase font-black text-xs'
            }
        });

        if (onComplete) await onComplete();
    }
}

export function toggleJoinButton() {
    const hiddenId = document.getElementById('join-player-id');
    const visibleInput = document.getElementById('join-player-search');
    const btn = document.getElementById('join-btn');
    const errorMsg = document.getElementById('join-error');

    if (hiddenId.value) {
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
        btn.disabled = false;
        if (visibleInput) visibleInput.classList.remove('border-red-500');
        errorMsg.classList.add('hidden');
    } else {
        btn.classList.add('opacity-50', 'cursor-not-allowed');
        btn.disabled = true;
    }
}

export function validateAndJoin(onComplete) {
    const hiddenId = document.getElementById('join-player-id');
    const visibleInput = document.getElementById('join-player-search');
    if (!hiddenId.value) {
        if (visibleInput) {
            visibleInput.classList.add('border-red-500', 'animate-pulse');
            setTimeout(() => visibleInput.classList.remove('animate-pulse'), 500);
        }
        document.getElementById('join-error').classList.remove('hidden');
        return;
    }
    joinSession(onComplete);
}

export function filterPlayers(status) {
    const s = state.allData.find(x => x.id === state.currentSessionId);
    if (!s) return;

    const types = ['all', 'paid', 'unpaid'];
    types.forEach(type => {
        const btn = document.getElementById(`btn-filter-${type}`);
        if (!btn) return;
        if (type === status.toLowerCase()) {
            btn.classList.add('bg-white', 'shadow-sm');
            btn.classList.remove('text-gray-500');
        } else {
            btn.classList.remove('bg-white', 'shadow-sm');
            btn.classList.add('text-gray-500');
        }
    });

    const filtered = status === 'all'
        ? s.players
        : s.players.filter(p => p.payment_status === status);

    const container = document.getElementById('participants-list-container');
    if (container) {
        container.innerHTML = filtered.map(p => renderPlayerRow(p, s)).join('');
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
