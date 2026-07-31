-- Immutable completed-operation response for exact replay of newly written receipts.
-- Nullable preserves pre-ledger receipts, which retain their documented legacy behavior.
ALTER TABLE "MutationReceipt"
ADD COLUMN "outcomeSnapshot" JSONB;

-- A receipt becomes a durable replay ledger entry when it has an outcome snapshot.
-- Legacy rows retain a SQL NULL snapshot and are deliberately outside this guard.
CREATE FUNCTION "prevent_completed_mutation_receipt_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."outcomeSnapshot" IS NOT NULL THEN
        RAISE EXCEPTION 'completed_mutation_receipt_immutable'
            USING ERRCODE = '55000';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "MutationReceipt_prevent_completed_mutation"
BEFORE UPDATE OR DELETE ON "MutationReceipt"
FOR EACH ROW
EXECUTE FUNCTION "prevent_completed_mutation_receipt_mutation"();
