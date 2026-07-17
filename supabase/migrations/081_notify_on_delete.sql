-- =============================================================================
-- HomeGuru PMS — migration 081
-- Notify SUPER_ADMIN whenever staff soft-delete ("Sil") a record.
-- =============================================================================
-- Every "Sil" in the app routes through soft_delete_entity (migration 021),
-- which snapshots the row into trash_entries and records WHAT (entity_type +
-- entity_label), WHO (deleted_by) and WHEN (deleted_at). So an AFTER INSERT
-- trigger on trash_entries is the single, complete hook for delete-oversight.
--
-- Behaviour:
--   * Recipients: SUPER_ADMIN (admins want to know what staff remove).
--   * Skips deletes performed BY a SUPER_ADMIN — an admin doesn't need a push
--     about their own (or another admin's) cleanup; this targets "personel".
--   * event_type 'entity_deleted' is NOT in notification_preferences, so it
--     can't be opted out — this is an always-on audit alert. send-push delivers
--     any event_type by default (opt-out model), so no Edge Function change.
--   * Reuses _send_push_async (migration 053) → fire-and-forget; if push isn't
--     configured (vault secrets missing) it's a harmless no-op and never blocks
--     the delete. If the surrounding delete txn rolls back, the queued push
--     rolls back with it.
-- =============================================================================

CREATE OR REPLACE FUNCTION _notify_entity_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_role text;
  actor_name text;
  type_label text;
  what       text;
BEGIN
  SELECT role, full_name INTO actor_role, actor_name
  FROM staff_profiles WHERE user_id = NEW.deleted_by;

  -- Don't ping admins about an admin's own deletes — only personel deletes.
  IF actor_role = 'SUPER_ADMIN' THEN
    RETURN NEW;
  END IF;

  -- WHAT — entity type → Turkish label (matches the Çöp Kutusu UI), plus the
  -- short human-readable label captured at delete time.
  type_label := CASE NEW.entity_type
    WHEN 'reservations'        THEN 'Rezervasyon'
    WHEN 'cash_transactions'   THEN 'Kasa hareketi'
    WHEN 'ledger_entries'      THEN 'Cari hareket'
    WHEN 'expenses'            THEN 'Gider'
    WHEN 'housekeeping_issues' THEN 'Sorun'
    WHEN 'message_templates'   THEN 'Şablon'
    WHEN 'staff_advances'      THEN 'Personel avansı'
    WHEN 'units'               THEN 'Birim'
    ELSE NEW.entity_type
  END;
  what := type_label || COALESCE(' — ' || NEW.entity_label, '');

  PERFORM _send_push_async(
    ARRAY['SUPER_ADMIN']::text[],
    'Kayıt silindi',
    -- WHO · WHAT · WHEN (Istanbul-local)
    COALESCE(actor_name, 'Bir personel') || ' · ' || what || ' · '
      || to_char(NEW.deleted_at AT TIME ZONE 'Europe/Istanbul', 'DD Mon HH24:MI'),
    '/settings/trash',
    'system',
    'entity_deleted',
    jsonb_build_object(
      'trash_id', NEW.id,
      'entity_type', NEW.entity_type,
      'deleted_by', NEW.deleted_by
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trash_entries_notify ON trash_entries;
CREATE TRIGGER trash_entries_notify
  AFTER INSERT ON trash_entries
  FOR EACH ROW EXECUTE FUNCTION _notify_entity_deleted();
