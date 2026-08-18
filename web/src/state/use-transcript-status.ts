import { useCallback, useEffect, useRef, useState } from "react";
import { collectorApi, type TranscriptArchiveStatus } from "../api";
import { useCollector } from "./collector-context";

/**
 * Backs the standing archive disclosure. Refetches when the archive grows or a
 * session changes, which is when the sync loop has made progress.
 */
export function useTranscriptStatus(): { status?: TranscriptArchiveStatus; error?: string } {
  const { subscribeTopics } = useCollector();
  const [status, setStatus] = useState<TranscriptArchiveStatus>();
  const [error, setError] = useState<string>();

  // This panel is the standing disclosure that a machine holds conversation
  // text, so an out-of-order answer is worse here than elsewhere: it would state
  // a stored size, or a retention window, that is no longer true.
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const requested = (generation.current += 1);
    try {
      const next = await collectorApi.transcriptStatus();
      if (requested !== generation.current) return;
      setStatus(next);
      setError(undefined);
    } catch (cause) {
      if (requested !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    return subscribeTopics(["sessions", "messages"], () => void reload());
  }, [reload, subscribeTopics]);

  return { status, error };
}
