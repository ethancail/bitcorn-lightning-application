-- Add has_treasury_channel column to lnd_node_info table
ALTER TABLE lnd_node_info ADD COLUMN has_treasury_channel INTEGER DEFAULT 0;

-- Add has_treasury_channel column to lnd_node_info_history table
ALTER TABLE lnd_node_info_history ADD COLUMN has_treasury_channel INTEGER DEFAULT 0;
