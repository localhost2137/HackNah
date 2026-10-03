-- Consolidate the privileged role without removing existing accounts.
UPDATE member SET role = 'admin' WHERE role = 'owner';
UPDATE invitation SET role = 'admin' WHERE role = 'owner';
