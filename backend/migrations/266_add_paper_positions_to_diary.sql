-- Journal + reconciliation integration: link closed paper positions to diary entries.
-- Additive, non-destructive. Follows the same pattern as migration 076
-- (linked_trades UUID[]).

ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS linked_paper_positions UUID[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_diary_entries_linked_paper_positions
  ON diary_entries USING GIN(linked_paper_positions);

COMMENT ON COLUMN diary_entries.linked_paper_positions IS 'Array of paper_positions IDs linked to this journal entry';
