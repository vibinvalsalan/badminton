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
import { forfeitAndRemove } from './prepaid.js';
import { esc } from './utils.js';

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

// Inline onclick handlers only carry ids. Names go through the DOM as text and
// are looked up here, so a name containing an apostrophe (O'Brien) can no
// longer break the button, and nothing the user can edit in the page is
// trusted for payment status.
export function findRegistration(sid, regId) {
    const session = state.allData.find(x => x.id === sid);
    if (!session) return null;
    return [...(session.players || []), ...(session.waitlist || [])].find(r => String(r.id) === String(regId)) || null;
}

export function handleRemovalById(regId, sid, onComplete) {
    const reg = findRegistration(sid, regId);
    if (!reg) {
        Swal.fire('Error', 'That player is no longer on the list. Please refresh and try again.', 'error');
        return;
    }
    return handleRemoval(regId, sid, reg.player_name, reg.player_id, reg.payment_status, onComplete);
}

export function promoteFromWaitlistById(regId, sid, onComplete) {
    const reg = findRegistration(sid, regId);
    if (!reg) {
        Swal.fire('Error', 'That player is no longer on the waitlist. Please refresh and try again.', 'error');
        return;
    }
    return promoteFromWaitlist(regId, sid, reg.player_name, onComplete);
}

export function renderPlayerRow(p, s) {
    const removeControl = canRemove(s)
        ? `<button onclick="handleRemoval('${esc(p.id)}', '${esc(s.id)}')"
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
            <span class="font-semibold text-gray-700">${esc(p.player_name)}</span>
            <div class="flex items-center gap-4">
                ${p.payment_status === 'Paid' ? `
                    <button onclick="handlePayment('${esc(p.id)}', '${esc(p.payment_status)}')"
                        class="flex items-center gap-1 text-[10px] px-3 py-1.5 rounded-lg font-black bg-green-100 text-green-700 border border-green-200 uppercase">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>
                        Paid
                    </button>
                ` : `
                    <button onclick="handlePayment('${esc(p.id)}', '${esc(p.payment_status)}')"
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
                html: `<b>${esc(reg.player_name)}</b> has <b>${credit.remaining}</b> prepaid session${credit.remaining === 1 ? '' : 's'} left
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

    // Paid players can't remove themselves. Previously a paid self-removal
    // offered an automatic transfer to the next session (hidden ones
    // included), which players used to jump into hidden sessions. Status is
    // also read from the loaded registration, not just the value passed in
    // from the button, so it can't be sidestepped by editing the markup.
    const registration = targetSession
        ? [...(targetSession.players || []), ...(targetSession.waitlist || [])].find(p => p.id == regId)
        : null;
    const isPaid = paymentStatus === 'Paid' || (!!registration && registration.payment_status === 'Paid');

    if (isPaid && !state.isAdmin) {
        await Swal.fire({
            icon: 'info',
            title: 'Payment already made',
            text: "You can't remove yourself while marked as paid. Mark yourself as unpaid first, or contact an admin to adjust your payment.",
            confirmButtonText: 'OK',
            confirmButtonColor: '#2563eb',
            customClass: { popup: 'rounded-3xl', confirmButton: 'rounded-xl px-6 py-3 text-sm font-bold uppercase' }
        });
        return;
    }

    // Which prepaid credit (if any) covers this registration. Read BEFORE
    // anything is deleted: deleting the registration removes its link row,
    // which is what gives the session credit back to the pay-in.
    const prepaidLink = await getPaymentLink(regId);
    // Only an admin can keep a credit as used (forfeit it) for a No Show /
    // Drop Out. A player removing themselves always returns it.
    const offerForfeit = state.isAdmin && !!prepaidLink;

    const result = await Swal.fire({
        title: 'Remove Player?',
        html: `
            Are you sure you want to remove <b>${esc(name)}</b>?<br><small class="text-gray-500">This will free up their spot for someone else.</small>
            ${offerForfeit ? `
                <div class="mt-4 p-3 bg-amber-50 rounded-xl text-sm text-left space-y-2">
                    <p class="font-bold text-amber-800">This session was paid from a prepaid bundle</p>
                    <label class="flex items-start gap-2 cursor-pointer">
                        <input type="radio" name="prepaid-choice" value="return" checked class="mt-1 accent-blue-600 flex-shrink-0">
                        <span>Return the prepaid session to their balance</span>
                    </label>
                    <label class="flex items-start gap-2 cursor-pointer">
                        <input type="radio" name="prepaid-choice" value="forfeit" class="mt-1 accent-blue-600 flex-shrink-0">
                        <span>Keep it as used (forfeited) and log an infraction</span>
                    </label>
                    <div id="forfeit-extra" class="hidden pl-6 space-y-2">
                        <select id="forfeit-type" class="w-full bg-white border border-gray-200 rounded-lg p-2 text-sm font-bold text-gray-700">
                            <option value="Drop Out">Drop Out</option>
                            <option value="No Show">No Show</option>
                        </select>
                        <input id="forfeit-reason" type="text" placeholder="Reason (optional)" class="w-full bg-white border border-gray-200 rounded-lg p-2 text-sm">
                    </div>
                </div>
            ` : ''}
            ${isPaid && state.isAdmin ? `
                <label class="flex items-center gap-2 mt-4 p-3 bg-blue-50 rounded-xl text-sm text-left cursor-pointer">
                    <input type="checkbox" id="reassign-checkbox" checked class="w-4 h-4 accent-blue-600 flex-shrink-0">
                    <span>They've already paid -- move them to the next available session</span>
                </label>
            ` : ''}
        `,
        didOpen: () => {
            if (!offerForfeit) return;
            // Keeping the credit as used and moving them to another session
            // contradict each other, so choosing "keep" switches the move off.
            const radios = document.querySelectorAll('input[name="prepaid-choice"]');
            const sync = () => {
                const forfeit = document.querySelector('input[name="prepaid-choice"]:checked').value === 'forfeit';
                document.getElementById('forfeit-extra').classList.toggle('hidden', !forfeit);
                const cb = document.getElementById('reassign-checkbox');
                if (cb) {
                    if (forfeit) cb.checked = false;
                    cb.disabled = forfeit;
                }
            };
            radios.forEach(r => r.addEventListener('change', sync));
        },
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
            const choice = offerForfeit ? document.querySelector('input[name="prepaid-choice"]:checked') : null;
            const forfeit = !!choice && choice.value === 'forfeit';
            return {
                reassign: isPaid && state.isAdmin && !forfeit && !!cb && cb.checked,
                forfeit,
                infractionType: forfeit ? document.getElementById('forfeit-type').value : null,
                reason: forfeit ? document.getElementById('forfeit-reason').value.trim() : ''
            };
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

        const wantsForfeit = !!(offerForfeit && result.value && result.value.forfeit);

        // Keep-as-used: log the infraction, detach the credit, then remove the
        // registration (all undone if any step fails). Otherwise a plain
        // delete, which also returns the credit via the database cascade.
        if (wantsForfeit) {
            const forfeit = await forfeitAndRemove({
                link: prepaidLink,
                regId,
                playerId,
                sessionId: sid,
                infractionType: result.value.infractionType,
                reason: result.value.reason || `Removed by ${state.adminName}; prepaid session kept as used.`
            });
            if (!forfeit.ok) {
                Swal.fire('Error', forfeit.message, 'error');
                return;
            }
            await logAction('PLAYER_REMOVED',
                `${logDetails} (prepaid session kept as used, ${result.value.infractionType} logged)`,
                name, sid, playerId || null);
            if (onComplete) await onComplete();
            Swal.fire({
                toast: true, position: 'top', icon: 'success',
                title: `Removed. Prepaid session kept as used and ${result.value.infractionType} logged`,
                showConfirmButton: false, timer: 3000
            });
            return;
        }

        const { error } = await _supabase.from('registrations').delete().eq('id', regId);

        if (!error) {
            await logAction('PLAYER_REMOVED', prepaidLink ? `${logDetails} (prepaid session returned)` : logDetails, name, sid, playerId || null);

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

let joinInFlight = false;

export async function joinSession(onComplete) {
    if (joinInFlight) return;
    joinInFlight = true;
    try {
        await joinSessionInner(onComplete);
    } finally {
        joinInFlight = false;
    }
}

async function joinSessionInner(onComplete) {
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
            text: `${player.name} is already on the list for this session!`, // Swal `text` is not parsed as HTML
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
        await logAction('PLAYER_JOINED_SESSION', logMessage, player.name, session.id, player.id);

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
                    <p class="mb-1"><strong>Player:</strong> ${esc(player.name)}</p>
                    <p class="mb-1"><strong>Session:</strong> ${displayTime}</p>
                    <p class="mb-1"><strong>Date:</strong> ${formatDateWithDay(session.date)}</p>
                    <p><strong>Venue:</strong> ${esc(session.location)}</p>
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
    } else if (error.code === '23505') {
        // Unique violation (only if the database has a unique player/session
        // constraint): someone else added this player a moment ago.
        Swal.fire({ title: 'Already Registered', text: `${player.name} is already on the list for this session!`, icon: 'warning', confirmButtonColor: '#2563eb', customClass: { popup: 'rounded-3xl' } });
        if (onComplete) await onComplete();
    } else {
        // Previously a failed insert showed nothing at all.
        console.error('Join failed:', error.message);
        Swal.fire({ title: 'Could not join', text: 'Something went wrong adding you to the session. Please try again.', icon: 'error', confirmButtonColor: '#2563eb', customClass: { popup: 'rounded-3xl' } });
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
    if (!session) return;

    // Count confirmed players live. state.allData can be stale if the page has
    // been open for a while, which could let a promote overfill the session.
    let confirmedNow = session.players.length;
    const { count, error: countError } = await _supabase
        .from('registrations')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sid)
        .eq('status', 'Confirmed');
    if (!countError && count !== null) confirmedNow = count;
    const spotsLeft = session.capacity - confirmedNow;

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
        const reg = findRegistration(sid, regId);
        await logAction('PLAYER_PROMOTED', `${state.adminName} promoted ${name} to confirmed list`, name, sid, reg ? reg.player_id : null);
        Swal.fire({
            toast: true, position: 'top', icon: 'success',
            title: `${name} promoted!`, showConfirmButton: false, timer: 2000
        });
        if (onComplete) await onComplete();
    } else {
        console.error('Promote failed:', error.message);
        Swal.fire('Error', 'Could not promote that player. Please try again.', 'error');
    }
}
