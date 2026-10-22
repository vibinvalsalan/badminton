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

// Players can only remove a name while the session is MORE than this many
// hours away. Inside the window (or once it has started), only admins can.
export const REMOVAL_LOCK_HOURS = 24;

// `date` is a TEXT column (YYYY-MM-DD) and start_time is HH:MM[:SS], so the
// session start is built from both and read in the browser's local time.
export function isRemovalLocked(session) {
    if (!session || !session.date) return false;
    let time = (session.start_time || '00:00:00').slice(0, 8);
    if (time.length === 5) time += ':00';
    const start = new Date(`${session.date}T${time}`);
    if (isNaN(start.getTime())) return true; // unparseable: fail closed
    return (start.getTime() - Date.now()) <= REMOVAL_LOCK_HOURS * 60 * 60 * 1000;
}

export function canRemove(session) {
    return state.isAdmin || !isRemovalLocked(session);
}

export const LOCKED_REMOVAL_MESSAGE =
    `Names can only be removed more than ${REMOVAL_LOCK_HOURS} hours before the session. ` +
    `Please contact an admin if you can no longer make it.`;

// Shown when a player taps the lock icon (or otherwise tries to remove a
// name inside the 24h window).
export function showRemovalLocked() {
    return Swal.fire({
        icon: 'info',
        title: 'Removal locked',
        text: LOCKED_REMOVAL_MESSAGE,
        confirmButtonText: 'OK',
        confirmButtonColor: '#2563eb',
        customClass: { popup: 'rounded-3xl', confirmButton: 'rounded-xl px-6 py-3 text-sm font-bold uppercase' }
    });
}

export function renderPlayerRow(p, s) {
    const removeControl = canRemove(s)
        ? `<button onclick="handleRemoval('${p.id}', '${s.id}', '${p.player_name}', '${p.player_id}', '${p.payment_status}')"
                    class="text-gray-300 hover:text-red-500 transition-all p-2 ml-2 rounded-full hover:bg-red-50">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>`
        : `<button onclick="showRemovalLocked()" title="${LOCKED_REMOVAL_MESSAGE}" aria-label="Removal locked" class="text-gray-300 hover:text-gray-500 transition-all p-2 ml-2 rounded-full">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"></path>
                    </svg>
                </button>`;
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
                ${removeControl}
            </div>
        </div>`;
}

// --- Prepaid pay-ins (player_payments / payment_registrations) --------------
// These helpers fail soft: if the lookup errors (e.g. the migration hasn't
// been run yet) they return null, and marking Paid behaves exactly as before.

// Which pay-in (if any) currently covers this registration.
async function getPaymentLink(registrationId) {
    const { data, error } = await _supabase
        .from('payment_registrations')
        .select('id, payment_id')
        .eq('registration_id', registrationId)
        .maybeSingle();
    return error ? null : data;
}

// The player's oldest pay-in that still has sessions left, or null.
async function findOldestPrepaid(playerId) {
    const { data, error } = await _supabase
        .from('player_payments')
        .select('id, amount, sessions_purchased, paid_on, payment_registrations(id)')
        .eq('player_id', playerId)
        .order('paid_on', { ascending: true })
        .order('created_at', { ascending: true });
    if (error || !data) return null;

    const open = data
        .map(p => ({ payment: p, used: p.payment_registrations.length }))
        .filter(x => x.used < x.payment.sessions_purchased);
    if (open.length === 0) return null;

    const { payment, used } = open[0];
    return { payment, used, remaining: payment.sessions_purchased - used };
}

export async function handlePayment(id, currentStatus, onComplete) {
    const newStatus = currentStatus === 'Paid' ? 'Unpaid' : 'Paid';

    const session = state.allData.find(s => s.registrations.some(r => r.id == id));
    const reg = session.registrations.find(r => r.id == id);

    // Admin marking Paid: offer to use one of the player's prepaid sessions.
    // Players marking themselves paid never touch pay-in records.
    let prepaid = null;
    if (newStatus === 'Paid' && state.isAdmin && reg.player_id) {
        const credit = await findOldestPrepaid(reg.player_id);
        if (credit) {
            const choice = await Swal.fire({
                title: 'Use a prepaid session?',
                html: `<b>${reg.player_name}</b> has <b>${credit.remaining}</b> prepaid session${credit.remaining === 1 ? '' : 's'} left
                       <br><small class="text-gray-500">£${Number(credit.payment.amount).toFixed(2)} for ${credit.payment.sessions_purchased} sessions, paid ${credit.payment.paid_on.split('-').reverse().join('/')}. This would be session ${credit.used + 1} of ${credit.payment.sessions_purchased}.</small>`,
                icon: 'question',
                showDenyButton: true,
                showCancelButton: true,
                confirmButtonText: 'Yes, use prepaid',
                denyButtonText: 'No, mark paid normally',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#2563eb',
                denyButtonColor: '#6b7280',
                cancelButtonColor: '#9ca3af',
                customClass: { popup: 'rounded-3xl' }
            });
            if (choice.isDismissed) return; // Cancel: change nothing
            if (choice.isConfirmed) prepaid = credit;
        }
    }

    // Reverting to Unpaid: if a pay-in covers this registration, release it.
    let existingLink = null;
    if (newStatus === 'Unpaid') {
        existingLink = await getPaymentLink(id);
        if (existingLink && !state.isAdmin) {
            Swal.fire({
                icon: 'info',
                title: 'Covered by a prepaid payment',
                text: 'This session was paid from a prepaid bundle. Please ask an admin if it needs changing.',
                customClass: { popup: 'rounded-3xl' }
            });
            return;
        }
    }

    const { error } = await _supabase.from('registrations')
        .update({ payment_status: newStatus })
        .eq('id', id);

    if (!error) {
        let linkNote = '';

        if (prepaid) {
            const { error: linkError } = await _supabase.from('payment_registrations').insert([{
                payment_id: prepaid.payment.id,
                registration_id: id,
                linked_by: state.adminName
            }]);
            if (linkError) {
                // Don't leave it Paid-but-unlinked after the admin chose prepaid.
                await _supabase.from('registrations').update({ payment_status: currentStatus }).eq('id', id);
                Swal.fire('Error', 'Could not use the prepaid session, so nothing was changed. Please try again.', 'error');
                return;
            }
            linkNote = ` using a prepaid session (${prepaid.used + 1} of ${prepaid.payment.sessions_purchased})`;
        }

        if (existingLink) {
            await _supabase.from('payment_registrations').delete().eq('id', existingLink.id);
            linkNote = ' (prepaid session returned)';
        }

        const action = newStatus === 'Paid' ? 'PLAYER_PAID' : 'PLAYER_UNPAID';
        const actionVerb = state.isAdmin ? `${state.adminName} updated ${reg.player_name} as` : `${reg.player_name} marked as`;
        const detailMsg = `${actionVerb} ${newStatus}${linkNote} for session on ${session.date}`;

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
async function reassignPlayerToNextSession(playerId, playerName, excludeSessionId, performer, paymentId = null) {
    if (!playerId) {
        return { success: false, reason: "no linked player record on that registration, couldn't auto-move them." };
    }

    const today = new Date().setHours(0, 0, 0, 0);

    // A pre-paid player must only roll FORWARD. Without this, any upcoming
    // session with space qualified, including one earlier than the session
    // they were just removed from. `date` is YYYY-MM-DD text and start_time
    // is HH:MM[:SS], so a "date|time" string compares chronologically.
    const startKey = s => `${s.date}|${(s.start_time || '00:00').slice(0, 5)}`;
    const removedFrom = state.allData.find(s => s.id === excludeSessionId);
    const removedKey = removedFrom ? startKey(removedFrom) : null;

    const candidates = state.allData
        .filter(s => s.id !== excludeSessionId)
        .filter(s => s.status === 'Scheduled')
        .filter(s => new Date(s.date).setHours(0, 0, 0, 0) >= today)
        .filter(s => !removedKey || startKey(s) > removedKey)
        .filter(s => s.players.length < s.capacity)
        // Skip sessions with a waitlist: those free spots belong to the
        // people already queued, so a transfer must not jump ahead of them.
        .filter(s => s.waitlist.length === 0)
        .filter(s => !s.players.some(p => p.player_id == playerId) && !s.waitlist.some(p => p.player_id == playerId))
        .sort((a, b) => new Date(a.date) - new Date(b.date) || (a.start_time || '').localeCompare(b.start_time || ''));

    const target = candidates[0];
    if (!target) {
        return { success: false, reason: 'no later session with a free spot (and no waitlist) was found -- add them manually later.' };
    }

    const { data: newReg, error } = await _supabase.from('registrations').insert([{
        session_id: target.id,
        player_id: playerId,
        player_name: playerName,
        status: 'Confirmed',
        payment_status: 'Paid'
    }]).select('id').single();

    if (error) {
        return { success: false, reason: 'removed, but could not add them to the next session -- add them manually.' };
    }

    // If the session they left was covered by a prepaid pay-in, the same
    // pay-in now covers the new session, so its used count stays the same.
    let carried = false;
    if (paymentId && newReg) {
        const { error: linkError } = await _supabase.from('payment_registrations').insert([{
            payment_id: paymentId,
            registration_id: newReg.id,
            linked_by: performer
        }]);
        carried = !linkError;
    }

    const displayTime = (target.start_time && target.end_time)
        ? `${formatTime12Hour(target.start_time)} - ${formatTime12Hour(target.end_time)}`
        : 'N/A';

    await logAction(
        'PLAYER_JOINED_SESSION',
        `${performer} moved ${playerName} to session on ${target.date} (${displayTime}) after removal from a previous session (pre-paid transfer${carried ? ', prepaid session carried over' : ''})`,
        playerName,
        target.id,
        playerId
    );

    return { success: true, session: target, carried, linkFailed: !!paymentId && !carried };
}

export async function handleRemoval(regId, sid, name, playerId, paymentStatus, onComplete) {
    // Re-checked here (not just when the button is drawn) because the page
    // may have been open for hours and the 24h window can open in between.
    const targetSession = state.allData.find(s => s.id === sid);
    if (!canRemove(targetSession)) {
        await showRemovalLocked();
        return;
    }

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

        // Read the prepaid link BEFORE deleting: deleting the registration
        // removes its link row automatically, which is what gives the session
        // credit back to the pay-in.
        const prepaidLink = await getPaymentLink(regId);

        const { error } = await _supabase.from('registrations').delete().eq('id', regId);

        if (!error) {
            await logAction('PLAYER_REMOVED', prepaidLink ? `${logDetails} (prepaid session returned)` : logDetails, name, sid);

            const wantsReassign = result.value && result.value.reassign;
            const reassignResult = wantsReassign
                ? await reassignPlayerToNextSession(playerId, name, sid, performer, prepaidLink ? prepaidLink.payment_id : null)
                : null;

            if (onComplete) await onComplete();

            if (reassignResult && reassignResult.success) {
                Swal.fire({
                    toast: true, position: 'top', icon: reassignResult.linkFailed ? 'warning' : 'success',
                    title: `Removed & moved to ${formatDateWithDay(reassignResult.session.date)}` +
                        (reassignResult.carried ? ' (prepaid session carried over)' : '') +
                        (reassignResult.linkFailed ? '. Could not carry over the prepaid link, please check Payments.' : ''),
                    showConfirmButton: false, timer: reassignResult.linkFailed ? 4500 : 2500
                });
            } else if (reassignResult && !reassignResult.success) {
                Swal.fire({
                    toast: true, position: 'top', icon: 'warning',
                    title: `Removed. ${reassignResult.reason}` + (prepaidLink ? ' Their prepaid session was returned.' : ''),
                    showConfirmButton: false, timer: 3500
                });
            } else {
                Swal.fire({
                    toast: true, position: 'top', icon: 'success',
                    title: prepaidLink ? 'Player removed (prepaid session returned)' : 'Player removed successfully',
                    showConfirmButton: false, timer: prepaidLink ? 2500 : 1500
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

    // Read the live registrations rather than trusting state.allData, which
    // can be hours stale if the page was left open (e.g. a spot has since
    // opened, or someone else joined the waitlist).
    const { data: current, error: checkError } = await _supabase
        .from('registrations')
        .select('player_id, status')
        .eq('session_id', session.id);

    if (checkError) {
        Swal.fire('Error', 'Could not check availability. Please try again.', 'error');
        return;
    }

    const confirmedCount = current.filter(r => r.status === 'Confirmed').length;
    const waitlistCount = current.filter(r => r.status === 'Waitlist').length;

    // Checks the waitlist too, so someone already queued can't join twice.
    const isAlreadyRegistered = current.some(r => r.player_id == player.id);

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

    // First come, first served: a free spot goes to the waitlist first, so
    // anyone added (player or admin) is only confirmed if there is room AND
    // nobody is queued. Otherwise they join the waitlist, and an admin can
    // use Promote to move anyone from the waitlist into a free spot.
    const spotFree = confirmedCount < session.capacity;
    const status = (spotFree && waitlistCount === 0) ? 'Confirmed' : 'Waitlist';
    const jumpedQueueBlocked = status === 'Waitlist' && spotFree;

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
            : jumpedQueueBlocked
                ? 'A spot is free, but players already on the waiting list get it first. You are on the list - check again soon!'
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
