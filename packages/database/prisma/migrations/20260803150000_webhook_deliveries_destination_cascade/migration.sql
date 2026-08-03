-- Deleting a Destination that has any delivery history (e.g. after using
-- the "Test" button) previously failed: webhook_deliveries.destination_id
-- was ON DELETE RESTRICT, so Postgres rejected the delete with a foreign
-- key violation. The API had no handler for it, so the error surfaced as
-- an unhandled 500 and the delete UI silently did nothing.
--
-- Delivery rows only record delivery attempts for a destination; once the
-- destination itself is gone, its delivery history is no longer actionable,
-- so cascade it (mirrors routing_rule_destinations, which already cascades
-- on destination delete).
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_destination_id_fkey";
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
