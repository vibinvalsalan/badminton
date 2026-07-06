-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query)
-- Creates a new table for append-only, timestamped notes about a player
-- (special instructions, payment reminders, general comments, etc).
-- Each note is its own row so the full history is preserved and individual
-- entries can be deleted without affecting the rest.

CREATE TABLE IF NOT EXISTS public.player_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id bigint NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    note_text text NOT NULL,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_notes_player_id ON public.player_notes (player_id);

-- Row Level Security: matches the same open anon/authenticated pattern
-- already used by attendance_infractions and audit_logs in this project.
-- Access control here is enforced by the admin-only gate in the app's UI
-- (requireAdmin()), not by RLS — consistent with the rest of this schema.
ALTER TABLE public.player_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon and authenticated select" ON public.player_notes
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Allow anon and authenticated insert" ON public.player_notes
    FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "Allow anon and authenticated delete" ON public.player_notes
    FOR DELETE TO anon, authenticated USING (true);
