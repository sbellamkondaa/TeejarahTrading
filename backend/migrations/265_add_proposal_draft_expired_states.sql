-- Add DRAFT and EXPIRED proposal lifecycle states.
-- Additive, non-destructive: only widens the CHECK constraint.
-- DRAFT allows pre-approval proposal scaffolding; EXPIRED allows
-- time-bound proposals to age out of the approval queue.
-- No existing rows are affected — current states remain valid.

ALTER TABLE trade_proposals
  DROP CONSTRAINT IF EXISTS trade_proposals_state_chk;

ALTER TABLE trade_proposals
  ADD CONSTRAINT trade_proposals_state_chk CHECK (lifecycle_state IN (
    'DRAFT',
    'SIGNAL_DETECTED', 'SIGNAL_VALIDATING', 'READY_FOR_APPROVAL',
    'APPROVED', 'REJECTED', 'WATCH', 'EXPIRED',
    'ENTRY_SUBMITTED', 'ENTRY_PARTIALLY_FILLED', 'ENTRY_FILLED',
    'ENTRY_CANCELLED', 'POSITION_ACTIVE', 'T1_FILLED', 'T2_FILLED',
    'STOP_FILLED', 'POSITION_CLOSED', 'ERROR', 'MANUAL_INTERVENTION_REQUIRED'
  ));
