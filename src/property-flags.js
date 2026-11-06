// Green "New" list badge. Derived at read time. Nothing is written back onto the property.
// Shown only for a record added in the last 7 days, after the CRM's initial load hour,
// that is still status New, has no last-contacted date, and has no logged call.
// A logged call is any kind='call' row (every supported outcome, including no answer,
// voicemail, and wrong number) or an import row that recorded Talked/Called.
// Notes do not clear it. Sync cannot turn it back on without deleting those activities.
const IS_NEW_SQL = `(
  p.created_at > now() - interval '7 days'
  AND p.created_at > (SELECT min(created_at) + interval '1 hour' FROM properties)
  AND p.status = 'New'
  AND p.last_contacted IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM activities a
    WHERE a.property_id = p.id
      AND (
        a.kind = 'call'
        OR (a.kind = 'import' AND a.outcome IN ('Talked', 'Called'))
      )
  )
)`;

module.exports = { IS_NEW_SQL };
