import { useCallback, useEffect, useRef, useState } from "react";
import { collectorApi, type TranscriptArchiveStatus } from "../api";
import { useCollector } from "./collector-context";

/**
 * Backs the standing archive disclosure. Capacity and failed sync rounds can
 * change without a message or session invalidation, so visible pages also poll.
 */
export function useTranscriptStatus(): { status?: TranscriptArchiveStatus; error?: string; reload: () => Promise<void> } {
  const { subscribeTopics, status: collector, live } = useCollector();
  const gatewayConnected = collector?.gateway.connected;
  const hostId = collector?.host.id;
  const pageStream = live.state;
  const [status, setStatus] = useState<TranscriptArchiveStatus>();
  const [error, setError] = useState<string>();

  // This panel is the standing disclosure that a machine holds conversation
  // text, so an out-of-order answer is worse here than elsewhere: it would state
  // a stored size, or a retention window, that is no longer true.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const reload = useCallback(async () => {
    const requested = (generation.current += 1);
    inFlight.current = true;
    try {
      const next = await collectorApi.transcriptStatus();
      if (requested !== generation.current) return;
      setStatus(next);
      setError(undefined);
    } catch (cause) {
      if (requested !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requested === generation.current) inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeTopics(["sessions", "messages"], () => void reload());
    const readWhenVisible = () => {
      if (document.visibilityState !== "hidden") void reload();
    };
    // A slow read must be allowed to finish rather than being superseded by
    // every poll. Manual retries and source changes can still replace it.
    const timer = window.setInterval(() => {
      if (!inFlight.current) readWhenVisible();
    }, 15_000);
    window.addEventListener("focus", readWhenVisible);
    document.addEventListener("visibilitychange", readWhenVisible);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", readWhenVisible);
      document.removeEventListener("visibilitychange", readWhenVisible);
      generation.current += 1;
      inFlight.current = false;
    };
  }, [reload, subscribeTopics, gatewayConnected, hostId, pageStream]);

  return { status, error, reload };
}
