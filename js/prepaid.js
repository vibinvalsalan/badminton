// js/prepaid.js
// Helpers for using prepaid pay-ins (player_payments / payment_registrations)
// when many registrations are marked Paid at once (Bulk Mark Paid).
//
// Everything here fails soft: if the pay-in tables can't be read (e.g. the
// migration hasn't been run), loadPrepaidPools returns an empty map and bulk
// marking behaves exactly as it did before prepaid existed.

import { _supabase } from './supabase-client.js';

// Map of playerId (string) -> that player's pay-ins that still have sessions
// left, oldest first: [{ paymentId, total, used, remaining }].
export async function loadPrepaidPools(playerIds) {
    const pools = new Map();
    if (!playerIds || playerIds.length === 0) return pools;

    const { data, error } = await _supabase
        .from('player_payments')
        .select('id, player_id, sessions_purchased, payment_registrations(id)')
        .in('player_id', playerIds)
        .order('paid_on', { ascending: true })
        .order('created_at', { ascending: true });
    if (error || !data) return pools;

    data.forEach(p => {
        const used = (p.payment_registrations || []).length;
        if (used >= p.sessions_purchased) return; // used up
        const key = String(p.player_id);
        if (!pools.has(key)) pools.set(key, []);
        pools.get(key).push({
            paymentId: p.id,
            total: p.sessions_purchased,
            used,
            remaining: p.sessions_purchased - used
        });
    });
    return pools;
}

// entries: [{ registrationId, playerId, sortKey, ...anything else }]
// sortKey must sort chronologically (e.g. "2026-11-01|19:00").
// Returns the entries sorted by sortKey, each with paymentId (or null),
// plus sequence/total ("session 3 of 10") when a pay-in covers it.
// A player's earliest sessions use their oldest pay-in first; once a player's
// prepaid sessions run out, their later sessions get paymentId null.
// Pure: does not modify `entries` or `pools`.
export function allocatePrepaid(entries, pools) {
    const work = new Map();
    pools.forEach((slots, key) => work.set(key, slots.map(s => ({ ...s }))));

    return [...entries]
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
        .map(e => {
            const slots = work.get(String(e.playerId));
            const slot = slots && slots.find(s => s.remaining > 0);
            if (!slot) return { ...e, paymentId: null };
            slot.remaining--;
            slot.used++;
            return { ...e, paymentId: slot.paymentId, sequence: slot.used, total: slot.total };
        });
}

// Marks every planned registration Paid, linking the ones that use prepaid.
// Safe order: links first (one all-or-nothing insert), then the status update,
// and if the status update fails the new links are removed again, so a failure
// never leaves a session consumed from a pay-in without being marked Paid.
// Returns { ok: true, linked } or { ok: false, message }.
export async function bulkMarkPaid(plan, usePrepaid, adminName) {
    const toLink = usePrepaid ? plan.filter(e => e.paymentId) : [];
    let linkIds = [];

    if (toLink.length > 0) {
        const { data, error } = await _supabase
            .from('payment_registrations')
            .insert(toLink.map(e => ({
                payment_id: e.paymentId,
                registration_id: e.registrationId,
                linked_by: adminName
            })))
            .select('id');
        if (error) {
            return { ok: false, message: `Could not use prepaid sessions, so nothing was changed: ${error.message}` };
        }
        linkIds = (data || []).map(r => r.id);
    }

    const { error: updateError } = await _supabase
        .from('registrations')
        .update({ payment_status: 'Paid' })
        .in('id', plan.map(e => e.registrationId));

    if (updateError) {
        if (linkIds.length > 0) {
            await _supabase.from('payment_registrations').delete().in('id', linkIds);
        }
        return { ok: false, message: `Bulk update failed: ${updateError.message}` };
    }

    return { ok: true, linked: toLink.length };
}

// ---------------------------------------------------------------------------
// Forfeited credits: a player paid ahead, then no-showed or dropped out.
// The session stays "used" and is tied to the attendance infraction record.
// Needs migration-link-infractions-to-prepaid.sql.
// ---------------------------------------------------------------------------

// The prepaid credit a player used for a session, whether or not their
// registration still exists. Returns the link row (with its pay-in's amount and
// size) or null if they didn't use prepaid for that session.
export async function findCreditForSession(playerId, sessionId) {
    if (!playerId || !sessionId) return null;
    const { data, error } = await _supabase
        .from('payment_registrations')
        .select('id, payment_id, registration_id, infraction_id, forfeited_at, player_payments(player_id, amount, sessions_purchased)')
        .eq('session_id', sessionId);
    if (error || !data) return null;
    return data.find(r => r.player_payments && String(r.player_payments.player_id) === String(playerId)) || null;
}

// Ties an existing infraction record to a credit (the session stays used).
export async function linkInfractionToCredit(linkId, infractionId) {
    const { error } = await _supabase
        .from('payment_registrations')
        .update({ infraction_id: infractionId })
        .eq('id', linkId);
    return !error;
}

// A No Show / Drop Out already logged for this player and session, if any, so
// we attach to it instead of creating a duplicate.
async function findExistingInfraction(playerId, sessionId) {
    const { data, error } = await _supabase
        .from('attendance_infractions')
        .select('id, infraction_type')
        .eq('player_id', Number(playerId))
        .eq('session_id', sessionId)
        .in('infraction_type', ['No Show', 'Drop Out']);
    return (!error && data && data[0]) || null;
}

// Removes a prepaid player from a session but keeps their credit USED:
//   1. log (or reuse) the infraction,
//   2. detach the credit from the registration and mark it forfeited,
//   3. delete the registration (the detached credit is not touched by this).
// If any step fails, the earlier steps are undone, so nothing is left half-done.
// `link` is the credit's link row (needs `id`). Returns { ok, ... } or { ok: false, message }.
export async function forfeitAndRemove({ link, regId, playerId, sessionId, infractionType, reason }) {
    let infractionId;
    let created = false;

    const existing = await findExistingInfraction(playerId, sessionId);
    if (existing) {
        infractionId = existing.id;
    } else {
        const { data, error } = await _supabase
            .from('attendance_infractions')
            .insert([{
                player_id: Number(playerId),
                session_id: sessionId,
                infraction_type: infractionType,
                reason: reason || 'Prepaid session kept as used when removed by admin.',
                time_of_reporting: new Date().toISOString()
            }])
            .select('id')
            .single();
        if (error || !data) return { ok: false, message: 'Could not log the infraction, so nothing was changed.' };
        infractionId = data.id;
        created = true;
    }
    const undoInfraction = async () => {
        if (created) await _supabase.from('attendance_infractions').delete().eq('id', infractionId);
    };

    const { error: detachError } = await _supabase
        .from('payment_registrations')
        .update({ registration_id: null, forfeited_at: new Date().toISOString(), infraction_id: infractionId })
        .eq('id', link.id);
    if (detachError) {
        await undoInfraction();
        return { ok: false, message: 'Could not keep the prepaid session as used, so nothing was changed.' };
    }

    const { error: deleteError } = await _supabase.from('registrations').delete().eq('id', regId);
    if (deleteError) {
        await _supabase
            .from('payment_registrations')
            .update({ registration_id: regId, forfeited_at: null, infraction_id: null })
            .eq('id', link.id);
        await undoInfraction();
        return { ok: false, message: 'Could not remove the player, so nothing was changed.' };
    }

    return { ok: true, infractionId, createdInfraction: created };
}
