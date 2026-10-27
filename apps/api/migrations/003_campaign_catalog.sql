ALTER TABLE participations DROP CONSTRAINT IF EXISTS participations_campaign_id_check;
ALTER TABLE participations ADD CONSTRAINT participations_campaign_id_check
  CHECK (length(campaign_id) BETWEEN 1 AND 64 AND campaign_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
