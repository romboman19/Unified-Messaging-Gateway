-- 0.3.0 read the GoIP SMS Server's recv_time as Kyiv time, but the deployed
-- server stamps UTC, so inbound SMS were dated 2 h (3 h before 25 Oct, summer
-- time) before they arrived. Inbound rows are never updated after insert, so
-- updated_at still holds the arrival time; put created_at back to it for the
-- rows that carry exactly that shift.

UPDATE "messages" m
SET "created_at" = m."updated_at"
FROM "transport_accounts" a
WHERE m."account_id" = a."id"
  AND a."adapter" = 'goip-vendor'
  AND m."direction" = 'inbound'
  AND m."updated_at" - m."created_at" BETWEEN interval '1 hour 55 minutes' AND interval '3 hours 5 minutes';

-- Re-sort the SMS threads those rows belong to; other channels are untouched.
UPDATE "conversations" c
SET "last_message_at" = sub."latest"
FROM (
  SELECT m."conversation_id", max(m."created_at") AS "latest"
  FROM "messages" m
  JOIN "transport_accounts" a ON a."id" = m."account_id"
  WHERE m."conversation_id" IS NOT NULL
    AND a."adapter" = 'goip-vendor'
  GROUP BY m."conversation_id"
) sub
WHERE c."id" = sub."conversation_id"
  AND (c."last_message_at" IS NULL OR c."last_message_at" < sub."latest");
