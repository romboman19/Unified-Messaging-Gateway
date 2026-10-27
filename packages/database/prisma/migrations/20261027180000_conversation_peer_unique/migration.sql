-- Threads were split three ways, and this repairs the rows those bugs left:
--   1. inbound numbers in national format (0671112233) were stored as
--      +3800671112233;
--   2. outbound recipients typed without a country code became +0671112233;
--   3. concurrent find-then-create opened duplicate threads for one peer.
-- After fixing 1 and 2, every (endpoint, number) group is folded into its
-- oldest conversation, and a unique index stops 3 from happening again.

UPDATE "conversations"
SET "peer_phone_e164" = '+380' || substring("peer_phone_e164" FROM 6)
WHERE "peer_phone_e164" ~ '^\+3800[0-9]{9}$';

UPDATE "conversations"
SET "peer_phone_e164" = '+380' || substring("peer_phone_e164" FROM 3)
WHERE "peer_phone_e164" ~ '^\+0[0-9]{9}$';

CREATE TEMP TABLE "conversation_merge" AS
SELECT "id", first_value("id") OVER w AS "keep_id"
FROM "conversations"
WHERE "peer_phone_e164" IS NOT NULL
WINDOW w AS (PARTITION BY "endpoint_id", "peer_phone_e164" ORDER BY "created_at", "id");

DELETE FROM "conversation_merge" WHERE "id" = "keep_id";

UPDATE "messages" m
SET "conversation_id" = cm."keep_id"
FROM "conversation_merge" cm
WHERE m."conversation_id" = cm."id";

UPDATE "conversations" c
SET "last_message_at" = sub."latest"
FROM (
  SELECT cm."keep_id", max(d."last_message_at") AS "latest"
  FROM "conversation_merge" cm
  JOIN "conversations" d ON d."id" = cm."id"
  GROUP BY cm."keep_id"
) sub
WHERE c."id" = sub."keep_id"
  AND (c."last_message_at" IS NULL OR c."last_message_at" < sub."latest");

DELETE FROM "conversations" c
USING "conversation_merge" cm
WHERE c."id" = cm."id";

DROP TABLE "conversation_merge";

-- CreateIndex
CREATE UNIQUE INDEX "conversations_endpoint_id_peer_phone_e164_key" ON "conversations"("endpoint_id", "peer_phone_e164");
