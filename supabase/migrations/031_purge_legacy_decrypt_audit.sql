-- =============================================================================
-- HomeGuru PMS — migration 031
-- Purge the legacy DECRYPT audit rows.
-- =============================================================================
-- Before migration 030, every TC/passport decryption logged a contextless row
-- (action='DECRYPT', entity_type='sensitive_field', entity_id=NULL). Those rows
-- carry no information — no guest, no actionable detail — and just clutter the
-- Denetim Kaydı page. From 030 onward we log meaningful GUEST_DECRYPT rows
-- instead, so the old ones can be safely removed.

DELETE FROM audit_log
WHERE action = 'DECRYPT'
  AND entity_type = 'sensitive_field';
