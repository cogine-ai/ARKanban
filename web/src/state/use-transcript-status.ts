import { useCallback, useEffect, useState } from "react";
import { collectorApi, type TranscriptArchiveStatus } from "../api";
import { useCollector } from "./collector-context";

/**
 * Backs the standing archive disclosure. Refetches on session change because
 * that is when the sync loop has most likely made progress.
 */
export function useTranscriptStatus(): { status?: TranscriptArchiveStatus; error?: string } {
  const { subscribeTopics } = useCollector();
  const [status, setStatus] = useState<TranscriptArchiveStatus>();
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      setStatus(await collectorApi.transcriptStatus());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    return subscribeTopics(["sessions"], () => void reload());
  }, [reload, subscribeTopics]);

  return { status, error };
}
