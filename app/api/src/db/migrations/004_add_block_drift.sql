-- Add block_drift column to lnd_node_info table
-- Note: If column already exists (from updated 001 migration), this will error
-- but the migration system should handle it gracefully
ALTER TABLE lnd_node_info ADD COLUMN block_drift INTEGER;

-- Add block_drift column to lnd_node_info_history table
ALTER TABLE lnd_node_info_history ADD COLUMN block_drift INTEGER;
