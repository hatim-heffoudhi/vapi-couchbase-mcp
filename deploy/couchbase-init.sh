#!/usr/bin/env bash
set -euo pipefail

CB_HOST="${CB_HOST:-couchbase}"
CB_USERNAME="${CB_USERNAME:-Administrator}"
CB_PASSWORD="${CB_PASSWORD:?Set CB_PASSWORD}"
CUSTOMER_NAME="${CUSTOMER_NAME:-Hatim Heffoudhi}"
CUSTOMER_EMAIL="${DEMO_CUSTOMER_EMAIL:-hatim@hatim.com}"
BUCKET="order-demo"
SCOPE="_default"
MGMT="http://${CB_HOST}:8091"
QUERY="http://${CB_HOST}:8093"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

echo "Waiting for Couchbase at ${MGMT}..."
for _ in $(seq 1 90); do
  if curl -sf "${MGMT}/ui/index.html" >/dev/null; then
    break
  fi
  sleep 2
done
curl -sf "${MGMT}/ui/index.html" >/dev/null

auth_ok() {
  curl -sf -u "${CB_USERNAME}:${CB_PASSWORD}" "${MGMT}/pools/default" >/dev/null
}

if auth_ok; then
  echo "Cluster already initialized."
else
  echo "Initializing cluster..."
  curl -sf -X POST "${MGMT}/pools/default" \
    -d memoryQuota=768 \
    -d indexMemoryQuota=256 \
    >/dev/null
  curl -sf -X POST "${MGMT}/node/controller/setupServices" \
    -d services=kv%2Cn1ql%2Cindex \
    >/dev/null
  curl -sf -X POST "${MGMT}/settings/web" \
    -d port=8091 \
    -d username="${CB_USERNAME}" \
    -d password="${CB_PASSWORD}" \
    >/dev/null
  curl -sf -u "${CB_USERNAME}:${CB_PASSWORD}" -X POST "${MGMT}/settings/indexes" \
    -d storageMode=plasma \
    >/dev/null || true
fi

if ! curl -sf -u "${CB_USERNAME}:${CB_PASSWORD}" "${MGMT}/pools/default/buckets/${BUCKET}" >/dev/null; then
  echo "Creating bucket ${BUCKET}..."
  curl -sf -u "${CB_USERNAME}:${CB_PASSWORD}" \
    -X POST "${MGMT}/pools/default/buckets" \
    -d name="${BUCKET}" \
    -d bucketType=couchbase \
    -d ramQuotaMB=256 \
    -d flushEnabled=1 \
    >/dev/null
fi

create_collection() {
  curl -sS -u "${CB_USERNAME}:${CB_PASSWORD}" \
    -X POST "${MGMT}/pools/default/buckets/${BUCKET}/scopes/${SCOPE}/collections" \
    -d "name=$1" \
    | grep -qiE 'already exists|success|"uid"' || true
}

create_collection orders
create_collection products
create_collection delivery_changes
create_collection order_otps

echo "Waiting for query service..."
for _ in $(seq 1 60); do
  if curl -sf "${QUERY}/admin/ping" >/dev/null; then
    break
  fi
  sleep 2
done

n1ql() {
  local statement="$1"
  local i
  for i in $(seq 1 15); do
    if curl -sf -u "${CB_USERNAME}:${CB_PASSWORD}" \
      "${QUERY}/query/service" \
      --data-urlencode "statement=${statement}" \
      >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "N1QL failed." >&2
  return 1
}

KS="\`${BUCKET}\`.\`${SCOPE}\`"
echo "Creating indexes and seeding orders..."
n1ql "CREATE PRIMARY INDEX IF NOT EXISTS ON ${KS}.\`orders\`"
n1ql "CREATE INDEX IF NOT EXISTS idx_orders_order_id ON ${KS}.\`orders\`(order_id)"
n1ql "CREATE PRIMARY INDEX IF NOT EXISTS ON ${KS}.\`delivery_changes\`"
n1ql "CREATE PRIMARY INDEX IF NOT EXISTS ON ${KS}.\`order_otps\`"
n1ql "CREATE PRIMARY INDEX IF NOT EXISTS ON ${KS}.\`products\`"

NAME_JSON=$(json_escape "$CUSTOMER_NAME")
EMAIL_JSON=$(json_escape "$CUSTOMER_EMAIL")

n1ql "DELETE FROM ${KS}.\`orders\` o WHERE o.order_id NOT IN [\"ORD-1001\", \"ORD-1002\", \"ORD-1003\"]" || true
n1ql "DELETE FROM ${KS}.\`delivery_changes\` d" || true
n1ql "DELETE FROM ${KS}.\`order_otps\` o" || true

n1ql "UPSERT INTO ${KS}.\`orders\` (KEY, VALUE) VALUES (\"order-1001\", {
  \"order_id\": \"ORD-1001\",
  \"status\": \"processing\",
  \"items\": [{\"name\": \"wireless headphones\", \"quantity\": 1, \"price\": 79.99}],
  \"total\": 79.99,
  \"estimated_delivery\": \"2026-10-02\",
  \"customer\": \"${NAME_JSON}\",
  \"customer_email\": \"${EMAIL_JSON}\",
  \"created_at\": \"2026-09-20T10:00:00.000Z\"
})"

n1ql "UPSERT INTO ${KS}.\`orders\` (KEY, VALUE) VALUES (\"order-1002\", {
  \"order_id\": \"ORD-1002\",
  \"status\": \"shipped\",
  \"items\": [{\"name\": \"canvas sneakers\", \"quantity\": 2, \"price\": 54.50}],
  \"total\": 109.00,
  \"estimated_delivery\": \"2026-10-01\",
  \"customer\": \"${NAME_JSON}\",
  \"customer_email\": \"${EMAIL_JSON}\",
  \"created_at\": \"2026-09-20T10:01:00.000Z\"
})"

n1ql "UPSERT INTO ${KS}.\`orders\` (KEY, VALUE) VALUES (\"order-1003\", {
  \"order_id\": \"ORD-1003\",
  \"status\": \"delivered\",
  \"items\": [{\"name\": \"ceramic mug\", \"quantity\": 4, \"price\": 12.00}],
  \"total\": 48.00,
  \"estimated_delivery\": \"2026-09-18\",
  \"customer\": \"${NAME_JSON}\",
  \"customer_email\": \"${EMAIL_JSON}\",
  \"created_at\": \"2026-09-20T10:02:00.000Z\"
})"

n1ql "UPDATE ${KS}.\`orders\` o SET o.customer = \"${NAME_JSON}\", o.customer_email = \"${EMAIL_JSON}\""
n1ql "UPDATE ${KS}.\`orders\` o USE KEYS \"order-1001\" SET o.created_at = DATE_ADD_STR(NOW_STR(), -7, \"day\")"
n1ql "UPDATE ${KS}.\`orders\` o USE KEYS \"order-1002\" SET o.created_at = DATE_ADD_STR(NOW_STR(), -7, \"day\")"
n1ql "UPDATE ${KS}.\`orders\` o USE KEYS \"order-1003\" SET o.created_at = DATE_ADD_STR(NOW_STR(), -7, \"day\")"
n1ql "UPDATE ${KS}.\`delivery_changes\` d SET d.customer_email = \"${EMAIL_JSON}\"" || true

curl -sf -X DELETE "${MAILPIT_URL:-http://mailpit:8025}/api/v1/messages" >/dev/null || true

echo "order-demo bucket is ready with collections orders, products, delivery_changes, order_otps."
echo "SQL++: SELECT * FROM \`order-demo\`.\`_default\`.\`orders\` WHERE order_id = 'ORD-1001';"
