-- Add membership_status column to lnd_node_info table
ALTER TABLE lnd_node_info ADD COLUMN membership_status TEXT DEFAULT 'unsynced';

-- Add membership_status column to lnd_node_info_history table
ALTER TABLE lnd_node_info_history ADD COLUMN membership_status TEXT DEFAULT 'unsynced';
