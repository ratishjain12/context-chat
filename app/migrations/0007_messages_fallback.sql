-- model = the model that actually answered; requested_model = what the user
-- picked. They differ when the fallback chain kicked in (fallback_reason says why).
ALTER TABLE messages ADD COLUMN requested_model TEXT;
ALTER TABLE messages ADD COLUMN fallback_reason TEXT;
