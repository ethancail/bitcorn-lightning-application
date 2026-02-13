ALTER TABLE lnd_node_info
ADD COLUMN node_role TEXT DEFAULT 'external';

ALTER TABLE lnd_node_info_history
ADD COLUMN node_role TEXT DEFAULT 'external';
