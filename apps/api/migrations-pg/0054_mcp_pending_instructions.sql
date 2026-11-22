-- v3.4 MCPDIR (the MCPDIR security review, finding 1; the coordinator's decision: custom instructions changed through
-- MCP wait for the person's OK): the person's AI may ask to change the custom instructions (set_prepare_settings), but
-- the new text takes effect only once the person approves it in Settings › Integrations. Until then it waits here, and
-- every prompt keeps the approved text (custom_instructions). NULL: nothing waits. Approving moves the text into
-- custom_instructions; discarding clears both columns. The person's own edits in Settings take effect at once, as
-- before.
--
-- Additive: two nullable columns, no backfill, no index (read with the person's row).

ALTER TABLE mcp_settings
  ADD COLUMN pending_custom_instructions text CHECK (char_length(pending_custom_instructions) <= 4000),
  ADD COLUMN pending_at timestamptz;
